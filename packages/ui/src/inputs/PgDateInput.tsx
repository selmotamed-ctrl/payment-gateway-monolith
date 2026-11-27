import { computed, nextTick, ref, watch } from "vue";
import { dc } from "../lib/dc";
import { controlSize } from "../lib/options";
import { runRules, visibleError } from "../lib/rules";
import { isBrowser, useClickOutside, useEscape } from "../lib/dom";
import { useLocale } from "../lib/locale";
import { PgFieldShell } from "./PgFieldShell";
import { PgIcon } from "../actions/PgIcon";

import { fromIsoDate as fromIso, sameDay, startOfDay, toIsoDate } from "../lib/date";
export { toIsoDate } from "../lib/date";

export interface PgDateRange {
    from?: string;
    to?: string;
}

const rangeFromValue = (value: any): Date[] => {
    if (Array.isArray(value)) return value.map(fromIso).filter((date): date is Date => Boolean(date));
    if (value && typeof value === "object") {
        const from = fromIso(value.from);
        const to = fromIso(value.to);
        return [from, to].filter((date): date is Date => Boolean(date));
    }
    const single = fromIso(value);
    return single ? [single] : [];
};

/**
 * 2026 date input: editable `YYYY-MM-DD`, teleported calendar with month/year
 * jump, today ring, min/max, range mode with fintech presets.
 */
