import { createIf } from "@vue/runtime-vapor";

/** The Vapor JSX return type is a Block at runtime; the public type is narrower. */
const branch = createIf as any;
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from "vue";
import { dc } from "../lib/dc";
import { controlSize } from "../lib/options";
import { runRules, visibleError } from "../lib/rules";
import { isBrowser, useClickOutside, useEscape } from "../lib/dom";
import { useLocale } from "../lib/locale";
import { PgFieldShell } from "./PgFieldShell";
import { PgIcon } from "../actions/PgIcon";
import {
    addDays,
    fromIsoDate,
    last30Days,
    last7Days,
    last90Days,
    lastMonth,
    monthLabel,
    monthToDate,
    sameDay,
    startOfCalendarDay,
    toIsoDate,
    todayRange,
    weekdayLabels,
    yearToDate,
    type PgDateRange,
} from "../lib/date";

export type { PgDateRange } from "../lib/date";
export { toIsoDate } from "../lib/date";

const shiftMonth = (date: Date, delta: number): Date =>
    new Date(date.getFullYear(), date.getMonth() + delta, 1, 12, 0, 0, 0);

const shiftYear = (date: Date, delta: number): Date =>
    new Date(date.getFullYear() + delta, date.getMonth(), 1, 12, 0, 0, 0);

const isoOrEmpty = (value: unknown): string => toIsoDate(value as any);

const normalizeRangeDates = (value: any): Date[] => {
    if (Array.isArray(value)) {
        return value
            .map((entry) => fromIsoDate(entry))
            .filter((date): date is Date => Boolean(date));
    }
    if (value && typeof value === "object") {
        const from = fromIsoDate((value as any).from ?? (value as any).start);
        const to = fromIsoDate((value as any).to ?? (value as any).end);
        return [from, to].filter((date): date is Date => Boolean(date));
    }
    const single = fromIsoDate(value);
    return single ? [single] : [];
};

const normalizeRangeIso = (value: any): PgDateRange => {
    if (!value) return { start: "", end: "" };
    if (Array.isArray(value)) {
        const dates = normalizeRangeDates(value);
        const first = dates[0];
        const last = dates[dates.length - 1];
        return {
            start: first ? toIsoDate(first) : "",
            end: last ? toIsoDate(last) : first ? toIsoDate(first) : "",
        };
    }
    if (typeof value === "string") {
        const [from, to] = value.split(/\s*(?:→|->|\bto\b)\s*/i);
        return { start: isoOrEmpty(from), end: isoOrEmpty(to ?? from) };
    }
    if (typeof value === "object") {
        const start = isoOrEmpty((value as any).start ?? (value as any).from);
        const end = isoOrEmpty((value as any).end ?? (value as any).to);
        return { start, end: end || start };
    }
    return { start: "", end: "" };
};

type DayCell = {
    date: Date;
    iso: string;
    inMonth: boolean;
    today: boolean;
};

const buildMonthCells = (view: Date): DayCell[] => {
    const year = view.getFullYear();
    const month = view.getMonth();
    const first = new Date(year, month, 1, 12);
    const startOffset = first.getDay(); // Sunday = 0; never reversed in LTR.
    const start = new Date(year, month, 1 - startOffset, 12);
    const today = new Date();
    return Array.from({ length: 42 }, (_, index) => {
        const date = new Date(
            start.getFullYear(),
            start.getMonth(),
            start.getDate() + index,
            12,
        );
        return {
            date,
            iso: toIsoDate(date),
            inMonth: date.getMonth() === month && date.getFullYear() === year,
            today: sameDay(date, today),
        };
    });
};

const fullWeekdayName = (index: number, locale: "en" | "ar"): string =>
    new Intl.DateTimeFormat(locale === "ar" ? "ar-LY" : "en-GB", {
        weekday: "long",
    }).format(new Date(2024, 0, 7 + index, 12));

const fullDateLabel = (date: Date, locale: "en" | "ar"): string =>
    new Intl.DateTimeFormat(locale === "ar" ? "ar-LY" : "en-GB", {
        dateStyle: "long",
    }).format(date);

/* ------------------------------------------------------------------ calendar */

type CalendarProps = {
    view: Date;
    selected: string[];
    hover: string;
    min: string;
    max: string;
    locale: "en" | "ar";
    pick: (date: Date) => void;
    hoverDay: (iso: string) => void;
    viewChange: (date: Date) => void;
};

