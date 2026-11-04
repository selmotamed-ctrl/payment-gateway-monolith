import { defineComponent, type PropType } from "vue";
import { useRouter } from "vue-router";
import { useLocale } from "vuetify";
import { isArticleOpened, markArticleOpened } from "./readingOpened";

/** "Read now" list. Articles open in a new tab so check answers on the lesson page survive. */
export const ReadingList = defineComponent({
    name: "AcademyReadingList",
    props: {
        ids: { type: Array as PropType<string[]>, required: true },
        titles: { type: Object as PropType<Record<string, string>>, default: () => ({}) },
        isRead: { type: Function as PropType<(id: string) => boolean>, required: true },
    },
    setup(props) {
        const { t } = useLocale();
        const router = useRouter();
        return () => (
            <section class="ac-card" aria-labelledby="ac-reading-h">
                <h2 id="ac-reading-h" class="ac-h2">{t("Read now")}</h2>
                {props.ids.length === 0 ? (
                    <p class="ac-muted">{t("No reading for this lesson.")}</p>
                ) : (
                    <ul class="ac-list">
                        {props.ids.map((id) => {
                            const read = props.isRead(id);
                            const opened = isArticleOpened(id);
                            const href = router.resolve({ name: "AdminGuideArticle", params: { articleId: id } }).href;
                            return (
                                <li key={id} class="ac-row">
                                    <span class={["ac-state", read || opened ? "ac-state--done" : ""]} aria-hidden="true">
                                        {read ? "✓" : opened ? "◐" : "○"}
                                    </span>
                                    <a href={href} target="_blank" rel="noopener" onClick={() => markArticleOpened(id)}>
                                        {props.titles[id] ?? id}
                                    </a>
                                    <span class="ac-muted ac-grow-end">
                                        {read ? t("Read") : opened ? t("Opened") : t("Not opened yet")}
                                    </span>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </section>
        );
    },
});
