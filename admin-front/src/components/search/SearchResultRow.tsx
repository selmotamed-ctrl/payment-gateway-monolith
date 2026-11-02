import { defineComponent, type PropType, type VNodeChild } from "vue";
import { VIcon } from "vuetify/components";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { splitHighlightSegments } from "./highlight";

export function renderHighlightedText(
    text: string | undefined,
    query: string,
): VNodeChild {
    if (!text) {
        return null;
    }

    return splitHighlightSegments(text, query).map((part, index) =>
        part.highlighted ? (
            <mark key={index} class="pg-search-highlight">
                {part.text}
            </mark>
        ) : (
            part.text
        ),
    );
}

export const highlightSegments = renderHighlightedText;

export const SearchResultRow = defineComponent({
    name: "SearchResultRow",
    props: {
        id: { type: String, required: true },
        icon: { type: String, required: true },
        title: { type: String, required: true },
        subtitle: { type: String, default: undefined },
        reference: { type: String, default: undefined },
        status: { type: String, default: undefined },
        kindLabel: { type: String, required: true },
        query: { type: String, default: "" },
        active: { type: Boolean, default: false },
        onSelect: { type: Function as PropType<() => void>, required: true },
        onHover: { type: Function as PropType<() => void>, required: true },
    },
    setup(props) {
        return () => (
            <div
                id={props.id}
                role="option"
                aria-selected={props.active ? "true" : "false"}
                class={["pg-command-item", props.active ? "pg-command-item--active" : ""]}
                onClick={props.onSelect}
                onMouseenter={props.onHover}
            >
                <div class="pg-command-item__icon">
                    <VIcon icon={props.icon} size={18} />
                </div>

                <div class="pg-command-item__body">
                    <div class="pg-command-item__title-row">
                        <span class="pg-command-item__title">
                            {renderHighlightedText(props.title, props.query)}
                        </span>
                        {props.reference && (
                            <code class="pg-command-item__ref">
                                {renderHighlightedText(props.reference, props.query)}
                            </code>
                        )}
                    </div>
                    {props.subtitle && (
                        <div class="pg-command-item__subtitle">
                            {renderHighlightedText(props.subtitle, props.query)}
                        </div>
                    )}
                </div>

                <div class="pg-command-item__meta">
                    {props.status && <StatusBadge status={props.status} showDot={false} />}
                    <span class="pg-command-item__kind">{props.kindLabel}</span>
                    <VIcon
                        icon="mdi-keyboard-return"
                        size={14}
                        class="pg-command-item__enter-hint"
                    />
                </div>
            </div>
        );
    },
});

export default SearchResultRow;
