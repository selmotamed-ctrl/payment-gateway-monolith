import { defineComponent, type PropType } from "vue";
import { useRouter } from "vue-router";
import { useLocale } from "vuetify";
import { VIcon } from "vuetify/components";
import { StateIcon } from "./ui/StateIcon";
import { isArticleOpened, markArticleOpened } from "./readingOpened";

/**
 * "Read now" list. Articles open in a new tab so check answers on the lesson page survive.
 * The section is a region named "Read now" (the e2e specs and the keyboard-order spec rely on it).
 */
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
            <section class="ac-card ac-lesson-reading" aria-labelledby="ac-reading-h">
                <div class="ac-lesson-head">
                    <h2 id="ac-reading-h" class="ac-h2">
                        {t("Read now")}
                    </h2>
                    {props.ids.length > 0 && <p class="ac-muted">{t("Articles open in a new tab, so your answers on this page are kept.")}</p>}
                </div>
                {props.ids.length === 0 ? (
                    <p class="ac-muted ac-lesson-empty">{t("No reading for this lesson.")}</p>
                ) : (
                    <ul class="ac-steps ac-steps--flush ac-lesson-list" role="list">
                        {props.ids.map((id) => {
                            const read = props.isRead(id);
                            const opened = isArticleOpened(id);
                            const href = router.resolve({ name: "AdminGuideArticle", params: { articleId: id } }).href;
                            return (
                                <li key={id} class="ac-step">
                                    <StateIcon state={read ? "done" : opened ? "partial" : "todo"} />
                                    <span class="ac-step__main">
                                        <a class="ac-step__title ac-lesson-link" href={href} target="_blank" rel="noopener" dir="auto" onClick={() => markArticleOpened(id)}>
                                            {props.titles[id] ?? id}
                                            <VIcon class="ac-lesson-link__icon" icon="mdi-open-in-new" size={14} aria-hidden="true" />
                                        </a>
                                    </span>
                                    <span class={["ac-step__meta", read ? "ac-lesson-state--read" : ""]}>
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
