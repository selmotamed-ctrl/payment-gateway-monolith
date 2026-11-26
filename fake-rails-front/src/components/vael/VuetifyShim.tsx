/**
 * Vuetify-named compatibility layer backed by vael-ui.
 *
 * The application is migrated component by component. This module keeps the
 * existing JSX names (`<VBtn>`, `<VTextField>`, …) working while the rendered
 * implementation is vael-ui (Vapor). No Vuetify module is imported here.
 */
import { computed, onMounted, ref, useId } from "vue";
import { useRouter } from "vue-router";
import {
    Avatar,
    Button,
    Card,
    Checkbox,
    Chip,
    Combobox,
    DatePicker,
    Dialog,
    Field,
    FileUpload,
    Input,
    Loader,
    Menu,
    Message,
    Progress,
    Radio,
    RadioGroup,
    Select,
    Separator,
    Slider,
    Switch,
    Tag,
    Textarea,
    Tooltip,
} from "vael-ui/vapor";
import { dc } from "@/utils/dc";
import { AppIcon, type IconName } from "@/components/AppIcon";

type AnyAttrs = Record<string, any>;

const layoutDc = (setup: any) => dc(setup, { inheritAttrs: false });

const emitModel = (attrs: AnyAttrs, value: any) => {
    (attrs["onUpdate:modelValue"] as ((value: any) => void) | undefined)?.(value);
    (attrs["onUpdate:files"] as ((value: any) => void) | undefined)?.(value);
};

const sameValue = (a: any, b: any): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const normalizeSize = (size: any): "sm" | "md" | "lg" | undefined => {
    if (size === "x-small" || size === "small") return "sm";
    if (size === "large" || size === "x-large") return "lg";
    if (size === "default") return "md";
    return size === "sm" || size === "md" || size === "lg" ? size : undefined;
};

const controlSize = (attrs: AnyAttrs): "sm" | "md" | undefined => {
    const size = normalizeSize(attrs.density === "compact" ? "sm" : attrs.size);
    return size === "lg" ? "md" : size;
};

const icon = (name: any): IconName | null =>
    typeof name === "string" && name.startsWith("mdi-") ? (name as IconName) : null;

const pick = (attrs: AnyAttrs, keys: string[]) => {
    const out: AnyAttrs = {};
    for (const key of keys) {
        if (attrs[key] !== undefined) out[key] = attrs[key];
    }
    return out;
};

const runRules = (attrs: AnyAttrs, value: any): string => {
    const rules = Array.isArray(attrs.rules) ? attrs.rules : attrs.rules ? [attrs.rules] : [];
    for (const rule of rules) {
        if (typeof rule !== "function") continue;
        const result = rule(value);
        if (typeof result === "string" && result.length > 0) return result;
    }
    const messages = attrs.errorMessages;
    if (Array.isArray(messages) && messages.length > 0) return String(messages[0]);
    if (typeof attrs.error === "string" && attrs.error) return attrs.error;
    return "";
};

const fieldError = (attrs: AnyAttrs, local: string) =>
    local || (typeof attrs.error === "string" ? attrs.error : "");

const shownError = (attrs: AnyAttrs, local: string) =>
    attrs.hideDetails ? "" : fieldError(attrs, local);

const fieldWrap = (attrs: AnyAttrs, error: string, control: any) => {
    const label = attrs.label;
    const hint = attrs.hint;
    if (!label && !hint && !error) return control;
    return (
        <Field
            label={label}
            description={hint}
            error={shownError(attrs, error)}
            required={Boolean(attrs.required)}
            disabled={Boolean(attrs.disabled)}
        >
            {control}
        </Field>
    );
};

