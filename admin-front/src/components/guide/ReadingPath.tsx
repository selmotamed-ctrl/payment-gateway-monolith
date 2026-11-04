import { defineComponent, type PropType } from "vue";
import { RouterLink } from "vue-router";
import type { ReadingPath as ReadingPathType, Article } from "@/content/guide";

export const ReadingPath = defineComponent({
    name: "ReadingPath",
    props: {
        path: { type: Object as PropType<ReadingPathType>, required: true },
        articles: { type: Object as PropType<Map<string, Article>>, required: true },
        readIds: { type: Object as PropType<Set<string>>, default: () => new Set<string>() },
    },
    setup(props) {
        return () => (
            <section class="guide-reading-path" aria-label={`${props.path.title} reading path`}>
                <header>
                    <h2>{props.path.title}</h2>
                    <span>{props.path.articles.length} articles</span>
                </header>
                <ol>
                    {props.path.articles.map((articleId, index) => {
                        const article = props.articles.get(articleId);
                        const read = props.readIds.has(articleId);
                        return (
                            <li key={articleId}>
                                <RouterLink
                                    to={{ name: "AdminGuideArticle", params: { articleId } }}
                                    class={read ? "guide-path-link guide-path-link--read" : "guide-path-link"}
                                >
                                    <span class="guide-path-step">{read ? "✓" : index + 1}</span>
                                    <span>{article?.title ?? articleId}</span>
                                    <small>{article?.minutes ?? 0} min</small>
                                </RouterLink>
                            </li>
                        );
                    })}
                </ol>
            </section>
        );
    },
});

export default ReadingPath;
