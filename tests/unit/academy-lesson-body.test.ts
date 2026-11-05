import { describe, expect, it } from "vitest";
import { lessonProse } from "@/components/academy/lessonBody";
import lessons from "../../admin-front/src/content/academy/generated/lessons.en.json";

describe("lessonProse", () => {
  it("stops before the structural Read now / Check yourself sections", () => {
    const body = "### Key ideas\n- one\n\n### Common mistakes\n- two\n\n### Read now\n- [[a:b00-01]]\n\n### Check yourself\nQuestions: c-1, c-2\n";
    expect(lessonProse(body)).toBe("### Key ideas\n- one\n\n### Common mistakes\n- two");
  });

  it("returns the body unchanged when there is nothing to strip", () => {
    expect(lessonProse("### Key ideas\n- one\n")).toBe("### Key ideas\n- one");
  });

  it("never shows raw check ids or the structural headings for any generated lesson", () => {
    for (const lesson of lessons as { id: string; body: string }[]) {
      const prose = lessonProse(lesson.body);
      expect(prose, lesson.id).not.toMatch(/^###\s+(Read now|Check yourself)/im);
      expect(prose, lesson.id).not.toMatch(/Questions:\s*c-/);
      expect(prose.length, lesson.id).toBeGreaterThan(200);
    }
  });
});
