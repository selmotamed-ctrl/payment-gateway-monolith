import { createIf } from "@vue/runtime-vapor";

/** The Vapor JSX return type is a Block at runtime; the public type is narrower. */
const branch = createIf as any;
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from "vue";
import { dc } from "../lib/dc";
import {
  controlSize,
  normalizeOptions,
  type NormalizeAccessors,
  type PgOption,
} from "../lib/options";
import { runRules, visibleError } from "../lib/rules";
import { isBrowser, useClickOutside, useEscape } from "../lib/dom";
import { useLocale } from "../lib/locale";
import { PgFieldShell } from "./PgFieldShell";
import { PgIcon } from "../actions/PgIcon";
import { PgSpinner } from "../actions/PgFeedbackAtoms";

export type { PgOption };

const FILTER_KEYS = ["label", "subtitle"] as const;

const same = (a: any, b: any) => String(a) === String(b);

/**
 * 2026 combobox: searchable single/multi select, creatable, fully keyboard
 * navigable and viewport-aware. The panel is a `position: fixed` Vapor
 * `createIf` block (never a VDOM Teleport) so it can never be clipped by a
 * scrolled card or dialog. There is no native `<select>` anywhere.
 */
export const PgAutocomplete = dc(
  (props: Record<string, any>, expose, { attrs, emit }) => {
    const { t } = useLocale();
    const uid = useId();
    const fieldId = props.id || `pg-ac-${uid}`;
    const listboxId = `pg-ac-list-${uid}`;
    const triggerRef = ref<HTMLElement | null>(null);
    const panelRef = ref<HTMLElement | null>(null);
    const inputRef = ref<HTMLInputElement | null>(null);
    const open = ref(false);
    const query = ref("");
    const activeIndex = ref(0);
    const panelStyle = ref<Record<string, string>>({});
    const localError = ref("");
    /** Optimistic value so an uncontrolled caller still sees its click. */
    const valueState = ref<any>(props.multiple ? [] : null);

    watch(
      () => props.modelValue,
      (next) => {
        if (props.multiple && Array.isArray(next) && Array.isArray(valueState.value)) {
          const current = valueState.value;
          if (next.length === current.length && next.every((entry: any, index: number) => same(entry, current[index]))) return;
        }
        valueState.value = next;
      },
      { immediate: true, deep: true },
    );

    const accessors = computed<NormalizeAccessors>(() => ({
      itemTitle: props.itemTitle,
      itemValue: props.itemValue,
      itemSubtitle: props.itemSubtitle,
      itemIcon: props.itemIcon,
      itemDisabled: props.itemDisabled,
    }));
    const options = computed<PgOption[]>(() =>
      normalizeOptions(props.items, accessors.value),
    );
    const searchable = computed(() => props.searchable !== false);
    const multiple = computed(() => Boolean(props.multiple));
    const size = computed(() =>
      controlSize({ ...props, density: props.density ?? attrs.density }),
    );
    const error = computed(() =>
      visibleError({ ...props, ...attrs }, localError.value),
    );

    const selectedValues = computed<any[]>(() => {
      const current = valueState.value;
      if (multiple.value)
        return Array.isArray(current) ? current : [];
      return current === null || current === undefined || current === ""
        ? []
        : [current];
    });
    const labelForValue = (value: any): string | null => {
      const source = props.valueLabels;
      if (typeof source === "function") {
        try {
          const label = source(value);
          if (label !== null && label !== undefined && label !== "") {
            return String(label);
          }
        } catch {
          /* a broken label adapter must not break the control */
        }
      } else if (source && typeof source === "object") {
        const label = source[String(value)];
        if (label !== null && label !== undefined && label !== "") {
          return String(label);
        }
      }
      return null;
    };
    const selectedOptions = computed<PgOption[]>(() =>
      selectedValues.value.map(
        (value) =>
          options.value.find((option) => same(option.value, value)) ?? {
            value,
            label: labelForValue(value) ?? String(value),
          },
      ),
    );
    const selectedValueList = computed(() =>
      selectedValues.value.map((value) => String(value)),
    );
    const filtered = computed(() => {
      const term = query.value.trim().toLowerCase();
      if (!term) return options.value;
      return options.value.filter((option) =>
        FILTER_KEYS.some((key) =>
          String((option as any)[key] ?? "")
            .toLowerCase()
            .includes(term),
        ),
      );
    });
    const isSelected = (value: any) =>
      selectedValues.value.some((entry) => same(entry, value));
    const maxVisibleChips = computed(() => Number(props.maxVisibleChips ?? 3));
    const overflowCount = computed(() =>
      Math.max(0, selectedOptions.value.length - maxVisibleChips.value),
    );
    const exactQueryOption = computed(() =>
      options.value.find(
        (option) =>
          option.label.trim().toLowerCase() === query.value.trim().toLowerCase(),
      ),
    );
    const showCreateRow = computed(
      () =>
        Boolean(query.value.trim()) &&
        Boolean(props.creatable || props.allowCustom) &&
        !exactQueryOption.value,
    );
    const noResultsText = computed(() => {
      const term = query.value.trim();
      if (term)
        return String(props.noResultsText || t("No matches for \"{query}\"")).replace(
          "{query}",
          term,
        );
      return String(props.noResultsText || t("No matching options"));
    });
    const activeDescendant = computed(() => {
      if (
        !open.value ||
        !filtered.value.length ||
        !filtered.value[activeIndex.value]
      )
        return undefined;
      return `pg-ac-opt-${uid}-${activeIndex.value}`;
    });
    watch(filtered, (list) => {
      if (activeIndex.value >= list.length) {
        activeIndex.value = Math.max(0, list.length - 1);
      }
    });
    const shownValue = computed(() =>
      open.value
        ? query.value
        : !multiple.value && selectedOptions.value[0]
          ? selectedOptions.value[0].label
          : "",
    );
    // Vapor does not always patch the live `value` of a readonly input, so keep
    // the DOM property in lock-step for programmatic selections and clears.
    watch(shownValue, (next) => {
      const input = inputRef.value;
      if (input && input.value !== next) input.value = next;
    });

    const updatePosition = () => {
      if (!isBrowser) return;
      const element = triggerRef.value;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      // 300px is the panel's max height: flip above when it would not fit.
      const flipUp = spaceBelow < 300 && rect.top > spaceBelow;
      const panelWidth = Math.min(Math.max(rect.width, 240), window.innerWidth - 16);
      panelStyle.value = {
        position: "fixed",
        left: `${Math.max(8, Math.min(rect.left, window.innerWidth - panelWidth - 8))}px`,
        minWidth: `${panelWidth}px`,
        maxWidth: "calc(100vw - 16px)",
        top: flipUp ? "auto" : `${rect.bottom + 6}px`,
        bottom: flipUp ? `${window.innerHeight - rect.top + 6}px` : "auto",
        zIndex: "var(--pg-z-popover)",
      };
    };

    const focusTrigger = () => {
      if (inputRef.value) inputRef.value.focus();
      else triggerRef.value?.focus?.();
    };

    const scrollActiveIntoView = () => {
      nextTick(() => {
        const node = panelRef.value?.querySelector<HTMLElement>(
          `[data-index="${activeIndex.value}"]`,
        );
        if (node && typeof node.scrollIntoView === "function") {
          node.scrollIntoView({ block: "nearest" });
        }
      });
    };

    const setActive = (index: number) => {
      activeIndex.value = index;
      scrollActiveIntoView();
    };

    const openPanel = async () => {
      if (props.disabled || props.readonly) return;
      if (open.value) {
        focusTrigger();
        return;
      }
      open.value = true;
      const selectedIndex = filtered.value.findIndex((option) =>
        isSelected(option.value),
      );
      activeIndex.value = selectedIndex >= 0 ? selectedIndex : 0;
      emit?.("open");
      await nextTick();
      updatePosition();
      focusTrigger();
    };

    const closePanel = (focus = false) => {
      if (!open.value) return;
      open.value = false;
      query.value = "";
      emit?.("close");
      if (focus) focusTrigger();
    };

    const validate = (next: any) => {
      localError.value = props.rules
        ? runRules({ ...props, ...attrs }, next)
        : "";
    };

    const selectOption = (option: PgOption) => {
      if (option.disabled) return;
      if (multiple.value) {
        const next = isSelected(option.value)
          ? selectedValues.value.filter((value) => !same(value, option.value))
          : [...selectedValues.value, option.value];
        valueState.value = next;
        emit?.("update:modelValue", next);
        emit?.("change", next);
        emit?.("select", option.raw ?? option);
        validate(next);
        query.value = "";
        focusTrigger();
        return;
      }
      valueState.value = option.value;
      emit?.("update:modelValue", option.value);
      emit?.("change", option.value);
      emit?.("select", option.raw ?? option);
      validate(option.value);
      closePanel();
    };

    const removeChip = (value: any) => {
      if (props.disabled || props.readonly) return;
      if (multiple.value) {
        const next = selectedValues.value.filter((entry) => !same(entry, value));
        valueState.value = next;
        emit?.("update:modelValue", next);
        emit?.("change", next);
        validate(next);
        focusTrigger();
      } else {
        valueState.value = null;
        emit?.("update:modelValue", null);
        validate(null);
      }
    };

    const clear = () => {
      if (props.disabled) return;
      const next = multiple.value ? [] : null;
      valueState.value = next;
      emit?.("update:modelValue", next);
      emit?.("clear");
      query.value = "";
      validate(next);
      focusTrigger();
    };

    const commitTyped = () => {
      const term = query.value.trim();
      if (!term) return;
      if (exactQueryOption.value) {
        selectOption(exactQueryOption.value);
        return;
      }
      if (!(props.creatable || props.allowCustom)) return;
      selectOption({ value: term, label: term });
    };

    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (!open.value) {
          void openPanel();
          return;
        }
        if (!filtered.value.length) return;
        setActive((activeIndex.value + 1) % filtered.value.length);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        if (!open.value) {
          void openPanel();
          return;
        }
        if (!filtered.value.length) return;
        setActive(
          (activeIndex.value - 1 + filtered.value.length) %
            filtered.value.length,
        );
      } else if (event.key === "Home" && open.value) {
        event.preventDefault();
        setActive(0);
      } else if (event.key === "End" && open.value) {
        event.preventDefault();
        setActive(Math.max(0, filtered.value.length - 1));
      } else if (event.key === "Enter") {
        if (!open.value) {
          event.preventDefault();
          void openPanel();
          return;
        }
        event.preventDefault();
        const highlighted = filtered.value[activeIndex.value];
        if (highlighted) selectOption(highlighted);
        else commitTyped();
      } else if (event.key === "Escape") {
        if (!open.value) return;
        event.preventDefault();
        event.stopPropagation();
        closePanel(true);
      } else if (
        event.key === "Backspace" &&
        !query.value &&
        multiple.value &&
        selectedValues.value.length
      ) {
        event.preventDefault();
        removeChip(selectedValues.value[selectedValues.value.length - 1]);
      } else if (event.key === "Tab") {
        if (open.value && query.value) commitTyped();
        closePanel();
      }
    };

    const onOptionMousedown = (event: MouseEvent) => {
      // Keep focus inside the search input and keep the panel open for
      // multi-select toggles (the browser must not blur on mousedown).
      event.preventDefault();
      event.stopPropagation();
    };

    watch(open, (value) => {
      if (!isBrowser) return;
      if (value) {
        window.addEventListener("resize", updatePosition);
        window.addEventListener("scroll", updatePosition, true);
      } else {
        window.removeEventListener("resize", updatePosition);
        window.removeEventListener("scroll", updatePosition, true);
      }
    });
    useClickOutside([triggerRef, panelRef], () => closePanel(), open);
    useEscape(() => closePanel(true), open);
    onBeforeUnmount(() => {
      if (!isBrowser) return;
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    });

    expose?.({
      focus: focusTrigger,
      open: () => void openPanel(),
      close: () => closePanel(),
      clear,
    });

    const renderChevron = () => {
      if (props.loading) {
        return (
          <span class="pg-ac-spinner" data-pg-ac-spinner>
            <PgSpinner size={14} label={t("Loading options")} />
          </span>
        );
      }
      return (
        <span
          class={["pg-ac-chevron", open.value ? "pg-ac-chevron--open" : ""]}
          aria-hidden="true"
        >
          <PgIcon icon="mdi-chevron-down" size={18} />
        </span>
      );
    };

    return () => {
      const placeholder =
        multiple.value && selectedOptions.value.length > 0
          ? ""
          : props.placeholder || t("Search or select…");
      return (
        <PgFieldShell
          forId={fieldId}
          label={props.label}
          hint={props.hint}
          error={error.value}
          required={props.required}
          disabled={props.disabled}
          hideDetails={props.hideDetails}
        >
          <div
            ref={triggerRef}
            data-pg-autocomplete
            class={[
              "pg-control-box",
              "pg-ac-trigger",
              `pg-control-box--${size.value}`,
              open.value ? "pg-control-box--focused" : "",
              error.value ? "pg-control-box--error" : "",
              props.disabled ? "pg-control-box--disabled" : "",
              props.readonly ? "pg-ac-trigger--readonly" : "",
              attrs.class,
            ]
              .filter(Boolean)
              .join(" ")}
            style={attrs.style}
            aria-disabled={props.disabled ? "true" : undefined}
            aria-readonly={props.readonly ? "true" : undefined}
            onClick={() => {
              if (open.value) inputRef.value?.focus();
              else void openPanel();
            }}
          >
            {(props.prependInnerIcon || attrs.prependInnerIcon || attrs["prepend-inner"]) && (
              <span
                class="pg-control-adornment pg-control-adornment--start"
                onClick={
                  props["onClick:prependInner"] ??
                  props["onClick:prepend"] ??
                  attrs["onClick:prependInner"] ??
                  attrs["onClick:prepend"]
                }
                role={
                  props["onClick:prependInner"] ||
                  props["onClick:prepend"] ||
                  attrs["onClick:prependInner"] ||
                  attrs["onClick:prepend"]
                    ? "button"
                    : undefined
                }
              >
                <PgIcon
                  icon={props.prependInnerIcon ?? attrs.prependInnerIcon}
                  size={17}
                />
              </span>
            )}
            {multiple.value && selectedOptions.value.length > 0 && (
              <div class="pg-ac-values">
                {selectedOptions.value
                  .slice(0, maxVisibleChips.value)
                  .map((chip) => (
                    <span key={String(chip.value)} class="pg-ac-chip" title={chip.label}>
                      <span class="pg-ac-chip__label">{chip.label}</span>
                      {!props.disabled && !props.readonly && (
                        <button
                          type="button"
                          class="pg-ac-chip__remove"
                          aria-label={`${t("Remove")} ${chip.label}`}
                          onMousedown={(event: MouseEvent) => {
                            event.preventDefault();
                            event.stopPropagation();
                          }}
                          onClick={(event: MouseEvent) => {
                            event.stopPropagation();
                            removeChip(chip.value);
                          }}
                        >
                          <PgIcon icon="mdi-close" size={12} />
                        </button>
                      )}
                    </span>
                  ))}
                {overflowCount.value > 0 && (
                  <span
                    class="pg-ac-chip pg-ac-chip--overflow"
                    title={selectedOptions.value
                      .slice(maxVisibleChips.value)
                      .map((option) => option.label)
                      .join(", ")}
                  >
                    +{overflowCount.value}
                  </span>
                )}
              </div>
            )}
            <input
              ref={inputRef}
              id={fieldId}
              class="pg-control-native pg-ac-input"
              type="text"
              role="combobox"
              autocomplete="off"
              aria-autocomplete="list"
              aria-expanded={open.value ? "true" : "false"}
              aria-controls={listboxId}
              aria-activedescendant={activeDescendant.value}
              aria-label={attrs["aria-label"] ?? props["aria-label"]}
              aria-invalid={error.value ? "true" : undefined}
              aria-required={props.required ? "true" : undefined}
              readonly={!searchable.value || props.readonly}
              disabled={props.disabled}
              value={shownValue.value}
              placeholder={placeholder}
              onFocus={() => !open.value && void openPanel()}
              onInput={(event: Event) => {
                query.value = (event.target as HTMLInputElement).value;
                activeIndex.value = 0;
                emit?.("search", query.value);
              }}
              onKeydown={onKeydown}
            />
            {props.clearable &&
              !props.disabled &&
              !props.readonly &&
              selectedValues.value.length > 0 && (
                <button
                  type="button"
                  class="pg-control-clear-btn"
                  aria-label={t("Clear selection")}
                  onMousedown={(event: MouseEvent) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onClick={(event: MouseEvent) => {
                    event.stopPropagation();
                    clear();
                  }}
                >
                  <PgIcon icon="mdi-close-circle" size={16} />
                </button>
              )}
            {(props.appendInnerIcon || attrs.appendInnerIcon || attrs["append-inner"]) && (
              <span
                class="pg-control-adornment pg-control-adornment--end"
                onClick={
                  props["onClick:appendInner"] ??
                  props["onClick:append"] ??
                  attrs["onClick:appendInner"] ??
                  attrs["onClick:append"]
                }
                role={
                  props["onClick:appendInner"] ||
                  props["onClick:append"] ||
                  attrs["onClick:appendInner"] ||
                  attrs["onClick:append"]
                    ? "button"
                    : undefined
                }
              >
                <PgIcon
                  icon={props.appendInnerIcon ?? attrs.appendInnerIcon}
                  size={17}
                />
              </span>
            )}
            {renderChevron()}
          </div>

          {branch(
            () => open.value,
            () => (
              <div
                ref={panelRef}
                id={listboxId}
                role="listbox"
                aria-multiselectable={multiple.value ? "true" : "false"}
                data-pg-ac-panel
                class="pg-popover-panel pg-ac-panel"
                style={panelStyle.value}
              >
                {filtered.value.map((option, index) => {
                  return (
                    <button
                      key={`${String(option.value)}-${index}`}
                      id={`pg-ac-opt-${uid}-${index}`}
                      data-index={index}
                      data-value={String(option.value)}
                      type="button"
                      role="option"
                      tabindex={-1}
                      aria-selected={isSelected(option.value) ? "true" : "false"}
                      disabled={option.disabled}
                      class={[
                        "pg-ac-option",
                        index === activeIndex.value
                          ? "pg-ac-option--active"
                          : "",
                        isSelected(option.value) ? "pg-ac-option--selected" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      onMousedown={onOptionMousedown}
                      onClick={(event: MouseEvent) => {
                        event.preventDefault();
                        event.stopPropagation();
                        selectOption(option);
                      }}
                    >
                      {multiple.value && (
                        <span
                          class={[
                            "pg-ac-option-check",
                            isSelected(option.value) ? "pg-ac-option-check--on" : "",
                          ]}
                          aria-hidden="true"
                        >
                          {isSelected(option.value) && <PgIcon icon="mdi-check" size={12} />}
                        </span>
                      )}
                      {option.icon && <PgIcon icon={option.icon} size={16} />}
                      <span class="pg-ac-option-text">
                        <span class="pg-ac-option-label">{option.label}</span>
                        {option.subtitle && (
                          <span class="pg-ac-option-sub">
                            {option.subtitle}
                          </span>
                        )}
                      </span>
                      {option.badge && (
                        <span class="pg-ac-option-badge">{option.badge}</span>
                      )}
                      {!multiple.value && isSelected(option.value) && (
                        <PgIcon
                          icon="mdi-check"
                          size={16}
                          class="pg-ac-option-tick"
                        />
                      )}
                    </button>
                  );
                })}

                {showCreateRow.value && (
                  <button
                    type="button"
                    class="pg-ac-create-btn pg-ac-create-row"
                    role="option"
                    tabindex={-1}
                    aria-selected="false"
                    onMousedown={onOptionMousedown}
                    onClick={(event: MouseEvent) => {
                      event.preventDefault();
                      event.stopPropagation();
                      commitTyped();
                    }}
                  >
                    <PgIcon icon="mdi-plus" size={14} />
                    <span>
                      {t("Create")} “{query.value.trim()}”
                    </span>
                  </button>
                )}

                {!filtered.value.length &&
                  !showCreateRow.value &&
                  !props.serverError && (
                    <div class="pg-ac-empty" role="status">
                      {noResultsText.value}
                    </div>
                  )}

                {props.serverError && (
                  <div class="pg-ac-error" role="alert">
                    <PgIcon icon="mdi-alert-circle-outline" size={14} />
                    <span class="pg-ac-error__message">{props.serverError}</span>
                    <button
                      type="button"
                      class="pg-ac-error__retry"
                      onClick={(event: MouseEvent) => {
                        event.stopPropagation();
                        emit?.("retry");
                      }}
                    >
                      {t("Retry")}
                    </button>
                  </div>
                )}

                {props.hasMore && (
                  <button
                    type="button"
                    class="pg-ac-load-more"
                    onClick={(event: MouseEvent) => {
                      event.stopPropagation();
                      emit?.("loadMore");
                    }}
                  >
                    <PgIcon icon="mdi-chevron-down" size={14} />
                    <span>{props.loadMoreText ?? t("Load more")}</span>
                  </button>
                )}
              </div>
            ),
          )}
        </PgFieldShell>
      );
    };
  },
  {
    props: {
      modelValue: { type: [String, Number, Array, Object], default: null },
      items: { type: Array as () => any[], default: () => [] },
      label: { type: String, default: "" },
      placeholder: { type: String, default: "" },
      hint: { type: String, default: "" },
      error: { type: String, default: "" },
      errorMessages: { type: [Array, String], default: undefined },
      multiple: { type: Boolean, default: false },
      searchable: { type: Boolean, default: true },
      creatable: { type: Boolean, default: false },
      allowCustom: { type: Boolean, default: false },
      clearable: { type: Boolean, default: true },
      loading: { type: Boolean, default: false },
      disabled: { type: Boolean, default: false },
      readonly: { type: Boolean, default: false },
      required: { type: Boolean, default: false },
      size: { type: String, default: "md" },
      density: { type: String, default: "" },
      maxVisibleChips: { type: Number, default: 3 },
      noResultsText: { type: String, default: "" },
      itemTitle: { type: [String, Function], default: undefined },
      itemValue: { type: [String, Function], default: undefined },
      itemSubtitle: { type: [String, Function], default: undefined },
      itemIcon: { type: [String, Function], default: undefined },
      itemDisabled: { type: [String, Function], default: undefined },
      valueLabels: { type: [Object, Function], default: undefined },
      prependInnerIcon: { type: String, default: "" },
      appendInnerIcon: { type: String, default: "" },
      serverError: { type: String, default: "" },
      hasMore: { type: Boolean, default: false },
      loadMoreText: { type: String, default: "" },
      rules: {
        type: Array as () => Array<(value: any) => any>,
        default: () => [],
      },
      hideDetails: { type: Boolean, default: false },
      id: { type: String, default: "" },
    },
    emits: [
      "update:modelValue",
      "search",
      "change",
      "clear",
      "select",
      "open",
      "close",
      "loadMore",
      "retry",
    ],

    inheritAttrs: true,
  },
);

export const VSelect = PgAutocomplete;
export const VAutocomplete = PgAutocomplete;
export const VCombobox = PgAutocomplete;
export const Autocomplete = PgAutocomplete;