const TEXT_ATTRS = [
    "id",
    "name",
    "type",
    "placeholder",
    "disabled",
    "readonly",
    "autocomplete",
    "inputmode",
    "maxlength",
    "minlength",
    "min",
    "max",
    "step",
    "pattern",
    "autofocus",
    "onKeydown",
    "onKeyup",
    "onInput",
    "onBlur",
    "onFocus",
    "aria-label",
    "aria-describedby",
    "aria-invalid",
    "aria-required",
    "class",
    "style",
];

export const VBtn = dc((_p, _e, { attrs, slots }: any) => {
    const router = useRouter();
    const isIcon = Boolean(attrs.icon);
    const leading = icon(attrs.prependIcon);
    const trailing = icon(attrs.appendIcon);
    const variant =
        attrs.variant === "outlined"
            ? "outline"
            : attrs.variant === "text"
              ? "text"
              : attrs.variant === "plain"
                ? "ghost"
                : attrs.variant === "tonal"
                  ? "secondary"
                  : attrs.color === "error"
                    ? "danger"
                    : attrs.variant === "flat" || attrs.color === "primary"
                      ? "primary"
                      : attrs.variant
                        ? "secondary"
                        : "secondary";

    return () => {
        const content = () => {
            if (isIcon && typeof attrs.icon === "string") {
                return <AppIcon name={attrs.icon as IconName} size={attrs.size === "small" ? 18 : 20} />;
            }
            if (typeof attrs.label === "string") return attrs.label;
            return slots.default?.();
        };
        const target = typeof attrs.href === "string" && attrs.href
            ? attrs.href
            : attrs.to
              ? router.resolve(attrs.to).href
              : "";
        return (
            <Button
                {...pick(attrs, ["class", "style", "disabled", "loading", "block", "type", "onClick", "aria-label", "title"])}
                as={target ? "a" : undefined}
                {...{ href: target || undefined }}
                variant={variant as any}
                size={normalizeSize(attrs.size)}
                icon={isIcon}
                pill={Boolean(attrs.rounded)}
                v-slots={{
                    default: content,
                    ...(leading ? { leading: () => <AppIcon name={leading} size={18} /> } : {}),
                    ...(trailing ? { trailing: () => <AppIcon name={trailing} size={18} /> } : {}),
                }}
            />
        );
    };
});

export const VIcon = dc((_p, _e, { attrs }: any) => () => {
    const name = icon(attrs.icon ?? attrs.name);
    if (!name) return null;
    return (
        <AppIcon
            name={name}
            size={attrs.size ?? 20}
            color={attrs.color}
            label={attrs.label}
            directional={Boolean(attrs.directional)}
            class={attrs.class}
            style={attrs.style}
        />
    );
});

export const VIconDrag = VIcon;

export const VAlert = dc((_p, _e, { attrs, slots }: any) => () => {
    const variant =
        attrs.type === "error"
            ? "error"
            : attrs.type === "warning"
              ? "warning"
              : attrs.type === "success"
                ? "success"
                : "info";
    return (
        <Message
            variant={variant as any}
            appearance={attrs.variant === "text" ? "bare" : "default"}
            closable={Boolean(attrs.closable)}
            open={attrs.modelValue ?? true}
            onUpdate:open={(value: boolean) => emitModel(attrs, value)}
            title={attrs.title}
            ui={
                attrs.density === "compact" || attrs.prominent
                    ? {
                          root: {
                              style: {
                                  paddingBlock: attrs.density === "compact" ? "6px" : undefined,
                                  borderWidth: attrs.prominent ? "2px" : undefined,
                              },
                          },
                      }
                    : undefined
            }
        >
            {slots.default?.()}
        </Message>
    );
});

export const VTextField = dc((_p, _e, { attrs }: any) => {
    return () => (
        <input
            {...pick(attrs, TEXT_ATTRS)}
            class="pg-input v-field"
            value={attrs.modelValue ?? ""}
            onInput={(event: Event) => emitModel(attrs, (event.target as HTMLInputElement).value)}
        />
    );
});


