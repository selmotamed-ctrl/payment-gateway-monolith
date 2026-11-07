import {
    defineComponent,
    nextTick,
    onBeforeUnmount,
    onMounted,
    ref,
    watch,
    type PropType,
} from "vue";

export interface RefPreview {
    kindLabel: string;
    title: string;
    subtitle: string;
    body: string;
    href: string;
}

export const ReferencePreviewPopover = defineComponent({
    name: "ReferencePreviewPopover",
    props: {
        preview: { type: Object as PropType<RefPreview | null>, default: null },
        anchor: { type: Object as PropType<DOMRect | null>, default: null },
        onClose: { type: Function as PropType<() => void>, required: true },
        onOpen: { type: Function as PropType<(href: string) => void>, required: true },
    },
    setup(props) {
        const panel = ref<HTMLElement | null>(null);
        const closeButton = ref<HTMLButtonElement | null>(null);
        const position = ref({ top: 80, left: 80 });

        const updatePosition = () => {
            const rect = props.anchor;
            const width = 380;
            const height = 280;
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
            () => [props.preview, props.anchor],
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

        return () => {
            const preview = props.preview;
            if (!preview) return null;
            return (
                <div class="guide-popover-layer" onClick={() => props.onClose()}>
                    <div
                        ref={panel}
                        class="guide-popover guide-ref-preview"
                        role="dialog"
                        aria-modal="false"
                        aria-label={preview.title}
                        style={{
                            top: `${position.value.top}px`,
                            left: `${position.value.left}px`,
                        }}
                        onClick={(event: MouseEvent) => event.stopPropagation()}
                        onKeydown={onKeydown}
                    >
                        <div class="guide-popover__header">
                            <div>
                                <p class="guide-ref-preview__kind">{preview.kindLabel}</p>
                                <strong>{preview.title}</strong>
                            </div>
                            <button
                                ref={closeButton}
                                type="button"
                                class="guide-popover__close"
                                aria-label="Close reference preview"
                                onClick={() => props.onClose()}
                            >
                                ×
                            </button>
                        </div>
                        <p class="guide-ref-preview__subtitle">{preview.subtitle}</p>
                        <p class="guide-popover__short">{preview.body}</p>
                        <div class="guide-ref-preview__actions">
                            <button
                                type="button"
                                class="guide-link-button"
                                onClick={() => props.onClose()}
                            >
                                Stay here
                            </button>
                            <button
                                type="button"
                                class="guide-primary-button"
                                onClick={() => props.onOpen(preview.href)}
                            >
                                Read full page →
                            </button>
                        </div>
                    </div>
                </div>
            );
        };
    },
});

export default ReferencePreviewPopover;
