import { computed, defineComponent, type PropType } from "vue";
import type { ArticleHeading } from "@/content/guide";

export const ArticleToc = defineComponent({
    name: "ArticleToc",
    props: {
        headings: { type: Array as PropType<ArticleHeading[]>, default: () => [] },
    },
    setup(props) {
        const visible = computed(() => props.headings.filter((heading) => heading.level >= 2));
        const jump = (event: MouseEvent, id: string) => {
            event.preventDefault();
            const target = document.getElementById(id);
            target?.scrollIntoView({ behavior: "smooth", block: "start" });
            target?.focus?.();
        };
        return () => {
            if (visible.value.length === 0) return null;
            return (
                <nav class="guide-toc" aria-label="On this page">
                    <p class="guide-toc__title">On this page</p>
                    <ol>
                        {visible.value.map((heading) => (
                            <li
                                key={heading.id}
                                style={{ marginInlineStart: `${Math.max(0, heading.level - 2) * 10}px` }}
                            >
                                <a href={`#${heading.id}`} onClick={(event) => jump(event, heading.id)}>
                                    {heading.text}
                                </a>
                            </li>
                        ))}
                    </ol>
                </nav>
            );
        };
    },
});

export default ArticleToc;