export const PgDateInput = dc(
    (props: Record<string, any>, expose, { attrs, emit }) => {
        const localeApi = useLocale();
        const { t } = localeApi;
        const triggerRef = ref<HTMLElement | null>(null);
        const panelRef = ref<HTMLElement | null>(null);
        const open = ref(false);
        const viewMode = ref<"day" | "month" | "year">("day");
        const viewDate = ref(startOfDay(new Date()));
        const draft = ref("");
        const rangeStart = ref<Date | null>(null);
        const panelStyle = ref<Record<string, string>>({});
        const localError = ref("");
        const isEmptyRange = computed(() => props.multiple === "range" || props.range === true);
        const size = computed(() => controlSize({ ...props, density: props.density ?? attrs.density }));
        const error = computed(() => visibleError({ ...props, ...attrs }, localError.value));

        const selected = computed<Date[]>(() =>
            isEmptyRange.value ? rangeFromValue(props.modelValue) : [fromIso(props.modelValue)].filter((date): date is Date => Boolean(date)),
        );
        const display = computed(() => {
            if (isEmptyRange.value) {
                const dates = selected.value;
                if (!dates.length) return "";
                return dates.length > 1 ? `${toIsoDate(dates[0]!)} → ${toIsoDate(dates[dates.length - 1]!)}` : toIsoDate(dates[0]!);
            }
            return selected.value[0] ? toIsoDate(selected.value[0]) : "";
        });

        watch(
            () => props.modelValue,
            () => {
                draft.value = display.value;
                const first = selected.value[0];
                if (first) viewDate.value = startOfDay(first);
            },
            { immediate: true },
        );

        const minDate = computed(() => fromIso(props.min));
        const maxDate = computed(() => fromIso(props.max));
        const isDisabled = (date: Date): boolean => {
            if (minDate.value && startOfDay(date) < startOfDay(minDate.value)) return true;
            if (maxDate.value && startOfDay(date) > startOfDay(maxDate.value)) return true;
            return false;
        };

        const locale = computed(() => (localeApi.current.value === "ar" ? "ar-LY" : "en-GB"));
        const monthLabel = computed(() =>
            new Intl.DateTimeFormat(locale.value, { month: "long", year: "numeric" }).format(viewDate.value),
        );
        const weekdays = computed(() => {
            const formatter = new Intl.DateTimeFormat(locale.value, { weekday: "short" });
            const base = new Date(2024, 0, 7); // Sunday
            return Array.from({ length: 7 }, (_, index) =>
                formatter.format(new Date(base.getFullYear(), base.getMonth(), base.getDate() + index)),
            );
        });

        const days = computed(() => {
            const year = viewDate.value.getFullYear();
            const month = viewDate.value.getMonth();
            const first = new Date(year, month, 1, 12);
            const startOffset = first.getDay();
            const start = new Date(year, month, 1 - startOffset, 12);
            return Array.from({ length: 42 }, (_, index) => {
                const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index, 12);
                return {
                    date,
                    iso: toIsoDate(date),
                    inMonth: date.getMonth() === month,
                    today: sameDay(date, new Date()),
                };
            });
        });

        const updatePosition = () => {
            if (!isBrowser) return;
            const element = triggerRef.value;
            if (!element) return;
            const rect = element.getBoundingClientRect();
            const panelHeight = 380;
            const spaceBelow = window.innerHeight - rect.bottom;
            const flipUp = spaceBelow < panelHeight && rect.top > spaceBelow;
            panelStyle.value = {
                position: "fixed",
                left: `${Math.max(8, Math.min(rect.left, window.innerWidth - 320))}px`,
                top: flipUp ? "auto" : `${rect.bottom + 6}px`,
                bottom: flipUp ? `${window.innerHeight - rect.top + 6}px` : "auto",
                zIndex: "var(--pg-z-popover)",
            };
        };

        const openPanel = async () => {
            if (props.disabled || props.readonly) return;
            open.value = true;
            viewMode.value = "day";
            rangeStart.value = null;
            await nextTick();
            updatePosition();
        };
        const closePanel = () => {
            open.value = false;
            rangeStart.value = null;
        };

        const validate = (next: any) => {
            localError.value = props.rules ? runRules({ ...props, ...attrs }, next) : "";
        };

        const commit = (date: Date | null) => {
            if (!date) {
                emit?.("update:modelValue", null);
                draft.value = "";
                validate(null);
                return;
            }
            if (isEmptyRange.value) {
                if (!rangeStart.value || (rangeStart.value && date < rangeStart.value)) {
                    rangeStart.value = startOfDay(date);
                    emit?.("update:modelValue", [rangeStart.value]);
                    return;
                }
                const from = rangeStart.value;
                const to = startOfDay(date);
                emit?.("update:modelValue", [from, to]);
                emit?.("change", [from, to]);
                validate([from, to]);
                rangeStart.value = null;
                closePanel();
                return;
            }
            emit?.("update:modelValue", toIsoDate(date));
            emit?.("change", toIsoDate(date));
            draft.value = toIsoDate(date);
            validate(toIsoDate(date));
            closePanel();
        };

        const parseDraft = () => {
            const date = fromIso(draft.value.trim());
            if (date && !isDisabled(date)) commit(date);
            else draft.value = display.value;
        };

        const clear = () => {
            emit?.("update:modelValue", isEmptyRange.value ? [] : null);
            emit?.("clear");
            draft.value = "";
            validate(null);
        };

        const presets = computed(() => {
            const today = startOfDay(new Date());
            const monthStart = new Date(today.getFullYear(), today.getMonth(), 1, 12);
            const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1, 12);
            const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0, 12);
            const yearStart = new Date(today.getFullYear(), 0, 1, 12);
            return [
                { label: t("Today"), range: [today, today] },
                { label: t("Last 7 Days"), range: [new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6, 12), today] },
                { label: t("Last 30 Days"), range: [new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29, 12), today] },
                { label: t("This Month"), range: [monthStart, today] },
                { label: t("Last Month"), range: [lastMonthStart, lastMonthEnd] },
                { label: t("Year to Date"), range: [yearStart, today] },
            ];
        });

        useClickOutside([triggerRef, panelRef], closePanel, open);
        useEscape(closePanel, open);
        onBeforeUnmountListeners();
        function onBeforeUnmountListeners() {
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
        }

        expose?.({
            focus: () => triggerRef.value?.focus(),
            open: () => void openPanel(),
            clear,
        });

        const stepMonth = (delta: number) => {
            viewDate.value = new Date(viewDate.value.getFullYear(), viewDate.value.getMonth() + delta, 1, 12);
        };

        const renderDay = (day: { date: Date; iso: string; inMonth: boolean; today: boolean }) => {
            const active = selected.value.some((date) => sameDay(date, day.date));
            const inRange =
                selected.value.length > 1 &&
                day.date >= startOfDay(selected.value[0]!) &&
                day.date <= startOfDay(selected.value[selected.value.length - 1]!);
            const pending = rangeStart.value && sameDay(rangeStart.value, day.date);
            return (
                <button
                    key={day.iso}
                    type="button"
                    class={[
                        "pg-cal-day",
                        day.inMonth ? "" : "pg-cal-day--outside",
                        day.today ? "pg-cal-day--today" : "",
                        active || pending ? "pg-cal-day--selected" : "",
                        inRange ? "pg-cal-day--in-range" : "",
                    ]
                        .filter(Boolean)
                        .join(" ")}
                    disabled={isDisabled(day.date)}
                    aria-pressed={active ? "true" : "false"}
                    aria-label={new Intl.DateTimeFormat(locale.value, { dateStyle: "long" }).format(day.date)}
                    onClick={() => commit(day.date)}
                >
                    {day.date.getDate()}
                </button>
            );
        };

        return () => (
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
                        "pg-control-box",
                        `pg-control-box--${size.value}`,
                        open.value ? "pg-control-box--focused" : "",
                        error.value ? "pg-control-box--error" : "",
                        props.disabled ? "pg-control-box--disabled" : "",
                    ]}
                    onClick={() => (open.value ? undefined : void openPanel())}
                >
                    <span class="pg-control-adornment">
                        <PgIcon icon={props.prependInnerIcon || (isEmptyRange.value ? "mdi-calendar-range" : "mdi-calendar-blank-outline")} size={17} />
                    </span>
                    <input
                        class="pg-control-native pg-mono"
                        type="text"
                        inputmode="numeric"
                        placeholder={props.placeholder ?? "YYYY-MM-DD"}
                        value={draft.value}
                        disabled={props.disabled}
                        readonly={props.readonly}
                        aria-label={props["aria-label"] ?? props.label ?? "Date"}
                        onFocus={() => void openPanel()}
                        onInput={(event: Event) => (draft.value = (event.target as HTMLInputElement).value)}
                        onBlur={parseDraft}
                        onKeydown={(event: KeyboardEvent) => {
                            if (event.key === "Enter") {
                                event.preventDefault();
                                parseDraft();
                            }
                            if (event.key === "Escape") closePanel();
                        }}
                    />
                    {props.clearable && display.value && !props.disabled && (
                        <button
                            type="button"
                            class="pg-control-clear-btn"
                            aria-label="Clear date"
                            onMousedown={(event: MouseEvent) => event.preventDefault()}
                            onClick={(event: MouseEvent) => {
                                event.stopPropagation();
                                clear();
                            }}
                        >
                            <PgIcon icon="mdi-close-circle" size={16} />
                        </button>
                    )}
                </div>

                    {open.value && (
                        <div ref={panelRef} class="pg-popover-panel pg-date-panel" style={panelStyle.value} role="dialog" aria-modal="false">
                            <div class="pg-date-panel__header">
                                <button type="button" class="pg-date-nav" aria-label={t("Previous month")} onClick={() => stepMonth(-1)}>
                                    <PgIcon icon={localeApi.current.value === "ar" ? "mdi-chevron-right" : "mdi-chevron-left"} size={18} />
                                </button>
                                <button
                                    type="button"
                                    class="pg-date-label"
                                    aria-label={t("Choose month and year")}
                                    onClick={() => (viewMode.value = viewMode.value === "day" ? "month" : "day")}
                                >
                                    {monthLabel.value}
                                </button>
                                <button type="button" class="pg-date-nav" aria-label={t("Next month")} onClick={() => stepMonth(1)}>
                                    <PgIcon icon={localeApi.current.value === "ar" ? "mdi-chevron-left" : "mdi-chevron-right"} size={18} />
                                </button>
                            </div>

                            {viewMode.value === "day" && (
                                <>
                                    <div class="pg-cal-weekdays" aria-hidden="true">
                                        {weekdays.value.map((label) => (
                                            <span key={label} class="pg-cal-weekday">{label}</span>
                                        ))}
                                    </div>
                                    <div class="pg-cal-grid" role="grid">
                                        {days.value.map(renderDay)}
                                    </div>
                                </>
                            )}

                            {viewMode.value === "month" && (
                                <div class="pg-cal-grid pg-cal-grid--months">
                                    {Array.from({ length: 12 }, (_, month) => (
                                        <button
                                            key={month}
                                            type="button"
                                            class={[
                                                "pg-cal-month",
                                                month === viewDate.value.getMonth() ? "pg-cal-month--active" : "",
                                            ]
                                                .filter(Boolean)
                                                .join(" ")}
                                            onClick={() => {
                                                viewDate.value = new Date(viewDate.value.getFullYear(), month, 1, 12);
                                                viewMode.value = "day";
                                            }}
                                        >
                                            {new Intl.DateTimeFormat(locale.value, { month: "short" }).format(
                                                new Date(2024, month, 1),
                                            )}
                                        </button>
                                    ))}
                                </div>
                            )}

                            <div class="pg-date-panel__footer">
                                <button type="button" class="pg-date-text-btn" onClick={() => commit(new Date())}>
                                    {t("Today")}
                                </button>
                                <button type="button" class="pg-date-text-btn" onClick={clear}>
                                    {t("Clear")}
                                </button>
                            </div>

                            {isEmptyRange.value && (
                                <div class="pg-date-presets">
                                    {presets.value.map((preset) => (
                                        <button
                                            key={preset.label}
                                            type="button"
                                            class="pg-date-preset"
                                            onClick={() => {
                                                emit?.("update:modelValue", preset.range);
                                                emit?.("change", preset.range);
                                                validate(preset.range);
                                                closePanel();
                                            }}
                                        >
                                            {preset.label}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

</PgFieldShell>
        );
    },
    {
        props: {
            modelValue: { type: [String, Date, Array, Object], default: null },
            label: { type: String, default: "" },
            hint: { type: String, default: "" },
            error: { type: String, default: "" },
            errorMessages: { type: [Array, String], default: undefined },
            placeholder: { type: String, default: "" },
            min: { type: [String, Date], default: undefined },
            max: { type: [String, Date], default: undefined },
            multiple: { type: [String, Boolean], default: undefined },
            range: { type: Boolean, default: false },
            clearable: { type: Boolean, default: false },
            disabled: { type: Boolean, default: false },
            readonly: { type: Boolean, default: false },
            required: { type: Boolean, default: false },
            size: { type: String, default: "md" },
            density: { type: String, default: "" },
            prependInnerIcon: { type: String, default: "" },
            rules: { type: Array as () => Array<(value: any) => any>, default: () => [] },
            hideDetails: { type: Boolean, default: false },
        },
        emits: ["update:modelValue", "change", "clear"],
        inheritAttrs: true,
    },
);

export const PgDateRangeInput = PgDateInput;
export const VDateInput = PgDateInput;
