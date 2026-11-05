/**
 * Every lesson body ends with two structural sections that the page renders as dedicated UI instead:
 * `### Read now` (a list of Guide links, shown as the "Read now" card with open/read tracking) and
 * `### Check yourself` (a list of check ids, shown as the practice-check cards). Rendering them inside
 * the prose would duplicate the links and expose raw ids, so the prose stops at the first of them.
 * The content itself is never edited or retyped; this only trims what is displayed.
 */
const STRUCTURAL = /^#{2,3}[ \t]+(?:Read now|Check yourself)[ \t]*$/im;

export const lessonProse = (body: string): string => {
    const match = STRUCTURAL.exec(body);
    return (match ? body.slice(0, match.index) : body).trimEnd();
};