export const VTextarea = dc((_p, _e, { attrs }: any) => {
    const localError = ref("");
    const value = () => (attrs.modelValue === undefined || attrs.modelValue === null ? "" : String(attrs.modelValue));
    const validate = (next = value()) => {
        localError.value = runRules(attrs, next);
    };
    return () => {
        const control = (
            <Textarea
                {...pick(attrs, TEXT_ATTRS)}
                modelValue={value()}
                onUpdate:modelValue={(next: string) => {
                    emitModel(attrs, next);
                    validate(next);
                }}
                onBlur={(event: FocusEvent) => {
                    attrs.onBlur?.(event);
                    validate();
                }}
                size={normalizeSize(attrs.density === "compact" ? "sm" : attrs.size)}
                invalid={Boolean(fieldError(attrs, localError.value))}
            />
        );
        return fieldWrap(attrs, localError.value, control);
    };
});

const normalizeItems = (attrs: AnyAttrs): Array<{ label: string; value: any }> => {
    const items = attrs.items;
    if (!Array.isArray(items)) return [];
    const read = (item: any, key: "itemValue" | "itemTitle", fallback: any) => {
        const accessor = attrs[key];
        if (typeof accessor === "function") return accessor(item);
        if (typeof accessor === "string") return item?.[accessor];
        return fallback;
    };
    return items.map((item: any) => {
        if (item && typeof item === "object") {
            const value = read(item, "itemValue", item.value ?? item.id ?? item);
            const label = read(item, "itemTitle", item.title ?? item.label ?? String(value));
            return { label: String(label), value };
        }
        return { label: String(item), value: item };
    });
};

export const VSelect = layoutDc((_p, _e, { attrs }: any) => {
    const localError = ref("");
    const items = computed(() => normalizeItems(attrs));
    const selected = computed(() => {
        const value = attrs.modelValue;
        const list = attrs.multiple ? (Array.isArray(value) ? value : []) : value == null ? [] : [value];
        return new Set(list.map((entry: any) => String(entry)));
    });
    return () => {
        const control = (
            <select
                class="pg-select v-field"
                aria-label={attrs["aria-label"]}
                multiple={Boolean(attrs.multiple)}
                disabled={Boolean(attrs.disabled)}
                name={attrs.name}
                onChange={(event: Event) => {
                    const select = event.target as HTMLSelectElement;
                    const picked = [...select.selectedOptions]
                        .map((option) => items.value[Number(option.value)]?.value)
                        .filter((value) => value !== undefined);
                    const next = attrs.multiple ? picked : (picked[0] ?? null);
                    if (sameValue(next, attrs.modelValue)) return;
                    emitModel(attrs, next);
                    localError.value = runRules(attrs, next);
                }}
            >
                {!attrs.multiple && <option value="">{attrs.placeholder ?? ""}</option>}
                {items.value.map((item, index) => (
                    <option key={`${item.value}-${index}`} value={index} selected={selected.value.has(String(item.value))}>
                        {item.label}
                    </option>
                ))}
            </select>
        );
        return fieldWrap(attrs, localError.value, control);
    };
});


export const VAutocomplete = layoutDc((_p, _e, { attrs }: any) => {
    const localError = ref("");
    const items = computed(() => normalizeItems(attrs));
    const selected = computed(() => {
        const value = attrs.modelValue;
        const list = attrs.multiple ? (Array.isArray(value) ? value : []) : value == null ? [] : [value];
        return new Set(list.map((entry: any) => String(entry)));
    });
    return () => {
        const control = (
            <select
                class="pg-select v-field"
                aria-label={attrs["aria-label"]}
                multiple={Boolean(attrs.multiple)}
                disabled={Boolean(attrs.disabled)}
                name={attrs.name}
                onChange={(event: Event) => {
                    const select = event.target as HTMLSelectElement;
                    const picked = [...select.selectedOptions]
                        .map((option) => items.value[Number(option.value)]?.value)
                        .filter((value) => value !== undefined);
                    const next = attrs.multiple ? picked : (picked[0] ?? null);
                    if (sameValue(next, attrs.modelValue)) return;
                    emitModel(attrs, next);
                    localError.value = runRules(attrs, next);
                }}
            >
                {!attrs.multiple && <option value="">{attrs.placeholder ?? ""}</option>}
                {items.value.map((item, index) => (
                    <option key={`${item.value}-${index}`} value={index} selected={selected.value.has(String(item.value))}>
                        {item.label}
                    </option>
                ))}
            </select>
        );
        return fieldWrap(attrs, localError.value, control);
    };
});

