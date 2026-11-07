import { describe, expect, test } from "vitest";
import {
    extractParentheticalRefs,
    firstProseParagraph,
    shortTitle,
} from "@/components/guide/markdownRefs";

describe("guide markdown reference clarity", () => {
    test("extracts pure parenthetical reference pointers", () => {
        expect(extractParentheticalRefs("The core shows methods ([[a:b02-06]]).")).toEqual({
            cleaned: "The core shows methods.",
            refs: [{ kind: "a", id: "b02-06", label: undefined }],
        });
        expect(extractParentheticalRefs("Ask the partner (see [[a:b07-03]]).").refs).toEqual([
            { kind: "a", id: "b07-03", label: undefined },
        ]);
        expect(
            extractParentheticalRefs("Check both (see [[a:b06-05]], [[a:b06-07]]).").refs,
        ).toHaveLength(2);
    });

    test("keeps meaningful parenthetical prose and removes only the pointer", () => {
        expect(
            extractParentheticalRefs(
                "The core decides which methods to show (called *rails*, see [[a:b02-06]]).",
            ),
        ).toEqual({
            cleaned: "The core decides which methods to show (called *rails*).",
            refs: [{ kind: "a", id: "b02-06", label: undefined }],
        });
    });

    test("keeps prose references such as 'you met her in' out of the sentence", () => {
        expect(
            extractParentheticalRefs("Layla pays Sadad (you met her in [[a:b01-01]])."),
        ).toEqual({
            cleaned: "Layla pays Sadad.",
            refs: [{ kind: "a", id: "b01-01", label: undefined }],
        });
    });

    test("short labels never dump a long article title", () => {
        expect(shortTitle("The visible-rails formula: why a customer sees a method")).toBe(
            "The visible-rails formula",
        );
        expect(shortTitle("The engine: ten phases, steps, side effects and the retry boundary")).toBe(
            "The engine",
        );
    });

    test("firstProseParagraph strips headings, links, callouts and widgets", () => {
        expect(
            firstProseParagraph(
                ":::summary Big picture\n## Heading\n\nThe amount comes from ([[a:b07-03|the link]]), not the customer.\n\n{{widget:visible-rails}}\n\nSecond paragraph.",
            ),
        ).toBe("The amount comes from (the link), not the customer.");
    });
});