const PgCalendar = dc(
    (props: CalendarProps) => {
        const { t } = useLocale();
        const mode = ref<"day" | "month" | "year">("day");
        const gridRef = ref<HTMLElement | null>(null);

        const cells = computed(() => buildMonthCells(props.view));
        const weekdays = computed(() => weekdayLabels(props.locale));
        const headerLabel = computed(() => {
            if (mode.value === "month") return String(props.view.getFullYear());
            if (mode.value === "year") {
                const startYear = Math.floor(props.view.getFullYear() / 12) * 12;
                return `${startYear} – ${startYear + 11}`;
            }
            return monthLabel(props.view, props.locale);
        });
        const years = computed(() => {
            const startYear = Math.floor(props.view.getFullYear() / 12) * 12;
            return Array.from({ length: 12 }, (_, index) => startYear + index);
        });

        const step = (delta: number) => {
            if (mode.value === "day") props.viewChange(shiftMonth(props.view, delta));
            else if (mode.value === "month") props.viewChange(shiftYear(props.view, delta));
            else props.viewChange(shiftYear(props.view, delta * 12));
        };

        const cycleMode = () => {
            mode.value =
                mode.value === "day"
                    ? "month"
                    : mode.value === "month"
                      ? "year"
                      : "day";
        };

        const band = computed(() => {
            const list = props.selected.filter(Boolean);
            if (!list.length) return null;
            const first = list[0]!;
            const last =
                list.length > 1 ? list[list.length - 1]! : props.hover || first;
            const start = last < first ? last : first;
            const end = last < first ? first : last;
            return { start, end };
        });

        const isDisabled = (iso: string): boolean => {
            if (props.min && iso < props.min) return true;
            if (props.max && iso > props.max) return true;
            return false;
        };

        const isSelected = (iso: string) => props.selected.includes(iso);
        const isCurrentMonth = (date: Date) =>
            date.getMonth() === props.view.getMonth() &&
            date.getFullYear() === props.view.getFullYear();

        const focusIso = (iso: string) => {
            nextTick(() => {
                const node = gridRef.value?.querySelector<HTMLElement>(
                    `[data-iso="${iso}"]`,
                );
                node?.focus?.();
            });
        };

        const onDayKeydown = (event: KeyboardEvent, date: Date) => {
            let next: Date | null = null;
            if (event.key === "ArrowLeft") next = addDays(date, -1);
            else if (event.key === "ArrowRight") next = addDays(date, 1);
            else if (event.key === "ArrowUp") next = addDays(date, -7);
            else if (event.key === "ArrowDown") next = addDays(date, 7);
            else if (event.key === "PageUp") next = shiftMonth(date, -1);
            else if (event.key === "PageDown") next = shiftMonth(date, 1);
            else if (event.key === "Escape") {
                event.preventDefault();
                (gridRef.value?.closest<HTMLElement>(".pg-popover-panel") as HTMLElement | null)
                    ?.querySelector<HTMLInputElement>("input")
                    ?.focus?.();
                return;
            } else return;
            event.preventDefault();
            if (
                next.getMonth() !== props.view.getMonth() ||
                next.getFullYear() !== props.view.getFullYear()
            ) {
                props.viewChange(
                    new Date(next.getFullYear(), next.getMonth(), 1, 12),
                );
            }
            focusIso(toIsoDate(next));
        };

        return () => (
            <div class="pg-cal" data-pg-calendar>
                <div class="pg-date-panel__header pg-cal__header">
                    <button
                        type="button"
                        class="pg-date-nav"
                        data-pg-cal-nav="prev"
                        aria-label={t("Previous month")}
                        onClick={() => step(-1)}
                    >
                        <PgIcon icon="mdi-chevron-left" size={18} />
                    </button>
                    <button
                        type="button"
                        class="pg-date-label pg-cal__label"
                        aria-label={t("Choose month and year")}
                        aria-live="polite"
                        onClick={cycleMode}
                    >
                        {headerLabel.value}
                    </button>
                    <button
                        type="button"
                        class="pg-date-nav"
                        data-pg-cal-nav="next"
                        aria-label={t("Next month")}
                        onClick={() => step(1)}
                    >
                        <PgIcon icon="mdi-chevron-right" size={18} />
                    </button>
                </div>

                {mode.value === "day" && (
                    <div class="pg-cal__body">
                        <div class="pg-cal-weekdays" role="row" aria-hidden="false">
                            {weekdays.value.map((label, index) => (
                                <span
                                    key={`${label}-${index}`}
                                    class="pg-cal-weekday"
                                    role="columnheader"
                                    aria-label={fullWeekdayName(index, props.locale)}
                                >
                                    {label}
                                </span>
                            ))}
                        </div>
                        <div class="pg-cal-grid" role="grid" ref={gridRef}>
                            {cells.value.map((cell) => {
                                const selected = isSelected(cell.iso);
                                const inBand = Boolean(
                                    band.value &&
                                        cell.iso > band.value.start &&
                                        cell.iso < band.value.end,
                                );
                                const rangeStart = selected && props.selected[0] === cell.iso;
                                const rangeEnd =
                                    selected &&
                                    props.selected.length > 1 &&
                                    props.selected[props.selected.length - 1] === cell.iso;
                                return (
                                    <button
                                        key={cell.iso}
                                        type="button"
                                        role="gridcell"
                                        data-iso={cell.iso}
                                        aria-selected={selected ? "true" : "false"}
                                        aria-pressed={selected ? "true" : "false"}
                                        aria-label={fullDateLabel(cell.date, props.locale)}
                                        disabled={isDisabled(cell.iso)}
                                        class={[
                                            "pg-cal-day",
                                            cell.inMonth ? "" : "pg-cal-day--outside",
                                            cell.today ? "pg-cal-day--today" : "",
                                            selected ? "pg-cal-day--selected" : "",
                                            inBand ? "pg-cal-day--in-range" : "",
                                            rangeStart ? "pg-cal-day--range-start" : "",
                                            rangeEnd ? "pg-cal-day--range-end" : "",
                                            props.hover === cell.iso && !selected
                                                ? "pg-cal-day--hover-end"
                                                : "",
                                        ]
                                            .filter(Boolean)
                                            .join(" ")}
                                        onClick={() => props.pick(cell.date)}
                                        onMouseenter={() => props.hoverDay(cell.iso)}
                                        onKeydown={(event: KeyboardEvent) =>
                                            onDayKeydown(event, cell.date)
                                        }
                                    >
                                        {cell.date.getDate()}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                )}

                {mode.value === "month" && (
                    <div class="pg-cal-grid pg-cal-grid--months" role="grid">
                        {Array.from({ length: 12 }, (_, month) => (
                            <button
                                key={month}
                                type="button"
                                class={[
                                    "pg-cal-month",
                                    month === props.view.getMonth()
                                        ? "pg-cal-month--active"
                                        : "",
                                ]
                                    .filter(Boolean)
                                    .join(" ")}
                                onClick={() => {
                                    props.viewChange(
                                        new Date(
                                            props.view.getFullYear(),
                                            month,
                                            1,
                                            12,
                                        ),
                                    );
                                    mode.value = "day";
                                }}
                            >
                                {new Intl.DateTimeFormat(
                                    props.locale === "ar" ? "ar-LY" : "en-GB",
                                    { month: "short" },
                                ).format(new Date(2024, month, 1, 12))}
                            </button>
                        ))}
                    </div>
                )}

                {mode.value === "year" && (
                    <div class="pg-cal-grid pg-cal-grid--years" role="grid">
                        {years.value.map((year) => (
                            <button
                                key={year}
                                type="button"
                                class={[
                                    "pg-cal-year",
                                    year === props.view.getFullYear()
                                        ? "pg-cal-year--active"
                                        : "",
                                ]
                                    .filter(Boolean)
                                    .join(" ")}
                                onClick={() => {
                                    props.viewChange(
                                        new Date(year, props.view.getMonth(), 1, 12),
                                    );
                                    mode.value = "month";
                                }}
                            >
                                {year}
                            </button>
                        ))}
                    </div>
                )}
            </div>
        );
    },
    {
        props: {
            view: { type: Object as unknown as () => Date, default: () => new Date() },
            selected: { type: Array as () => string[], default: () => [] },
            hover: { type: String, default: "" },
            min: { type: String, default: "" },
            max: { type: String, default: "" },
            locale: { type: String, default: "en" },
            pick: { type: Function, default: undefined },
            hoverDay: { type: Function, default: undefined },
            viewChange: { type: Function, default: undefined },
        },
    },
);

/* ----------------------------------------------------------------- date input */

export const PgDateInput = dc(
    (props: Record<string, any>, expose, { attrs, emit }) => {
        const localeApi = useLocale();
        const { t } = localeApi;
        const uid = useId();
        const fieldId = props.id || `pg-date-${uid}`;
        const triggerRef = ref<HTMLElement | null>(null);
        const panelRef = ref<HTMLElement | null>(null);
        const inputRef = ref<HTMLInputElement | null>(null);
        const open = ref(false);
        const viewDate = ref(startOfCalendarDay(new Date()));
        const draft = ref("");
        const valueState = ref<any>(props.multiple === "range" || props.range === true ? [] : null);
        const pendingStart = ref<Date | null>(null);
        const hoverIso = ref("");
        const panelStyle = ref<Record<string, string>>({});
        const localError = ref("");

        const rangeMode = computed(
            () => props.multiple === "range" || props.multiple === true || props.range === true,
        );
        const size = computed(() =>
            controlSize({ ...props, density: props.density ?? attrs.density }),
        );
        const error = computed(() =>
            visibleError({ ...props, ...attrs }, localError.value),
        );
        const locale = computed<"en" | "ar">(() =>
            localeApi.current.value === "ar" ? "ar" : "en",
        );

        watch(
            () => props.modelValue,
            (next) => {
                valueState.value = next;
            },
            { immediate: true, deep: true },
        );

        const selectedDates = computed<Date[]>(() =>
            rangeMode.value
                ? normalizeRangeDates(valueState.value)
                : [fromIsoDate(valueState.value)].filter(
                      (date): date is Date => Boolean(date),
                  ),
        );
        const selectedIso = computed(() =>
            selectedDates.value.map((date) => toIsoDate(date)),
        );
        const display = computed(() => {
            if (rangeMode.value) {
                if (!selectedIso.value.length) return "";
                if (selectedIso.value.length === 1) return selectedIso.value[0]!;
                return `${selectedIso.value[0]} → ${selectedIso.value[selectedIso.value.length - 1]}`;
            }
            return selectedIso.value[0] ?? "";
        });

        watch(
            () => props.modelValue,
            () => {
                draft.value = display.value;
                const first = selectedDates.value[0];
                if (first) viewDate.value = startOfCalendarDay(first);
                pendingStart.value = null;
            },
            { immediate: true, deep: true },
        );

        watch(draft, (next) => {
            const input = inputRef.value;
            if (input && input.value !== next) input.value = next;
        });

        const minIso = computed(() => isoOrEmpty(props.min));
        const maxIso = computed(() => isoOrEmpty(props.max));
        const isDisabled = (date: Date): boolean => {
            const iso = toIsoDate(date);
            if (minIso.value && iso < minIso.value) return true;
            if (maxIso.value && iso > maxIso.value) return true;
            return false;
        };

        const updatePosition = () => {
            if (!isBrowser) return;
            const element = triggerRef.value;
            if (!element) return;
            const rect = element.getBoundingClientRect();
            const spaceBelow = window.innerHeight - rect.bottom;
            const flipUp = spaceBelow < 360 && rect.top > spaceBelow;
            panelStyle.value = {
                position: "fixed",
                left: `${Math.max(8, Math.min(rect.left, window.innerWidth - 320))}px`,
                top: flipUp ? "auto" : `${rect.bottom + 6}px`,
                bottom: flipUp ? `${window.innerHeight - rect.top + 6}px` : "auto",
                zIndex: "var(--pg-z-popover)",
            };
        };

        const validate = (next: any) => {
            localError.value = props.rules ? runRules({ ...props, ...attrs }, next) : "";
        };

        const closePanel = (focus = false) => {
            if (!open.value) return;
            open.value = false;
            pendingStart.value = null;
            hoverIso.value = "";
            if (focus) (inputRef.value ?? triggerRef.value)?.focus?.();
        };

        const openPanel = async () => {
            if (props.disabled || props.readonly) return;
            if (open.value) return;
            open.value = true;
            draft.value = display.value;
            const first = selectedDates.value[0];
            viewDate.value = startOfCalendarDay(first ?? new Date());
            pendingStart.value = rangeMode.value ? null : pendingStart.value;
            await nextTick();
            updatePosition();
        };

        const emitRange = (dates: Date[]) => {
            const next = dates.map((date) => startOfCalendarDay(date));
            valueState.value = next;
            emit?.("update:modelValue", next);
            emit?.("change", next);
            validate(next);
        };

        const commitDate = (date: Date) => {
            if (isDisabled(date)) return;
            localError.value = "";
            if (rangeMode.value) {
                if (!pendingStart.value) {
                    pendingStart.value = startOfCalendarDay(date);
                    valueState.value = [pendingStart.value];
                    draft.value = toIsoDate(date);
                    return;
                }
                const first = pendingStart.value;
                const second = startOfCalendarDay(date);
                const from = second < first ? second : first;
                const to = second < first ? first : second;
                emitRange([from, to]);
                draft.value = `${toIsoDate(from)} → ${toIsoDate(to)}`;
                pendingStart.value = null;
                closePanel();
                return;
            }
            valueState.value = toIsoDate(date);
            emit?.("update:modelValue", toIsoDate(date));
            emit?.("change", toIsoDate(date));
            draft.value = toIsoDate(date);
            validate(toIsoDate(date));
            closePanel();
        };

        const parseDraft = () => {
            const value = draft.value.trim();
            if (!value) {
                clear();
                return;
            }
            if (rangeMode.value && /\s*(?:→|->)\s*/.test(value)) {
                const [fromRaw, toRaw] = value.split(/\s*(?:→|->)\s*/);
                const from = fromIsoDate(fromRaw);
                const to = fromIsoDate(toRaw ?? fromRaw);
                if (!from || !to || isDisabled(from) || isDisabled(to)) {
                    localError.value = t("Enter a valid date (YYYY-MM-DD)");
                    draft.value = display.value;
                    return;
                }
                const first = to < from ? to : from;
                const last = to < from ? from : to;
                emitRange([first, last]);
                draft.value = `${toIsoDate(first)} → ${toIsoDate(last)}`;
                closePanel();
                return;
            }
            const date = fromIsoDate(value);
            if (!date || isDisabled(date)) {
                localError.value = t("Enter a valid date (YYYY-MM-DD)");
                draft.value = display.value;
                return;
            }
            commitDate(date);
        };

        const clear = () => {
            if (props.disabled) return;
            const next = rangeMode.value ? [] : null;
            valueState.value = next;
            draft.value = "";
            localError.value = "";
            pendingStart.value = null;
            emit?.("update:modelValue", next);
            emit?.("clear");
            validate(next);
        };

        const presets = computed(() => [
            { label: t("Today"), range: todayRange() },
            { label: t("Last 7 Days"), range: last7Days() },
            { label: t("Last 30 Days"), range: last30Days() },
            { label: t("Last 90 Days"), range: last90Days() },
            { label: t("This Month"), range: monthToDate() },
            { label: t("Last Month"), range: lastMonth() },
            { label: t("Year to Date"), range: yearToDate() },
        ]);

        const applyPreset = (range: PgDateRange) => {
            const from = fromIsoDate(range.start);
            const to = fromIsoDate(range.end);
            if (!from || !to) return;
            emitRange([from, to]);
            draft.value = `${range.start} → ${range.end}`;
            viewDate.value = startOfCalendarDay(from);
            closePanel();
        };

        const focusCalendar = async () => {
            await nextTick();
            const target =
                pendingStart.value ?? selectedDates.value[0] ?? new Date();
            const node = panelRef.value?.querySelector<HTMLElement>(
                `[data-iso="${toIsoDate(target)}"]`,
            );
            (node ?? panelRef.value)?.focus?.();
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
            focus: () => (inputRef.value ?? triggerRef.value)?.focus?.(),
            open: () => void openPanel(),
            close: () => closePanel(),
            clear,
        });

        const onKeydown = (event: KeyboardEvent) => {
            if (event.key === "Enter") {
                event.preventDefault();
                parseDraft();
            } else if (event.key === "Escape") {
                if (!open.value) return;
                event.preventDefault();
                event.stopPropagation();
                closePanel(true);
            } else if (event.key === "ArrowDown") {
                event.preventDefault();
                if (!open.value) {
                    void openPanel();
                    void focusCalendar();
                } else {
                    void focusCalendar();
                }
            }
        };

        return () => (
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
                    data-pg-date
                    class={[
                        "pg-control-box",
                        "pg-date-trigger",
                        `pg-control-box--${size.value}`,
                        open.value ? "pg-control-box--focused" : "",
                        error.value ? "pg-control-box--error" : "",
                        props.disabled ? "pg-control-box--disabled" : "",
                        attrs.class,
                    ]
                        .filter(Boolean)
                        .join(" ")}
                    style={attrs.style}
                    onClick={() => {
                        if (open.value) (inputRef.value ?? triggerRef.value)?.focus?.();
                        else void openPanel();
                    }}
                >
                    <span class="pg-control-adornment pg-date-trigger__icon" aria-hidden="true">
                        <PgIcon
                            icon={
                                props.prependInnerIcon ||
                                (rangeMode.value
                                    ? "mdi-calendar-range"
                                    : "mdi-calendar-blank-outline")
                            }
                            size={16}
                        />
                    </span>
                    <input
                        ref={inputRef}
                        id={fieldId}
                        class="pg-control-native pg-mono pg-date-input"
                        type="text"
                        inputmode="numeric"
                        dir="ltr"
                        autocomplete="off"
                        placeholder={
                            props.placeholder ||
                            (rangeMode.value ? "YYYY-MM-DD → YYYY-MM-DD" : "YYYY-MM-DD")
                        }
                        value={draft.value}
                        disabled={props.disabled}
                        readonly={props.readonly}
                        aria-label={attrs["aria-label"] ?? props["aria-label"] ?? props.label ?? t("Date")}
                        aria-invalid={error.value ? "true" : undefined}
                        aria-expanded={open.value ? "true" : "false"}
                        aria-haspopup="dialog"
                        onFocus={() => void openPanel()}
                        onInput={(event: Event) => {
                            draft.value = (event.target as HTMLInputElement).value;
                            localError.value = "";
                        }}
                        onBlur={() => {
                            if (draft.value !== display.value) parseDraft();
                        }}
                        onKeydown={onKeydown}
                    />
                    {props.clearable !== false &&
                        display.value &&
                        !props.disabled &&
                        !props.readonly && (
                            <button
                                type="button"
                                class="pg-control-clear-btn"
                                aria-label={t("Clear date")}
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
                </div>

                {branch(
                    () => open.value,
                    () => (
                        <div
                            ref={panelRef}
                            class="pg-popover-panel pg-date-panel"
                            data-pg-date-panel
                            role="dialog"
                            aria-modal="false"
                            aria-label={t("Choose date")}
                            style={panelStyle.value}
                        >
                            <PgCalendar
                                view={viewDate.value}
                                selected={selectedIso.value}
                                hover={rangeMode.value ? hoverIso.value : ""}
                                min={minIso.value}
                                max={maxIso.value}
                                locale={locale.value}
                                pick={(date: Date) => commitDate(date)}
                                hoverDay={(iso: string) => {
                                    if (rangeMode.value && pendingStart.value) hoverIso.value = iso;
                                }}
                                viewChange={(next: Date) => (viewDate.value = next)}
                            />

                            <div class="pg-date-panel__footer">
                                <button
                                    type="button"
                                    class="pg-date-text-btn"
                                    onClick={() => commitDate(new Date())}
                                >
                                    {t("Today")}
                                </button>
                                <button type="button" class="pg-date-text-btn" onClick={clear}>
                                    {t("Clear")}
                                </button>
                            </div>

                            {rangeMode.value && (
                                <div class="pg-date-presets">
                                    {presets.value.map((preset) => (
                                        <button
                                            key={preset.label}
                                            type="button"
                                            class="pg-date-preset"
                                            onClick={() => applyPreset(preset.range)}
                                        >
                                            {preset.label}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    ),
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
            clearable: { type: Boolean, default: true },
            disabled: { type: Boolean, default: false },
            readonly: { type: Boolean, default: false },
            required: { type: Boolean, default: false },
            size: { type: String, default: "md" },
            density: { type: String, default: "" },
            prependInnerIcon: { type: String, default: "" },
            rules: { type: Array as () => Array<(value: any) => any>, default: () => [] },
            hideDetails: { type: Boolean, default: false },
            id: { type: String, default: "" },
        },
        emits: ["update:modelValue", "change", "clear"],
        inheritAttrs: true,
    },
);

/* ------------------------------------------------------------ date range input */

type RangePreset = {
    label: string;
    value: PgDateRange | (() => PgDateRange);
};

const defaultPresets = (t: (key: string) => string): RangePreset[] => [
    { label: t("Today"), value: todayRange() },
    { label: t("Last 7 Days"), value: last7Days() },
    { label: t("Last 30 Days"), value: last30Days() },
    { label: t("Last 90 Days"), value: last90Days() },
    { label: t("This Month"), value: monthToDate() },
    { label: t("Last Month"), value: lastMonth() },
    { label: t("Year to Date"), value: yearToDate() },
];

export const PgDateRangeInput = dc(
    (props: Record<string, any>, expose, { attrs, emit }) => {
        const localeApi = useLocale();
        const { t } = localeApi;
        const uid = useId();
        const fieldId = props.id || `pg-date-range-${uid}`;
        const triggerRef = ref<HTMLElement | null>(null);
        const panelRef = ref<HTMLElement | null>(null);
        const inputRef = ref<HTMLInputElement | null>(null);
        const open = ref(false);
        const viewDate = ref(startOfCalendarDay(new Date()));
        const valueState = ref<any>(props.modelValue);
        const draft = ref<PgDateRange>({ start: "", end: "" });
        const picking = ref<"start" | "end">("start");
        const hoverIso = ref("");
        const panelStyle = ref<Record<string, string>>({});
        const localError = ref("");

        const size = computed(() =>
            controlSize({ ...props, density: props.density ?? attrs.density }),
        );
        const error = computed(() =>
            visibleError({ ...props, ...attrs }, localError.value),
        );
        const locale = computed<"en" | "ar">(() =>
            localeApi.current.value === "ar" ? "ar" : "en",
        );
        watch(
            () => props.modelValue,
            (next) => {
                valueState.value = next;
            },
            { immediate: true, deep: true },
        );
        const committed = computed(() => normalizeRangeIso(valueState.value));
        const hasValue = computed(() => Boolean(committed.value.start));
        const display = computed(() => {
            const { start, end } = committed.value;
            if (!start) return "";
            return `${start} → ${end || start}`;
        });

        watch(
            () => props.modelValue,
            () => {
                draft.value = committed.value;
                const start = fromIsoDate(committed.value.start);
                if (start) viewDate.value = startOfCalendarDay(start);
                picking.value = "start";
                hoverIso.value = "";
            },
            { immediate: true, deep: true },
        );

        watch(display, (next) => {
            const input = inputRef.value;
            if (input && input.value !== next) input.value = next;
        });

        const minIso = computed(() => isoOrEmpty(props.min));
        const maxIso = computed(() => isoOrEmpty(props.max));

        const updatePosition = () => {
            if (!isBrowser) return;
            const element = triggerRef.value;
            if (!element) return;
            const rect = element.getBoundingClientRect();
            const spaceBelow = window.innerHeight - rect.bottom;
            const flipUp = spaceBelow < 440 && rect.top > spaceBelow;
            panelStyle.value = {
                position: "fixed",
                left: `${Math.max(8, Math.min(rect.left, Math.max(8, window.innerWidth - 460)))}px`,
                top: flipUp ? "auto" : `${rect.bottom + 6}px`,
                bottom: flipUp ? `${window.innerHeight - rect.top + 6}px` : "auto",
                zIndex: "var(--pg-z-popover)",
            };
        };

        const validate = (next: any) => {
            localError.value = props.rules ? runRules({ ...props, ...attrs }, next) : "";
        };

        const applyRange = (range: PgDateRange, force = false) => {
            const normalized = normalizeRangeIso(range);
            if (!normalized.start) return;
            const finalRange: PgDateRange = {
                start: normalized.start,
                end: normalized.end || normalized.start,
            };
            valueState.value = finalRange;
            draft.value = finalRange;
            validate(finalRange);
            emit?.("update:modelValue", finalRange);
            emit?.("change", finalRange);
            if (force || props.autoApply) {
                emit?.("apply", finalRange);
                closePanel();
            }
        };

        const closePanel = () => {
            open.value = false;
            hoverIso.value = "";
            picking.value = "start";
        };

        const cancel = () => {
            draft.value = committed.value;
            closePanel();
        };

        const openPanel = async () => {
            if (props.disabled || props.readonly) return;
            if (open.value) return;
            draft.value = committed.value;
            const start = fromIsoDate(committed.value.start);
            viewDate.value = startOfCalendarDay(start ?? new Date());
            picking.value = "start";
            hoverIso.value = "";
            open.value = true;
            await nextTick();
            updatePosition();
        };

        const clear = () => {
            if (props.disabled) return;
            valueState.value = null;
            draft.value = { start: "", end: "" };
            emit?.("update:modelValue", null);
            emit?.("clear");
            closePanel();
        };

        const presets = computed<RangePreset[]>(() => {
            if (Array.isArray(props.presets) && props.presets.length) {
                return props.presets;
            }
            return defaultPresets(t);
        });

        const presetValue = (preset: RangePreset): PgDateRange =>
            typeof preset.value === "function" ? preset.value() : preset.value;

        const applyPreset = (preset: RangePreset) => {
            const range = presetValue(preset);
            draft.value = normalizeRangeIso(range);
            picking.value = "start";
            applyRange(draft.value, Boolean(props.autoApply));
        };

        const onPick = (date: Date) => {
            const iso = toIsoDate(date);
            if (picking.value === "start" || !draft.value.start) {
                draft.value = { start: iso, end: "" };
                picking.value = "end";
                hoverIso.value = iso;
                return;
            }
            const start = draft.value.start;
            const range: PgDateRange =
                iso < start ? { start: iso, end: start } : { start, end: iso };
            picking.value = "start";
            applyRange(range, Boolean(props.autoApply));
        };

        const focusTrigger = () => triggerRef.value?.focus?.();

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
        useEscape(
            () => {
                draft.value = committed.value;
                closePanel();
                focusTrigger();
            },
            open,
        );
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

        const selected = computed(() =>
            [draft.value.start, draft.value.end].filter(Boolean) as string[],
        );

        return () => (
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
                    data-pg-date
                    data-pg-date-range
                    class={[
                        "pg-control-box",
                        "pg-date-trigger",
                        "pg-date-range-trigger",
                        `pg-control-box--${size.value}`,
                        open.value ? "pg-control-box--focused" : "",
                        error.value ? "pg-control-box--error" : "",
                        props.disabled ? "pg-control-box--disabled" : "",
                        attrs.class,
                    ]
                        .filter(Boolean)
                        .join(" ")}
                    style={attrs.style}
                    tabindex={props.disabled ? -1 : 0}
                    onClick={() => (open.value ? undefined : void openPanel())}
                    onKeydown={(event: KeyboardEvent) => {
                        if (event.key === "Enter" || event.key === "ArrowDown") {
                            event.preventDefault();
                            void openPanel();
                        } else if (event.key === "Escape" && open.value) {
                            event.preventDefault();
                            closePanel();
                        }
                    }}
                >
                    <span class="pg-control-adornment pg-date-trigger__icon" aria-hidden="true">
                        <PgIcon
                            icon={props.prependInnerIcon || "mdi-calendar-range"}
                            size={16}
                        />
                    </span>
                    <input
                        ref={inputRef}
                        id={fieldId}
                        class="pg-control-native pg-mono pg-date-input pg-date-range-input"
                        type="text"
                        dir="ltr"
                        readonly
                        autocomplete="off"
                        aria-label={attrs["aria-label"] ?? props["aria-label"] ?? props.label ?? t("Date range")}
                        aria-expanded={open.value ? "true" : "false"}
                        aria-haspopup="dialog"
                        aria-invalid={error.value ? "true" : undefined}
                        placeholder={props.placeholder || "YYYY-MM-DD → YYYY-MM-DD"}
                        value={display.value}
                    />
                    {props.clearable !== false && hasValue.value && !props.disabled && !props.readonly && (
                        <button
                            type="button"
                            class="pg-control-clear-btn"
                            aria-label={t("Clear date range")}
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
                </div>

                {branch(
                    () => open.value,
                    () => (
                        <div
                            ref={panelRef}
                            class="pg-popover-panel pg-date-range-panel"
                            data-pg-date-range-panel
                            role="dialog"
                            aria-modal="false"
                            aria-label={t("Choose date range")}
                            style={panelStyle.value}
                        >
                            <div class="pg-date-range__presets" role="listbox" aria-label={t("Presets")}>
                                {presets.value.map((preset) => {
                                    const value = presetValue(preset);
                                    const active =
                                        draft.value.start === value.start &&
                                        (draft.value.end || draft.value.start) ===
                                            (value.end || value.start);
                                    return (
                                        <button
                                            key={preset.label}
                                            type="button"
                                            role="option"
                                            aria-selected={active ? "true" : "false"}
                                            class={[
                                                "pg-date-preset",
                                                "pg-date-range__preset",
                                                active ? "pg-date-preset--active" : "",
                                            ]
                                                .filter(Boolean)
                                                .join(" ")}
                                            onClick={() => applyPreset(preset)}
                                        >
                                            {preset.label}
                                        </button>
                                    );
                                })}
                            </div>

                            <div class="pg-date-range__main">
                                <div class="pg-date-range__months">
                                    <div class="pg-date-range__month" data-pg-date-month="0">
                                        <PgCalendar
                                            view={viewDate.value}
                                            selected={selected.value}
                                            hover={picking.value === "end" ? hoverIso.value : ""}
                                            min={minIso.value}
                                            max={maxIso.value}
                                            locale={locale.value}
                                            pick={onPick}
                                            hoverDay={(iso: string) => {
                                                if (picking.value === "end") hoverIso.value = iso;
                                            }}
                                            viewChange={(next: Date) => (viewDate.value = next)}
                                        />
                                    </div>
                                    <div
                                        class="pg-date-range__month"
                                        data-pg-date-month="1"
                                        aria-hidden="false"
                                    >
                                        <PgCalendar
                                            view={shiftMonth(viewDate.value, 1)}
                                            selected={selected.value}
                                            hover={picking.value === "end" ? hoverIso.value : ""}
                                            min={minIso.value}
                                            max={maxIso.value}
                                            locale={locale.value}
                                            pick={onPick}
                                            hoverDay={(iso: string) => {
                                                if (picking.value === "end") hoverIso.value = iso;
                                            }}
                                            viewChange={(next: Date) => (viewDate.value = next)}
                                        />
                                    </div>
                                </div>

                                <div class="pg-date-range__footer">
                                    <span class="pg-date-range__summary" dir="ltr">
                                        {draft.value.start
                                            ? `${draft.value.start} → ${draft.value.end || draft.value.start}`
                                            : t("Select dates")}
                                    </span>
                                    <div class="pg-date-range__actions">
                                        <button
                                            type="button"
                                            class="pg-btn pg-btn--sm pg-btn--text"
                                            onClick={clear}
                                        >
                                            {t("Clear")}
                                        </button>
                                        <button
                                            type="button"
                                            class="pg-btn pg-btn--sm pg-btn--text"
                                            onClick={cancel}
                                        >
                                            {t("Cancel")}
                                        </button>
                                        <button
                                            type="button"
                                            class="pg-btn pg-btn--sm pg-btn--primary"
                                            onClick={() => applyRange(draft.value, true)}
                                        >
                                            {t("Apply")}
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    ),
                )}
            </PgFieldShell>
        );
    },
    {
        props: {
            modelValue: { type: [Object, Array, String], default: null },
            label: { type: String, default: "" },
            hint: { type: String, default: "" },
            error: { type: String, default: "" },
            errorMessages: { type: [Array, String], default: undefined },
            placeholder: { type: String, default: "" },
            min: { type: [String, Date], default: undefined },
            max: { type: [String, Date], default: undefined },
            presets: { type: Array as () => RangePreset[], default: undefined },
            clearable: { type: Boolean, default: true },
            autoApply: { type: Boolean, default: false },
            disabled: { type: Boolean, default: false },
            readonly: { type: Boolean, default: false },
            required: { type: Boolean, default: false },
            size: { type: String, default: "md" },
            density: { type: String, default: "" },
            prependInnerIcon: { type: String, default: "" },
            rules: { type: Array as () => Array<(value: any) => any>, default: () => [] },
            hideDetails: { type: Boolean, default: false },
            id: { type: String, default: "" },
        },
        emits: ["update:modelValue", "change", "apply", "clear"],
        inheritAttrs: true,
    },
);

export const VDateInput = PgDateInput;
export const VDateRangeInput = PgDateRangeInput;
export const DateInput = PgDateInput;