export const VCombobox = VAutocomplete;


export const VCheckbox = layoutDc((_p, _e, { attrs }: any) => {
    const localError = ref("");
    const id = useId();
    const inputId = attrs.id ?? `pg-checkbox-${id}`;
    const checked = () => {
        const value = attrs.modelValue;
        if (Array.isArray(value)) return value.includes(attrs.value);
        return Boolean(value);
    };
    return () => (
        <div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <input
                    id={inputId}
                    type="checkbox"
                    checked={checked()}
                    disabled={Boolean(attrs.disabled)}
                    aria-label={attrs["aria-label"] ?? attrs.label}
                    onChange={(event: Event) => {
                        const isChecked = (event.target as HTMLInputElement).checked;
                        let next: any = isChecked;
                        if (Array.isArray(attrs.modelValue)) {
                            const list = attrs.modelValue.filter((entry: any) => entry !== attrs.value);
                            next = isChecked ? [...list, attrs.value] : list;
                        }
                        emitModel(attrs, next);
                        localError.value = runRules(attrs, next);
                    }}
                    style={{ width: "16px", height: "16px", accentColor: "var(--pg-accent-interactive)" }}
                />
                {attrs.label && (
                    <label for={inputId} style={{ fontSize: "13px", color: "var(--pg-ink-primary)" }}>
                        {attrs.label}
                    </label>
                )}
            </div>
            {shownError(attrs, localError.value) && (
                <div class="pg-field-error">{shownError(attrs, localError.value)}</div>
            )}
        </div>
    );
});




export const VSwitch = dc((_p, _e, { attrs, slots }: any) => {
    const localError = ref("");
    return () => {
        const content = slots.default ? slots.default() : undefined;
        const control = content ? (
            <Switch
                modelValue={Boolean(attrs.modelValue)}
                onUpdate:modelValue={(next: boolean) => {
                    emitModel(attrs, next);
                    localError.value = runRules(attrs, next);
                }}
                disabled={Boolean(attrs.disabled)}
                invalid={Boolean(fieldError(attrs, localError.value))}
                size={controlSize(attrs)}
                name={attrs.name}
            >
                {content}
            </Switch>
        ) : (
            <Switch
                modelValue={Boolean(attrs.modelValue)}
                onUpdate:modelValue={(next: boolean) => {
                    emitModel(attrs, next);
                    localError.value = runRules(attrs, next);
                }}
                label={attrs.label}
                disabled={Boolean(attrs.disabled)}
                invalid={Boolean(fieldError(attrs, localError.value))}
                size={controlSize(attrs)}
                name={attrs.name}
            />
        );
        return (
            <div>
                {control}
                {shownError(attrs, localError.value) && (
                    <div class="pg-field-error">{shownError(attrs, localError.value)}</div>
                )}
            </div>
        );
    };
});


export const VRadioGroup = dc((_p, _e, { attrs, slots }: any) => () => (
    <RadioGroup
        modelValue={attrs.modelValue ?? null}
        onUpdate:modelValue={(next: any) => emitModel(attrs, next)}
        disabled={Boolean(attrs.disabled)}
        orientation={attrs.inline ? "horizontal" : "vertical"}
        name={attrs.name}
    >
        {slots.default?.()}
    </RadioGroup>
));

