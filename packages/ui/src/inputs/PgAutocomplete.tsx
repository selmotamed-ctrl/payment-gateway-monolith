import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from "vue";
import { dc } from "../lib/dc";
import { usePgUiConfig } from "../lib/config";
import {
  controlSize,
  normalizeOptions,
  type NormalizeAccessors,
  type PgOption,
} from "../lib/options";
import { runRules, visibleError } from "../lib/rules";
import { isBrowser, useClickOutside, useEscape } from "../lib/dom";
import { PgFieldShell } from "./PgFieldShell";
import { PgIcon } from "../actions/PgIcon";

export type { PgOption };

const FILTER_KEYS = ["label", "subtitle", "value"];

/**
 * A true 2026 combobox: searchable, multi-select with removable chips,
 * creatable, keyboard navigable, teleported and viewport-aware. There is no
 * native `<select>` anywhere in the design system.
 */
export const PgAutocomplete = dc(
  (props: Record<string, any>, _expose, { attrs, emit, slots }) => {
    const config = usePgUiConfig();
    const uid = useId();
    const listboxId = `pg-ac-list-${uid}`;
    const triggerRef = ref<HTMLElement | null>(null);
    const panelRef = ref<HTMLElement | null>(null);
    const inputRef = ref<HTMLInputElement | null>(null);
    const open = ref(false);
    const query = ref("");
    const activeIndex = ref(0);
    const panelStyle = ref<Record<string, string>>({});
    const localError = ref("");

    const accessors = computed<NormalizeAccessors>(() => ({
      itemTitle: props.itemTitle,
      itemValue: props.itemValue,
      itemSubtitle: props.itemSubtitle,
      itemIcon: props.itemIcon,
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
      if (multiple.value)
        return Array.isArray(props.modelValue) ? props.modelValue : [];
      return props.modelValue === null ||
        props.modelValue === undefined ||
        props.modelValue === ""
        ? []
        : [props.modelValue];
    });
    const selectedOptions = computed<PgOption[]>(() =>
      selectedValues.value.map(
        (value) =>
          options.value.find(
            (option) => String(option.value) === String(value),
          ) ?? {
            value,
            label: String(value),
          },
      ),
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
      selectedValues.value.some((entry) => String(entry) === String(value));
    const maxVisibleChips = computed(() => Number(props.maxVisibleChips ?? 3));
    const overflowCount = computed(() =>
      Math.max(0, selectedOptions.value.length - maxVisibleChips.value),
    );

    const updatePosition = () => {
      if (!isBrowser) return;
      const element = triggerRef.value;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const flipUp = spaceBelow < 280 && rect.top > spaceBelow;
      panelStyle.value = {
        position: "fixed",
        left: `${Math.max(8, rect.left)}px`,
        width: `${Math.max(rect.width, 220)}px`,
        top: flipUp ? "auto" : `${rect.bottom + 6}px`,
        bottom: flipUp ? `${window.innerHeight - rect.top + 6}px` : "auto",
        zIndex: "var(--pg-z-popover)",
      };
    };

    const openPanel = async () => {
      if (props.disabled || props.readonly) return;
      open.value = true;
      activeIndex.value = Math.max(
        0,
        filtered.value.findIndex((option) => isSelected(option.value)),
      );
      await nextTick();
      updatePosition();
      if (searchable.value) inputRef.value?.focus();
    };
    const closePanel = () => {
      open.value = false;
      query.value = "";
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
          ? selectedValues.value.filter(
              (value) => String(value) !== String(option.value),
            )
          : [...selectedValues.value, option.value];
        emit?.("update:modelValue", next);
        validate(next);
        query.value = "";
        inputRef.value?.focus();
      } else {
        emit?.("update:modelValue", option.value);
        emit?.("change", option.value);
        validate(option.value);
        closePanel();
      }
    };
    const removeChip = (value: any) => {
      if (props.disabled) return;
      if (multiple.value) {
        const next = selectedValues.value.filter(
          (entry) => String(entry) !== String(value),
        );
        emit?.("update:modelValue", next);
        validate(next);
      } else {
        emit?.("update:modelValue", null);
      }
    };
    const clear = () => {
      emit?.("update:modelValue", multiple.value ? [] : null);
      emit?.("clear");
      query.value = "";
      validate(multiple.value ? [] : null);
    };
    const commitTyped = () => {
      if (!query.value.trim()) return;
      const exact = options.value.find(
        (option) =>
          option.label.toLowerCase() === query.value.trim().toLowerCase(),
      );
      if (exact) selectOption(exact);
      else if (props.creatable || props.allowCustom)
        selectOption({ value: query.value.trim(), label: query.value.trim() });
    };
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (!open.value) void openPanel();
        else
          activeIndex.value = Math.min(
            activeIndex.value + 1,
            Math.max(filtered.value.length - 1, 0),
          );
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        activeIndex.value = Math.max(activeIndex.value - 1, 0);
      } else if (event.key === "Enter") {
        if (!open.value) {
          void openPanel();
          return;
        }
        event.preventDefault();
        const highlighted = filtered.value[activeIndex.value];
        if (highlighted) selectOption(highlighted);
        else commitTyped();
      } else if (event.key === "Escape") {
        event.preventDefault();
        closePanel();
      } else if (
        event.key === "Backspace" &&
        !query.value &&
        multiple.value &&
        selectedValues.value.length
      ) {
        removeChip(selectedValues.value[selectedValues.value.length - 1]);
      } else if (event.key === "Tab") {
        if (open.value && query.value) commitTyped();
        closePanel();
      }
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
    useClickOutside([triggerRef, panelRef], closePanel, open);
    useEscape(closePanel, open);
    onBeforeUnmount(() => {
      if (!isBrowser) return;
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    });

    return () => {
      const shownValue = open.value
        ? query.value
        : !multiple.value && selectedOptions.value[0]
          ? selectedOptions.value[0].label
          : "";
      return (
        <PgFieldShell
          label={props.label}
          hint={props.hint}
          error={error.value}
          required={props.required}
          disabled={props.disabled}
          hideDetails={props.hideDetails}
        >
          <div
            ref={triggerRef}
            class={[
              "pg-control-box pg-ac-trigger",
              `pg-control-box--${size.value}`,
              open.value ? "pg-control-box--focused" : "",
              error.value ? "pg-control-box--error" : "",
              props.disabled ? "pg-control-box--disabled" : "",
            ]}
            role="combobox"
            aria-expanded={open.value ? "true" : "false"}
            aria-controls={listboxId}
            aria-haspopup="listbox"
            onClick={() =>
              open.value ? inputRef.value?.focus() : void openPanel()
            }
          >
            {(props.prependInnerIcon || slots["prepend-inner"]) && (
              <span
                class="pg-control-adornment pg-control-adornment--start"
                onClick={
                  props["onClick:prependInner"] ?? props["onClick:prepend"]
                }
                role={
                  props["onClick:prependInner"] || props["onClick:prepend"]
                    ? "button"
                    : undefined
                }
              >
                {slots["prepend-inner"]?.() ?? (
                  <PgIcon icon={props.prependInnerIcon} size={17} />
                )}
              </span>
            )}
            {multiple.value && (
              <div class="pg-ac-values">
                {selectedOptions.value
                  .slice(0, maxVisibleChips.value)
                  .map((chip) => (
                    <span key={String(chip.value)} class="pg-ac-chip">
                      <span class="pg-ac-chip__label">{chip.label}</span>
                      {!props.disabled && (
                        <button
                          type="button"
                          class="pg-ac-chip__remove"
                          aria-label={`Remove ${chip.label}`}
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
                  <span class="pg-ac-chip pg-ac-chip--overflow">
                    +{overflowCount.value}
                  </span>
                )}
              </div>
            )}
            <input
              ref={inputRef}
              id={props.id}
              class="pg-control-native pg-ac-input"
              type="text"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={open.value ? "true" : "false"}
              aria-controls={listboxId}
              readonly={!searchable.value}
              disabled={props.disabled}
              value={shownValue}
              placeholder={
                selectedOptions.value.length === 0
                  ? (props.placeholder ?? "Search or select…")
                  : ""
              }
              onFocus={() => !open.value && void openPanel()}
              onInput={(event: Event) => {
                query.value = (event.target as HTMLInputElement).value;
                activeIndex.value = 0;
                emit?.("search", query.value);
              }}
              onKeydown={onKeydown}
            />
            {props.clearable &&
              selectedValues.value.length > 0 &&
              !props.disabled && (
                <button
                  type="button"
                  class="pg-control-clear-btn"
                  aria-label="Clear selection"
                  onClick={(event: MouseEvent) => {
                    event.stopPropagation();
                    clear();
                  }}
                >
                  <PgIcon icon="mdi-close-circle" size={16} />
                </button>
              )}
            {(props.appendInnerIcon || slots["append-inner"]) && (
              <span
                class="pg-control-adornment pg-control-adornment--end"
                onClick={
                  props["onClick:appendInner"] ?? props["onClick:append"]
                }
                role={
                  props["onClick:appendInner"] || props["onClick:append"]
                    ? "button"
                    : undefined
                }
              >
                {slots["append-inner"]?.() ?? (
                  <PgIcon icon={props.appendInnerIcon} size={17} />
                )}
              </span>
            )}
            <span
              class={["pg-ac-chevron", open.value ? "pg-ac-chevron--open" : ""]}
            >
              <PgIcon
                icon={props.loading ? "mdi-loading" : "mdi-chevron-down"}
                size={18}
              />
            </span>
          </div>

          {open.value && (
            <div
              ref={panelRef}
              id={listboxId}
              role="listbox"
              aria-multiselectable={multiple.value ? "true" : "false"}
              class="pg-popover-panel pg-ac-panel"
              style={panelStyle.value}
            >
              {props.loading ? (
                <div class="pg-ac-empty">Loading options…</div>
              ) : filtered.value.length === 0 ? (
                <div class="pg-ac-empty">
                  {query.value.trim() &&
                  (props.creatable || props.allowCustom) ? (
                    <button
                      type="button"
                      class="pg-ac-create-btn"
                      onClick={commitTyped}
                    >
                      Create “{query.value.trim()}”
                    </button>
                  ) : (
                    (props.noResultsText ?? "No matching options")
                  )}
                </div>
              ) : (
                filtered.value.map((option, index) => {
                  const checked = isSelected(option.value);
                  return (
                    <button
                      key={`${String(option.value)}-${index}`}
                      type="button"
                      role="option"
                      aria-selected={checked ? "true" : "false"}
                      disabled={option.disabled}
                      class={[
                        "pg-ac-option",
                        index === activeIndex.value
                          ? "pg-ac-option--active"
                          : "",
                        checked ? "pg-ac-option--selected" : "",
                      ]}
                      onMouseenter={() => (activeIndex.value = index)}
                      onClick={() => selectOption(option)}
                    >
                      {multiple.value && (
                        <span
                          class={[
                            "pg-ac-option-check",
                            checked ? "pg-ac-option-check--on" : "",
                          ]}
                        >
                          {checked && <PgIcon icon="mdi-check" size={12} />}
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
                      {!multiple.value && checked && (
                        <PgIcon
                          icon="mdi-check"
                          size={16}
                          class="pg-ac-option-tick"
                        />
                      )}
                    </button>
                  );
                })
              )}
            </div>
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
      placeholder: { type: String, default: "Search or select…" },
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
      noResultsText: { type: String, default: "No matching options" },
      itemTitle: { type: [String, Function], default: undefined },
      itemValue: { type: [String, Function], default: undefined },
      itemSubtitle: { type: [String, Function], default: undefined },
      itemIcon: { type: [String, Function], default: undefined },
      prependInnerIcon: { type: String, default: "" },
      appendInnerIcon: { type: String, default: "" },
      rules: {
        type: Array as () => Array<(value: any) => any>,
        default: () => [],
      },
      hideDetails: { type: Boolean, default: false },
      id: { type: String, default: "" },
    },
    emits: ["update:modelValue", "search", "change", "clear"],

    inheritAttrs: true,
  },
);

export const VSelect = PgAutocomplete;
export const VAutocomplete = PgAutocomplete;
export const VCombobox = PgAutocomplete;
