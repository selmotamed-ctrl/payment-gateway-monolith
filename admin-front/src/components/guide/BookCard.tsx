import { defineComponent, type PropType } from "vue";
import { RouterLink } from "vue-router";
import type { Book } from "@/content/guide";

export const BookCard = defineComponent({
    name: "BookCard",
    props: {
        book: { type: Object as PropType<Book>, required: true },
        articleCount: { type: Number, default: 0 },
        readCount: { type: Number, default: 0 },
    },
    setup(props) {
        return () => {
            const percent =
                props.articleCount > 0
                    ? Math.round((props.readCount / props.articleCount) * 100)
                    : 0;
            return (
                <RouterLink
                    class="guide-book-card"
                    to={{ name: "AdminGuideBook", params: { bookId: props.book.id } }}
                >
                    <div class="guide-book-card__top">
                        <span class="guide-book-card__number">Book {props.book.id}</span>
                        <span class="guide-book-card__progress" aria-label={`${percent}% read`}>
                            {props.readCount}/{props.articleCount}
                        </span>
                    </div>
                    <h3>{props.book.title}</h3>
                    <p class="guide-book-card__audience">{props.book.audience}</p>
                    <p class="guide-book-card__summary">{props.book.summary}</p>
                    <div class="guide-progress-track" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
                        <span style={{ width: `${percent}%` }} />
                    </div>
                </RouterLink>
            );
        };
    },
});

export default BookCard;