export const VRadio = dc((_p, _e, { attrs }: any) => () => (
    <Radio value={attrs.value} label={attrs.label} disabled={Boolean(attrs.disabled)} />
));

export const VSlider = dc((_p, _e, { attrs }: any) => () => (
    <Slider
        modelValue={attrs.modelValue ?? 0}
        onUpdate:modelValue={(next: any) => emitModel(attrs, next)}
        min={attrs.min ?? 0}
        max={attrs.max ?? 100}
        step={attrs.step ?? 1}
        disabled={Boolean(attrs.disabled)}
        name={attrs.name}
    />
));

export const VFileInput = dc((_p, _e, { attrs }: any) => {
    const localError = ref("");
    const files = computed<File[]>(() => {
        const value = attrs.modelValue;
        if (!value) return [];
        return Array.isArray(value) ? value : [value];
    });
    return () => {
        const control = (
            <FileUpload
                files={files.value}
                onUpdate:files={(next: File[]) => {
                    const value = attrs.multiple ? next : (next[0] ?? null);
                    emitModel(attrs, value);
                    localError.value = runRules(attrs, value);
                }}
                accept={attrs.accept}
                multiple={Boolean(attrs.multiple)}
                disabled={Boolean(attrs.disabled)}
                maxSize={attrs.maxSize}
                name={attrs.name}
                onReject={(rejection: any) => {
                    localError.value =
                        rejection?.reason === "maxSize"
                            ? "File is too large"
                            : rejection?.reason === "maxFiles"
                              ? "Too many files"
                              : "File type is not accepted";
                }}
            />
        );
        return fieldWrap(attrs, localError.value, control);
    };
});

export const VDateInput = dc((_p, _e, { attrs }: any) => {
    return () => (
        <input
            {...pick(attrs, TEXT_ATTRS)}
            class="pg-input v-field"
            type="date"
            value={attrs.modelValue ?? ""}
            min={attrs.min instanceof Date ? attrs.min.toISOString().slice(0, 10) : attrs.min}
            max={attrs.max instanceof Date ? attrs.max.toISOString().slice(0, 10) : attrs.max}
            onInput={(event: Event) => emitModel(attrs, (event.target as HTMLInputElement).value)}
        />
    );
});


export const VProgressCircular = dc((_p, _e, { attrs }: any) => () => {
    if (attrs.indeterminate || attrs.value === undefined || attrs.value === null) {
        return (
            <Loader
                size={attrs.size ? (typeof attrs.size === "number" ? `${attrs.size}px` : attrs.size) : "1.25rem"}
            />
        );
    }
    return (
        <Progress
            type="circle"
            value={Number(attrs.value)}
            max={Number(attrs.max ?? 100)}
            size={normalizeSize(attrs.size) === "sm" ? "sm" : "md"}
        />
    );
});

export const VProgressLinear = dc((_p, _e, { attrs }: any) => () => (
    <Progress
        type="line"
        value={attrs.indeterminate ? null : Number(attrs.value ?? 0)}
        max={Number(attrs.max ?? 100)}
        variant={attrs.color === "error" ? "danger" : attrs.color === "success" ? "success" : "primary"}
    />
));

export const VDivider = dc((_p, _e, { attrs }: any) => () => (
    <Separator orientation={attrs.vertical ? "vertical" : "horizontal"} />
));

export const VCard = layoutDc((_p, _e, { attrs, slots }: any) => () => (
    <Card {...pick(attrs, ["class", "style", "onClick"])}>{slots.default?.()}</Card>
));

export const VCardText = layoutDc((_p, _e, { attrs, slots }: any) => () => (
    <div {...pick(attrs, ["class", "style"])} class={["pg-card-text", attrs.class].filter(Boolean).join(" ")}>
        {slots.default?.()}
    </div>
));

export const VCardActions = layoutDc((_p, _e, { attrs, slots }: any) => () => (
    <div {...pick(attrs, ["class", "style"])} class={["pg-card-actions", attrs.class].filter(Boolean).join(" ")}>
        {slots.default?.()}
    </div>
));

