import { computed } from "vue";
import { dc } from "../lib/dc";
import { PgField, type PgFieldItem } from "./PgField";

export interface PgFieldSection {
    title?: string;
    subtitle?: string;
    description?: string;
    fields: PgFieldItem[];
    defaultExpanded?: boolean;
}

const clampColumns = (value: number | undefined): 2 | 3 | 4 => {
    if (value === 2 || value === 4) return value;
    return 3;
};

const fillerCount = (count: number, columns: number): number => {
    if (!count) return 0;
    const remainder = count % columns;
    return remainder === 0 ? 0 : columns - remainder;
};

/**
 * Seamless hairline field grid.
 *
 * The outer frame paints `--pg-border-subtle`; `gap: 1px` exposes it as a razor
 * sharp divider between tiles, each of which paints its own surface. Uneven
 * last rows are completed with filler cells so no exposed border-colour block
 * ever appears. No per-field divider elements are rendered.
 */
export const PgFieldsSection = dc(
    (
        props: {
            sections?: PgFieldSection[];
            fields?: PgFieldItem[];
            title?: string;
            subtitle?: string;
            columns?: 2 | 3 | 4;
            split?: boolean;
            collapsible?: boolean;
            noElevation?: boolean;
        },
        _expose,
        { attrs, slots },
    ) => {
        const columns = computed(() => clampColumns(props.columns));
        const sections = computed<PgFieldSection[]>(() =>
            props.sections && props.sections.length
                ? props.sections.filter((section) => section.fields?.length)
                : [
                      {
                          title: props.title,
                          subtitle: props.subtitle,
                          fields: props.fields ?? [],
                      },
                  ],
        );
        const hasDefaultSlot = Boolean(slots.default);
        return () => (
            <div
                {...attrs}
                class={["pg-fields-sections", props.split ? "pg-fields-sections--split" : "", attrs.class]
                    .filter(Boolean)
                    .join(" ")}
            >
                {sections.value.map((section, sectionIndex) => {
                    const fields = section.fields ?? [];
                    const hasHeader = Boolean(
                        section.title || section.subtitle || section.description || (sectionIndex === 0 && slots.actions),
                    );
                    const fillers = fillerCount(fields.length, columns.value);
                    return (
                        <section key={`${section.title ?? "section"}-${sectionIndex}`} class="pg-fields-section">
                            {hasHeader && (
                                <div class="pg-fields-section__header">
                                    <div class="pg-fields-section__intro">
                                        {section.title && <h3 class="pg-fields-section__title">{section.title}</h3>}
                                        {(section.subtitle || section.description) && (
                                            <p class="pg-fields-section__subtitle">{section.subtitle || section.description}</p>
                                        )}
                                    </div>
                                    {sectionIndex === 0 && slots.actions && <div class="pg-fields-section__actions">{slots.actions()}</div>}
                                </div>
                            )}
                            {(fields.length > 0 || (hasDefaultSlot && sections.value.length === 1)) && (
                                <div class="pg-field-grid" data-cols={String(columns.value)}>
                                    {fields.map((field, fieldIndex) => (
                                        <PgField key={`${field.label ?? field.text ?? "field"}-${fieldIndex}`} {...field} />
                                    ))}
                                    {sections.value.length === 1 && hasDefaultSlot ? slots.default?.() : null}
                                    {Array.from({ length: fillers }, (_, index) => (
                                        <div key={`filler-${index}`} class="pg-field-grid__filler" aria-hidden="true" />
                                    ))}
                                </div>
                            )}
                        </section>
                    );
                })}
                {sections.value.length > 1 && hasDefaultSlot && (
                    <div class="pg-fields-sections__extra">{slots.default?.()}</div>
                )}
            </div>
        );
    },
    {
        props: {
            sections: { type: Array as () => PgFieldSection[], default: () => [] },
            fields: { type: Array as () => PgFieldItem[], default: () => [] },
            title: { type: String, default: "" },
            subtitle: { type: String, default: "" },
            columns: { type: Number, default: 3 },
            split: { type: Boolean, default: false },
            collapsible: { type: Boolean, default: false },
            noElevation: { type: Boolean, default: false },
        },
        slots: ["default", "actions"],
        inheritAttrs: true,
    },
);

export const FieldsSections = PgFieldsSection;

/**
 * Title + subtitle + actions wrapper used by drawers and dialogs. When `fields`
 * is supplied it renders the same seamless hairline grid; otherwise the default
 * slot keeps the existing spacious form grid (editable `FormField` children).
 */
export const PgSectionFields = dc(
    (
        props: {
            title?: string;
            subtitle?: string;
            layout?: "stacked" | "split";
            columns?: number;
            fields?: PgFieldItem[];
        },
        _expose,
        { attrs, slots },
    ) => {
        const hasFields = computed(() => Boolean(props.fields?.length));
        const columns = computed(() => clampColumns(props.columns as 2 | 3 | 4));
        return () => (
            <section
                {...attrs}
                class={[
                    "pg-section-fields",
                    props.layout === "split" ? "pg-section-fields--split" : "",
                    attrs.class,
                ]
                    .filter(Boolean)
                    .join(" ")}
            >
                {(props.title || props.subtitle || slots.actions) && (
                    <div class="pg-section-fields__intro">
                        <div>
                            {props.title && <h3 class="pg-section-title">{props.title}</h3>}
                            {props.subtitle && <p class="pg-section-description">{props.subtitle}</p>}
                        </div>
                        {slots.actions && <div class="pg-section-fields__actions">{slots.actions()}</div>}
                    </div>
                )}
                {hasFields.value ? (
                    <div class="pg-field-grid" data-cols={String(columns.value)}>
                        {props.fields!.map((field, index) => (
                            <PgField key={`${field.label ?? field.text ?? "field"}-${index}`} {...field} />
                        ))}
                        {Array.from(
                            { length: fillerCount(props.fields!.length, columns.value) },
                            (_, index) => (
                                <div key={`filler-${index}`} class="pg-field-grid__filler" aria-hidden="true" />
                            ),
                        )}
                    </div>
                ) : (
                    <div
                        class="pg-section-fields__body"
                        data-columns={props.columns ? String(props.columns) : undefined}
                    >
                        {slots.default?.()}
                    </div>
                )}
                {slots.footer && <div class="pg-section-fields__footer">{slots.footer()}</div>}
            </section>
        );
    },
    {
        props: {
            title: { type: String, default: "" },
            subtitle: { type: String, default: "" },
            layout: { type: String, default: "stacked" },
            columns: { type: Number, default: 0 },
            fields: { type: Array as () => PgFieldItem[], default: () => [] },
        },
        slots: ["default", "actions", "footer"],
        inheritAttrs: true,
    },
);

export const SectionFields = PgSectionFields;
