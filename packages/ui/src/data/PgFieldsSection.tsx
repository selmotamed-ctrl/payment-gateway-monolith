import { dc } from "../lib/dc";
import { PgField, type PgFieldItem } from "./PgField";
import { PgCard } from "../layout/PgLayout";
import { PgDivider } from "../actions/PgFeedbackAtoms";

export interface PgFieldSection {
    title?: string;
    description?: string;
    fields: PgFieldItem[];
    defaultExpanded?: boolean;
}

/**
 * Spacious read-only detail sections. Long lists are grouped into two columns on
 * desktop and one on mobile, each section inside the standard card surface.
 */
export const PgFieldsSection = dc(
    (props: { sections: PgFieldSection[]; collapsible?: boolean; noElevation?: boolean }, _expose, { attrs }) => {
        return () => {
            const sections = (props.sections ?? []).filter((section) => section.fields?.length);
            return (
                <div {...attrs} class={["pg-fields-sections", attrs.class].filter(Boolean).join(" ")}>
                    {sections.map((section, index) => (
                        <PgCard key={`${section.title ?? "section"}-${index}`} title={section.title} subtitle={section.description}>
                            <div class="pg-fields-sections__body">
                                {section.fields.map((field, fieldIndex) => (
                                    <div key={`${field.text}-${fieldIndex}`} class="pg-fields-sections__row">
                                        <PgField {...field} />
                                        {fieldIndex < section.fields.length - 1 && <PgDivider />}
                                    </div>
                                ))}
                            </div>
                        </PgCard>
                    ))}
                </div>
            );
        };
    },
    {
        props: {
            sections: { type: Array as () => PgFieldSection[], default: () => [] },
            collapsible: { type: Boolean, default: false },
            noElevation: { type: Boolean, default: false },
        },
        inheritAttrs: true,
    },
);

export const FieldsSections = PgFieldsSection;

/** Title + subtitle + responsive field grid (the old `SectionFields`). */
export const PgSectionFields = dc(
    (props: { title?: string; subtitle?: string; layout?: "stacked" | "split"; columns?: number }, _expose, { attrs, slots }) => () => (
        <section {...attrs} class={["pg-section-fields", props.layout === "split" ? "pg-section-fields--split" : "", attrs.class].filter(Boolean).join(" ")}>
            {(props.title || props.subtitle) && (
                <div class="pg-section-fields__intro">
                    {props.title && <h3 class="pg-section-title">{props.title}</h3>}
                    {props.subtitle && <p class="pg-section-description">{props.subtitle}</p>}
                </div>
            )}
            <div class="pg-section-fields__body" style={{ gridTemplateColumns: props.columns === 1 ? "1fr" : undefined }}>
                {slots.default?.()}
            </div>
            {slots.footer && <div class="pg-section-fields__footer">{slots.footer()}</div>}
        </section>
    ),
    {
        props: {
            title: { type: String, default: "" },
            subtitle: { type: String, default: "" },
            layout: { type: String, default: "stacked" },
            columns: { type: Number, default: 2 },
        },
        inheritAttrs: true,
    },
);

export const SectionFields = PgSectionFields;