export const VChip = dc((_p, _e, { attrs, slots }: any) => () => {
    const removable = Boolean(attrs.closable);
    if (removable) {
        return (
            <Chip
                label={attrs.label ?? String(attrs.text ?? "")}
                removable
                onRemove={() => attrs["onClick:close"]?.()}
                size={normalizeSize(attrs.size) === "sm" ? "sm" : "md"}
            >
                {slots.default?.()}
            </Chip>
        );
    }
    return <Tag>{slots.default?.() ?? attrs.label ?? attrs.text}</Tag>;
});

export const VAvatar = dc((_p, _e, { attrs, slots }: any) => () => (
    <Avatar size={attrs.size} src={attrs.image} name={attrs.name}>
        {slots.default?.()}
    </Avatar>
));

export const VTooltip = dc((_p, _e, { slots }: any) => () => (
    <span style={{ display: "inline-flex" }}>{slots.activator?.({ props: {} })}</span>
));


export const VMenu = dc((_p, _e, { attrs, slots }: any) => () => (
    <Menu
        {...(attrs.modelValue !== undefined
            ? { open: attrs.modelValue, "onUpdate:open": (value: boolean) => emitModel(attrs, value) }
            : {})}
        v-slots={{
            trigger: () => <span style={{ display: "inline-flex" }}>{slots.activator?.({ props: {} })}</span>,
            default: () => slots.default?.(),
        }}
    />
));

export const VDialog = dc((_p, _e, { attrs, slots }: any) => () => {
    const maxWidth = Number(attrs.maxWidth ?? 0);
    const size = maxWidth >= 700 ? "lg" : maxWidth >= 500 ? "md" : "sm";
    return (
        <Dialog
            open={Boolean(attrs.modelValue)}
            onUpdate:open={(value: boolean) => emitModel(attrs, value)}
            size={size as any}
            title={attrs.title}
            description={attrs.subtitle}
            showClose={!attrs.persistent}
            closeOnOverlay={!attrs.persistent}
            beforeClose={() => !attrs.persistent}
            ui={maxWidth ? { panel: { style: { maxWidth: `${maxWidth}px`, width: "100%" } } } : undefined}
            v-slots={{
                default: () => slots.default?.(),
                ...(slots.actions ? { footer: () => slots.actions?.() } : {}),
            }}
        />
    );
});

export const VForm = dc((_p, _e, { attrs, slots }: any) => {
    onMounted(() => emitModel(attrs, true));
    return () => (
        <form
            onSubmit={(event: Event) => {
                event.preventDefault();
                attrs.onSubmit?.(event);
            }}
            {...pick(attrs, ["class", "style"])}
        >
            {slots.default?.()}
        </form>
    );
});

export const VSnackbar = dc((_p, _e, { attrs, slots }: any) => () => {
    const variant =
        attrs.color === "error"
            ? "error"
            : attrs.color === "warning"
              ? "warning"
              : attrs.color === "success"
                ? "success"
                : "info";
    return (
        <div
            style={{
                position: "fixed",
                insetInline: "0",
                bottom: "24px",
                display: "flex",
                justifyContent: "center",
                zIndex: 3000,
                pointerEvents: "none",
            }}
        >
            <div style={{ width: "min(480px, calc(100vw - 32px))", pointerEvents: "auto" }}>
                <Message
                    variant={variant as any}
                    open={Boolean(attrs.modelValue)}
                    onUpdate:open={(value: boolean) => emitModel(attrs, value)}
                    closable={Boolean(attrs.closable)}
                >
                    {slots.default?.()}
                </Message>
            </div>
        </div>
    );
});

