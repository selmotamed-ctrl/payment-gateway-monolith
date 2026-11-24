import { describe, expect, test } from "bun:test";
import { JOIN_REQUEST_CHECKLIST_KEYS } from "../lib/joinRequestOnboarding";
import { missingJoinRequestChecklistItems } from "../api/internal/admin";

describe("join request review checklist enforcement", () => {
  test("an empty checklist reports every required item", () => {
    expect(missingJoinRequestChecklistItems(null)).toEqual([...JOIN_REQUEST_CHECKLIST_KEYS]);
  });

  test("a partially completed checklist reports only the missing items", () => {
    const completed = Object.fromEntries(JOIN_REQUEST_CHECKLIST_KEYS.slice(1).map((key) => [key, true]));
    expect(missingJoinRequestChecklistItems(completed)).toEqual([JOIN_REQUEST_CHECKLIST_KEYS[0]]);
  });

  test("only explicit true values count as completed", () => {
    const completed = Object.fromEntries(JOIN_REQUEST_CHECKLIST_KEYS.map((key) => [key, "yes"]));
    expect(missingJoinRequestChecklistItems(completed)).toEqual([...JOIN_REQUEST_CHECKLIST_KEYS]);
  });

  test("a fully completed checklist has no missing items", () => {
    const completed = Object.fromEntries(JOIN_REQUEST_CHECKLIST_KEYS.map((key) => [key, true]));
    expect(missingJoinRequestChecklistItems(completed)).toEqual([]);
  });
});
