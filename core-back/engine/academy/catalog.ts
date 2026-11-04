import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AcademyBadge, BankQuestion, Catalog, CatalogTrack, ExamBank, ExamBlueprint, TrackId } from "./types";

/**
 * Generated content (see `admin-front/scripts/extract-academy-content.ts`). Loaded once, relative to
 * this module: the whole `core-back/` tree ships with the release.
 */
const readJson = <T>(relative: string): T =>
  JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")) as T;

let cachedCatalog: Catalog | undefined;
let cachedBank: ExamBank | undefined;

export const loadCatalog = (): Catalog => (cachedCatalog ??= readJson<Catalog>("../../content/academy/catalog.json"));
export const loadExamBank = (): ExamBank => (cachedBank ??= readJson<ExamBank>("../../content/academy/exam-bank.json"));

export const trackOf = (catalog: Catalog, id: string): CatalogTrack | undefined => catalog.tracks.find((track) => track.id === id);
export const blueprintOf = (bank: ExamBank, examId: string): ExamBlueprint | undefined =>
  bank.blueprints.find((blueprint) => blueprint.id === examId);
export const questionIndex = (bank: ExamBank): Map<string, BankQuestion> => new Map(bank.questions.map((q) => [q.id, q]));

export const lessonIdSet = (catalog: Catalog): Set<string> => new Set(catalog.lessons.map((lesson) => lesson.id));
export const labIdSet = (catalog: Catalog): Set<string> => new Set(catalog.labs.map((lab) => lab.id));
export const lessonTitle = (catalog: Catalog, id: string): string => catalog.lessons.find((lesson) => lesson.id === id)?.title ?? id;
export const labOf = (catalog: Catalog, id: string) => catalog.labs.find((lab) => lab.id === id);
export const moduleTitle = (catalog: Catalog, id: string): string => catalog.modules.find((module) => module.id === id)?.title ?? id;

export const isTrackId = (catalog: Catalog, value: unknown): value is TrackId =>
  typeof value === "string" && catalog.tracks.some((track) => track.id === value);

export const majorOf = (version: string | undefined): number => {
  const value = Number.parseInt(String(version ?? "").split(".")[0] ?? "", 10);
  return Number.isFinite(value) ? value : 0;
};

/** Valid = not expired and not older (by major version) than `recertifyFrom`. */
export const isBadgeValid = (badge: AcademyBadge, catalog: Catalog, now: Date): boolean =>
  Date.parse(badge.expiresAt) > now.getTime() && majorOf(badge.v) >= majorOf(catalog.recertifyFrom);

/** `earnedAt` + 12 calendar months (UTC, day clamped to the end of a shorter month). */
export const addMonthsUtc = (from: Date, months: number): Date => {
  const target = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + months, 1, from.getUTCHours(), from.getUTCMinutes(), from.getUTCSeconds(), from.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(from.getUTCDate(), lastDay));
  return target;
};