export const VApp = layoutDc((_p, _e, { attrs, slots }: any) => () => (
    <div
        {...pick(attrs, ["class", "style"])}
        class={[
            "pg-app",
            "v-application",
            typeof document !== "undefined" && document.documentElement.dataset.theme === "dark"
                ? "v-theme--dark"
                : "v-theme--light",
            attrs.class,
        ]
            .filter(Boolean)
            .join(" ")}
    >
        {slots.default?.()}
    </div>
));

export const VAppBar = layoutDc((_p, _e, { attrs, slots }: any) => () => (
    <header
        {...pick(attrs, ["class", "style"])}
        class={["pg-app-bar", attrs.class].filter(Boolean).join(" ")}
        style={[{ height: attrs.height ? `${attrs.height}px` : undefined }, attrs.style]}
    >
        {slots.default?.()}
    </header>
));

export const VAppBarTitle = layoutDc((_p, _e, { attrs, slots }: any) => () => (
    <div class={["pg-app-bar-title", attrs.class].filter(Boolean).join(" ")}>{slots.default?.()}</div>
));

export const VMain = layoutDc((_p, _e, { attrs, slots }: any) => () => (
    <main {...pick(attrs, ["class", "style"])} class={["pg-main", attrs.class].filter(Boolean).join(" ")}>
        {slots.default?.()}
    </main>
));

export const VNavigationDrawer = layoutDc((_p, _e, { attrs, slots }: any) => () => {
    const temporary = Boolean(attrs.temporary);
    return (
        <aside
            {...pick(attrs, ["class", "style", "id", "aria-label", "aria-labelledby", "aria-describedby"])}
            hidden={attrs.modelValue === false}
            class={["pg-nav-drawer", "v-navigation-drawer", temporary ? "pg-slide-over-panel" : "", attrs.modelValue !== false ? "v-navigation-drawer--active" : "", attrs.class].filter(Boolean).join(" ")}
            style={[
                temporary
                    ? {
                          position: "fixed",
                          top: 0,
                          bottom: 0,
                          insetInlineEnd: 0,
                          width: attrs.width ? `${attrs.width}px` : undefined,
                          height: "100vh",
                          zIndex: 1100,
                          background: "var(--pg-bg-surface)",
                          boxShadow: "var(--pg-shadow-menu)",
                      }
                    : {
                          width: attrs.width ? `${attrs.width}px` : undefined,
                      },
                attrs.style,
            ]}
        >
            <div class="v-navigation-drawer__content">{slots.default?.()}</div>
        </aside>
    );
});


export const VSpacer = layoutDc(() => () => <div class="pg-spacer" />);

export const VContainer = layoutDc((_p, _e, { attrs, slots }: any) => () => (
    <div class={["pg-container", attrs.class].filter(Boolean).join(" ")}>{slots.default?.()}</div>
));

export const VRow = layoutDc((_p, _e, { attrs, slots }: any) => () => (
    <div class={["pg-row", attrs.class].filter(Boolean).join(" ")} style={attrs.style}>
        {slots.default?.()}
    </div>
));

export const VCol = layoutDc((_p, _e, { attrs, slots }: any) => () => {
    const cols = Number(attrs.cols ?? 0);
    return (
        <div
            class={["pg-col", attrs.class].filter(Boolean).join(" ")}
            style={[
                cols > 0 ? { flex: `0 0 ${(cols / 12) * 100}%`, maxWidth: `${(cols / 12) * 100}%` } : undefined,
                attrs.style,
            ]}
        >
            {slots.default?.()}
        </div>
    );
});

export const VList = layoutDc((_p, _e, { attrs, slots }: any) => () => (
    <ul class={["pg-list", attrs.class].filter(Boolean).join(" ")}>{slots.default?.()}</ul>
));

