import { defineComponent, nextTick, onBeforeUnmount, onMounted, ref, watch, type PropType } from "vue";
import { useRouter } from "vue-router";
import type { Term } from "@/content/guide";

export const GlossaryPopover = defineComponent({
    name: "GlossaryPopover",
    props: {
        term: { type: Object as PropType<Term | null>, default: null },
        anchor: { type: Object as PropType<DOMRect | null>, default: null },
        termsBySlug: {
            type: Object as PropType<Map<string, Term>>,
            default: () => new Map<string, Term>(),
        },
        onClose: { type: Function as PropType<() => void>, required: true },
    },
    setup(props) {
        const router = useRouter();
        const panel = ref<HTMLElement | null>(null);
        const closeButton = ref<HTMLButtonElement | null>(null);

        const position = ref({ top: 80, left: 80 });

        const updatePosition = () => {
            const rect = props.anchor;
            const width = 360;
            const height = 260;
            if (!rect) {
                position.value = {
                    top: Math.max(16, window.innerHeight / 2 - height / 2),
                    left: Math.max(16, window.innerWidth / 2 - width / 2),
                };
                return;
            }
            const left = Math.min(
                Math.max(12, rect.left),
                Math.max(12, window.innerWidth - width - 12),
            );
            const preferredTop = rect.bottom + 8;
            const top =
                preferredTop + height > window.innerHeight
                    ? Math.max(12, rect.top - height - 8)
                    : preferredTop;
            position.value = { top, left };
        };

        const focusables = (): HTMLElement[] => {
            const root = panel.value;
            if (!root) return [];
            return Array.from(
                root.querySelectorAll<HTMLElement>(
                    'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
                ),
            );
        };

        const onKeydown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                props.onClose();
                return;
            }
            if (event.key !== "Tab") return;
            const items = focusables();
            if (items.length === 0) return;
            const first = items[0];
            const last = items[items.length - 1];
            if (!first || !last) return;
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };

        watch(
            () => [props.term, props.anchor],
            async () => {
                updatePosition();
                await nextTick();
                closeButton.value?.focus();
            },
            { immediate: true },
        );

        onMounted(() => {
            window.addEventListener("resize", updatePosition);
            window.addEventListener("scroll", updatePosition, true);
        });
        onBeforeUnmount(() => {
            window.removeEventListener("resize", updatePosition);
            window.removeEventListener("scroll", updatePosition, true);
        });

        const openGlossary = () => {
            if (!props.term) return;
            const slug = props.term.slug;
            props.onClose();
            void router.push({ name: "AdminGuideGlossary", params: { slug } });
        };

        const openRelated = (slug: string) => {
            props.onClose();
            void router.push({ name: "AdminGuideGlossary", params: { slug } });
        };

        return () => {
            const term = props.term;
            if (!term) return null;
            return (
                <div class="guide-popover-layer" onClick={() => props.onClose()}>
                    <div
                        ref={panel}
                        class="guide-popover"
                        role="dialog"
                        aria-modal="false"
                        aria-label={term.term}
                        style={{
                            top: `${position.value.top}px`,
                            left: `${position.value.left}px`,
                        }}
                        onClick={(event: MouseEvent) => event.stopPropagation()}
                        onKeydown={onKeydown}
                    >
                        <div class="guide-popover__header">
                            <div>
                                <strong>{term.term}</strong>
                                {term.ar ? (
                                    <span class="guide-popover__arabic" dir="rtl" lang="ar">
                                        {term.ar}
                                    </span>
                                ) : null}
                            </div>
                            <button
                                ref={closeButton}
                                type="button"
                                class="guide-popover__close"
                                aria-label="Close glossary definition"
                                onClick={() => props.onClose()}
                            >
                                ×
                            </button>
                        </div>
                        <p class="guide-popover__short">{term.short}</p>
                        {term.aliases.length > 0 ? (
                            <p class="guide-popover__aliases">
                                Also: {term.aliases.join(", ")}
                            </p>
                        ) : null}
                        {term.related.length > 0 ? (
                            <div class="guide-popover__related">
                                <span>Related:</span>
                                {term.related.map((slug) => {
                                    const related = props.termsBySlug.get(slug);
                                    return (
                                        <button
                                            key={slug}
                                            type="button"
                                            class="guide-link-button"
                                            onClick={() => openRelated(slug)}
                                        >
                                            {related?.term ?? slug}
                                        </button>
                                    );
                                })}
                            </div>
                        ) : null}
                        <div class="guide-popover__footer">
                            <button type="button" class="guide-link-button" onClick={openGlossary}>
                                Open in glossary
                            </button>
                        </div>
                    </div>
                </div>
            );
        };
    },
});

export default GlossaryPopover;