export const VListItem = layoutDc((_p, _e, { attrs, slots }: any) => {
    const router = useRouter();
    return () => {
        const content = (
            <>
                {icon(attrs.prependIcon) && <AppIcon name={attrs.prependIcon as IconName} size={20} />}
                <span class="pg-list-item-content">
                    {attrs.title && <span class="pg-list-item-title">{attrs.title}</span>}
                    {attrs.subtitle && <span class="pg-list-item-subtitle">{attrs.subtitle}</span>}
                    {slots.default?.()}
                </span>
            </>
        );
        if (attrs.to) {
            const href = typeof attrs.to === "string" ? attrs.to : router.resolve(attrs.to).href;
            return (
                <li class={["pg-list-item", attrs.class].filter(Boolean).join(" ")}>
                    <a
                        href={href}
                        class="pg-list-item-link"
                        onClick={(event: MouseEvent) => {
                            event.preventDefault();
                            attrs.onClick?.(event);
                            if (typeof attrs.to === "string") void router.push(attrs.to);
                            else void router.push(attrs.to);
                        }}
                    >
                        {content}
                    </a>
                </li>
            );
        }
        return (
            <li class={["pg-list-item", attrs.class].filter(Boolean).join(" ")} onClick={attrs.onClick}>
                {content}
            </li>
        );
    };
});


export const VListItemTitle = layoutDc((_p, _e, { attrs, slots }: any) => () => (
    <span class={["pg-list-item-title", attrs.class].filter(Boolean).join(" ")}>{slots.default?.()}</span>
));

export const VListItemSubtitle = layoutDc((_p, _e, { attrs, slots }: any) => () => (
    <span class={["pg-list-item-subtitle", attrs.class].filter(Boolean).join(" ")}>{slots.default?.()}</span>
));

export const VListSubheader = layoutDc((_p, _e, { attrs, slots }: any) => () => (
    <li class={["pg-list-subheader", attrs.class].filter(Boolean).join(" ")}>{slots.default?.()}</li>
));

export const VExpansionPanels = layoutDc((_p, _e, { attrs, slots }: any) => () => (
    <div class={["pg-expansion", attrs.class].filter(Boolean).join(" ")}>{slots.default?.()}</div>
));

export const VExpansionPanel = layoutDc((_p, _e, { attrs, slots }: any) => () => (
    <details class={["pg-expansion-panel", attrs.class].filter(Boolean).join(" ")} open={Boolean(attrs.modelValue)}>
        {slots.default?.()}
    </details>
));

export const VExpansionPanelTitle = layoutDc((_p, _e, { attrs, slots }: any) => () => (
    <summary class={["pg-expansion-title", attrs.class].filter(Boolean).join(" ")}>{slots.default?.()}</summary>
));

export const VExpansionPanelText = layoutDc((_p, _e, { attrs, slots }: any) => () => (
    <div class={["pg-expansion-text", attrs.class].filter(Boolean).join(" ")}>{slots.default?.()}</div>
));

export const VTimeline = layoutDc((_p, _e, { attrs, slots }: any) => () => (
    <div class={["pg-timeline", attrs.class].filter(Boolean).join(" ")}>{slots.default?.()}</div>
));

export const VTimelineItem = layoutDc((_p, _e, { attrs, slots }: any) => () => (
    <div class={["pg-timeline-item", attrs.class].filter(Boolean).join(" ")}>
        <span class="pg-timeline-dot" style={{ background: attrs.dotColor }} />
        <div class="pg-timeline-content">
            {icon(attrs.icon) && <AppIcon name={attrs.icon as IconName} size={16} />}
            {attrs.title && <div class="pg-timeline-title">{attrs.title}</div>}
            {slots.default?.()}
        </div>
    </div>
));

export const VBtnToggle = dc((_p, _e, { attrs, slots }: any) => () => (
    <div class={["pg-btn-toggle", attrs.class].filter(Boolean).join(" ")}>{slots.default?.()}</div>
));

export const VExpandTransition = dc((_p, _e, { slots }: any) => () => slots.default?.());

/** `IconProps` compatibility export for modules that imported it from Vuetify. */
export type { IconProps } from "@/utils/vael-compat";
