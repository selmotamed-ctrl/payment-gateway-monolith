import type {
  AmlCaseRow,
  BeneficialOwnerRow,
  MerchantRow,
  Repositories,
  Severity,
  Tx,
} from "../db/ports";
import {
  buildScreeningSubject,
  type ScreeningListType,
  type ScreeningMatch,
  type ScreeningProvider,
  type ScreeningResult,
  type ScreeningResultCode,
  type ScreeningSubject,
  type ScreeningSubjectType,
} from "./ScreeningProvider";

export type ScreeningTrigger =
  | "ONBOARDING"
  | "PERIODIC"
  | "LIST_UPDATE"
  | "OWNER_CHANGE"
  | "TRANSACTION"
  | "MANUAL";

export type ScreeningSubjectKind = Extract<ScreeningSubjectType, "MERCHANT" | "BENEFICIAL_OWNER">;

export interface ScreeningSubjectSpec {
  subjectType: ScreeningSubjectKind;
  subjectId: string;
  names: readonly (string | null | undefined)[];
  dateOfBirth?: string | null;
  nationality?: string | null;
  identifier?: string | null;
  aliases?: readonly (string | null | undefined)[];
}

export interface ScreeningOutcome {
  screeningId: string;
  subjectType: ScreeningSubjectKind;
  subjectId: string;
  result: ScreeningResultCode;
  matches: ScreeningMatch[];
  highestScore: number | null;
  inputHash: string;
  providerCode: string;
}

export interface MerchantScreeningReport {
  merchantId: string;
  /** The strongest result across the merchant and its beneficial owners. */
  result: ScreeningResultCode;
  outcomes: ScreeningOutcome[];
  confirmedMatches: ScreeningMatch[];
  potentialMatches: ScreeningMatch[];
}

export interface MerchantScreeningServiceDeps {
  repositories: Repositories;
  screening: ScreeningProvider;
  clock?: () => Date;
}

export interface ScreenMerchantInput {
  merchantId: string;
  trigger: ScreeningTrigger;
  subjects: readonly ScreeningSubjectSpec[];
}

export interface OnboardingScreeningInput {
  merchant: MerchantRow;
  joinRequestId: string;
  owners: readonly BeneficialOwnerRow[];
  decryptedOwnerIdentifiers?: ReadonlyMap<string, string | null>;
}

export interface OnboardingScreeningOutcome {
  merchantId: string;
  /** The screening of the merchant itself, linked to the join request. */
  screeningId: string | null;
  result: ScreeningResultCode;
  /** A confirmed match blocks the activation of the merchant. */
  blocked: boolean;
  /**
   * The screening provider was unavailable for at least one subject. The
   * onboarding is parked in review until a clean screening is obtained; it is
   * never treated as a clean result (design §20, edge case 124).
   */
  screeningUnavailable: boolean;
  amlCaseId: string | null;
  /** The status the join request ended up in. */
  joinRequestStatus: string;
  report: MerchantScreeningReport;
}

/**
 * A confirmed sanctions hit is the most severe outcome of the screening
 * program. Every other confirmed list (PEP, adverse media, the internal
 * watch list) is a high severity case.
 */
export const CONFIRMED_MATCH_SEVERITY: Record<ScreeningListType, Severity> = {
  SANCTIONS: "CRITICAL",
  PEP: "HIGH",
  ADVERSE_MEDIA: "HIGH",
  INTERNAL_WATCHLIST: "HIGH",
};

export const severitySlaHours = (severity: Severity): number =>
  severity === "CRITICAL" ? 4 : severity === "HIGH" ? 24 : severity === "MEDIUM" ? 72 : 120;


const jsonSafe = (value: unknown): unknown => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((entry) => jsonSafe(entry));
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) {
        continue;
      }
      output[key] = jsonSafe(entry);
    }
    return output;
  }
  return String(value);
};

const ownerIdentifier = (decrypted: string | null): string | null => {
  if (decrypted && decrypted.trim().length > 0) {
    return decrypted.trim();
  }
  return null;
};

const ownerDateOfBirth = (owner: BeneficialOwnerRow): string | null =>
  owner.dateOfBirth ? owner.dateOfBirth.toISOString().slice(0, 10) : null;

/**
 * Builds the screening subjects of a merchant and its beneficial owners.
 *
 * The merchant and every owner are screened as separate subjects, so that a
 * hit on a single owner is attributable and so that the case can name the
 * subject that triggered it.
 */
export const merchantScreeningSubjects = (
  merchant: MerchantRow,
  owners: readonly BeneficialOwnerRow[],
  decryptedOwnerIdentifiers: ReadonlyMap<string, string | null> = new Map(),
): ScreeningSubjectSpec[] => {
  const subjects: ScreeningSubjectSpec[] = [
    {
      subjectType: "MERCHANT",
      subjectId: merchant.id,
      names: [merchant.legalName, merchant.tradeName],
      identifier: merchant.registrationNo ?? merchant.taxId,
      aliases: [merchant.taxId, merchant.registrationNo],
    },
  ];
  for (const owner of owners) {
    if (!owner.active) {
      continue;
    }
    subjects.push({
      subjectType: "BENEFICIAL_OWNER",
      subjectId: owner.id,
      names: [owner.fullNameAr, owner.fullNameEn],
      dateOfBirth: ownerDateOfBirth(owner),
      nationality: owner.nationality,
      identifier: ownerIdentifier(decryptedOwnerIdentifiers.get(owner.id) ?? null),
    });
  }
  return subjects;
};

/**
 * The screening service of the 7-layer AML program.
 *
 * L1 (onboarding) and L2 (periodic re-screening) share it, so the screening
 * record, the match records and the AML case are always written the same
 * way, whatever triggered the screening.
 */
export class MerchantScreeningService {
  private readonly repositories: Repositories;
  private readonly screening: ScreeningProvider;
  private readonly clock: () => Date;

  constructor(deps: MerchantScreeningServiceDeps) {
    this.repositories = deps.repositories;
    this.screening = deps.screening;
    this.clock = deps.clock ?? (() => new Date());
  }

  /**
   * Screens every subject and persists the screening record with its match
   * records. It never raises a case on its own: the caller decides what a
   * match means for the flow it belongs to.
   */
  async screenMerchant(tx: Tx, input: ScreenMerchantInput): Promise<MerchantScreeningReport> {
    const now = this.clock();
    const outcomes: ScreeningOutcome[] = [];
    const confirmedMatches: ScreeningMatch[] = [];
    const potentialMatches: ScreeningMatch[] = [];

    for (const spec of input.subjects) {
      const subject = buildScreeningSubject({
        subjectType: spec.subjectType,
        subjectId: spec.subjectId,
        names: spec.names,
        dateOfBirth: spec.dateOfBirth ?? null,
        nationality: spec.nationality ?? null,
        identifier: spec.identifier ?? null,
        aliases: spec.aliases ?? [],
      });
      const result = await this.screening.screenSubject(subject, {
        purpose: `AML_${input.trigger}`,
      });
      const outcome = await this.persistOutcome(tx, {
        spec,
        subject,
        result,
        trigger: input.trigger,
        now,
      });
      outcomes.push(outcome);
      if (result.result === "CONFIRMED_MATCH") {
        confirmedMatches.push(...result.matches);
      } else if (result.result === "POTENTIAL_MATCH") {
        potentialMatches.push(...result.matches);
      }
    }

    return {
      merchantId: input.merchantId,
      result: strongestResult(outcomes.map((outcome) => outcome.result)),
      outcomes,
      confirmedMatches,
      potentialMatches,
    };
  }

  /**
   * The onboarding submission (L1).
   *
   * The merchant and its beneficial owners are screened against the watch
   * list, the screening is linked to the join request and a confirmed match
   * raises the AML case and blocks the activation. A merchant that is not
   * blocked is submitted for review.
   */
  async submitOnboarding(tx: Tx, input: OnboardingScreeningInput): Promise<OnboardingScreeningOutcome> {
    const now = this.clock();
    const report = await this.screenMerchant(tx, {
      merchantId: input.merchant.id,
      trigger: "ONBOARDING",
      subjects: merchantScreeningSubjects(
        input.merchant,
        input.owners,
        input.decryptedOwnerIdentifiers ?? new Map(),
      ),
    });
    await this.applyOwnerScreeningStatuses(tx, input.owners, report);

    const merchantScreening = report.outcomes.find(
      (outcome) => outcome.subjectType === "MERCHANT",
    );
    const screeningId = merchantScreening?.screeningId ?? null;

    // A provider error is not a clean result. The request is parked in review
    // and the caller refuses the submission, so an unavailable screening can
    // never let an applicant through (design §20, edge case 124).
    if (report.result === "ERROR") {
      await this.repositories.onboarding.updateJoinRequest(tx, input.joinRequestId, {
        screeningId,
        status: "IN_REVIEW",
      });
      await this.repositories.governance.writeAuditLog(tx, {
        actorId: null,
        role: "SYSTEM",
        action: "MERCHANT_ONBOARDING_SCREENING_UNAVAILABLE",
        entityType: "MERCHANT",
        entityId: input.merchant.id,
        afterJson: {
          screening_id: screeningId,
          trigger: "ONBOARDING",
          failed_subjects: report.outcomes
            .filter((outcome) => outcome.result === "ERROR")
            .map((outcome) => ({
              subject_type: outcome.subjectType,
              subject_id: outcome.subjectId,
              provider_code: outcome.providerCode,
            })),
          source: "ONBOARDING_SCREENING",
        },
      });
      return {
        merchantId: input.merchant.id,
        screeningId,
        result: report.result,
        blocked: true,
        screeningUnavailable: true,
        amlCaseId: null,
        joinRequestStatus: "IN_REVIEW",
        report,
      };
    }

    if (report.result !== "CONFIRMED_MATCH") {
      await this.repositories.onboarding.updateJoinRequest(tx, input.joinRequestId, {
        screeningId,
        status: "SUBMITTED",
        submittedAt: now,
      });
      return {
        merchantId: input.merchant.id,
        screeningId,
        result: report.result,
        blocked: false,
        screeningUnavailable: false,
        amlCaseId: null,
        joinRequestStatus: "SUBMITTED",
        report,
      };
    }

    const amlCase = await this.raiseConfirmedMatchCase(tx, report, { now });
    await this.repositories.onboarding.updateJoinRequest(tx, input.joinRequestId, {
      status: "REJECTED",
      decision: "REJECTED",
      decisionReasonCode: "AML_CONFIRMED_MATCH",
      decisionNotes: "The onboarding screening produced a confirmed watch list match.",
      screeningId,
    });
    await this.repositories.merchants.updateMerchant(tx, input.merchant.id, {
      status: "REJECTED",
    });
    await this.repositories.governance.writeAuditLog(tx, {
      actorId: null,
      role: "SYSTEM",
      action: "MERCHANT_ONBOARDING_BLOCKED",
      entityType: "MERCHANT",
      entityId: input.merchant.id,
      afterJson: {
        screening_id: screeningId,
        aml_case_id: amlCase?.id ?? null,
        trigger_reason: amlCase?.triggerReason ?? null,
        severity: amlCase?.severity ?? null,
        source: "ONBOARDING_SCREENING",
      },
    });

    return {
      merchantId: input.merchant.id,
      screeningId,
      result: report.result,
      blocked: true,
      screeningUnavailable: false,
      amlCaseId: amlCase?.id ?? null,
      joinRequestStatus: "REJECTED",
      report,
    };
  }

  /**
   * Reflects the screening result on the beneficial owner records, so that
   * the KYB queue shows which owner is still to be reviewed.
   */
  async applyOwnerScreeningStatuses(
    tx: Tx,
    owners: readonly BeneficialOwnerRow[],
    report: MerchantScreeningReport,
  ): Promise<void> {
    for (const outcome of report.outcomes) {
      if (outcome.subjectType !== "BENEFICIAL_OWNER") {
        continue;
      }
      const status =
        outcome.result === "CONFIRMED_MATCH"
          ? "CONFIRMED_MATCH"
          : outcome.result === "POTENTIAL_MATCH"
            ? "POTENTIAL_MATCH"
            : outcome.result === "ERROR"
              ? "NOT_SCREENED"
              : "CLEAR";
      const owner = owners.find((entry) => entry.id === outcome.subjectId);
      if (!owner || owner.screeningStatus === status) {
        continue;
      }
      await this.repositories.onboarding.updateBeneficialOwner(tx, owner.id, {
        screeningStatus: status,
      });
    }
  }

  /**
   * Raises the AML case of a confirmed match. A potential match never raises a
   * case: it is reviewed by the compliance officer in the screening queue.
   */
  async raiseConfirmedMatchCase(
    tx: Tx,
    report: MerchantScreeningReport,
    options: { now?: Date; triggerReasonPrefix?: string } = {},
  ): Promise<AmlCaseRow | null> {
    if (report.result !== "CONFIRMED_MATCH" || report.confirmedMatches.length === 0) {
      return null;
    }
    const now = options.now ?? this.clock();
    const listTypes = [...new Set(report.confirmedMatches.map((match) => match.listType))];
    const severity = listTypes.reduce<Severity>(
      (worst, listType) =>
        severityRank(CONFIRMED_MATCH_SEVERITY[listType] ?? "HIGH") > severityRank(worst)
          ? CONFIRMED_MATCH_SEVERITY[listType] ?? "HIGH"
          : worst,
      "MEDIUM",
    );
    const screeningId =
      report.outcomes.find((outcome) => outcome.result === "CONFIRMED_MATCH")?.screeningId ?? null;
    const subject = report.outcomes.find((outcome) => outcome.result === "CONFIRMED_MATCH");

    return this.repositories.risk.createAmlCase(tx, {
      subjectType: "MERCHANT",
      subjectId: report.merchantId,
      triggerReason: `${options.triggerReasonPrefix ?? "SCREENING_CONFIRMED_MATCH"}:${listTypes.join(",")}`,
      severity,
      severityInputsJson: {
        screening_id: screeningId,
        subject_type: subject?.subjectType ?? "MERCHANT",
        subject_id: subject?.subjectId ?? report.merchantId,
        list_types: listTypes,
        highest_score: report.outcomes
          .map((outcome) => outcome.highestScore)
          .filter((score): score is number => score !== null)
          .reduce((max, score) => Math.max(max, score), 0),
        matches: report.confirmedMatches.map((match) => ({
          list_type: match.listType,
          list_name: match.listName,
          list_entry_ref: match.listEntryRef,
          matched_name: match.matchedName,
          score: match.score,
        })),
      },
      screeningId,
      status: "OPEN",
      slaDueAt: new Date(now.getTime() + severitySlaHours(severity) * 60 * 60 * 1000),
      confidential: true,
    });
  }

  private async persistOutcome(
    tx: Tx,
    input: {
      spec: ScreeningSubjectSpec;
      subject: ScreeningSubject;
      result: ScreeningResult;
      trigger: ScreeningTrigger;
      now: Date;
    },
  ): Promise<ScreeningOutcome> {
    const screening = await this.repositories.risk.createScreening(tx, {
      subjectType: input.spec.subjectType,
      subjectId: input.spec.subjectId,
      trigger: input.trigger,
      providerCode: input.result.providerCode,
      providerRequestRef: input.result.providerRequestRef,
      listVersionsJson: jsonSafe(input.result.listVersions),
      inputHash: input.result.inputHash,
      result: input.result.result,
      matchCount: input.result.matches.length,
      highestScore:
        input.result.highestScore === null ? null : input.result.highestScore.toFixed(2),
      requestedAt: input.now,
      completedAt: input.now,
    });

    for (const match of input.result.matches) {
      await this.repositories.risk.createScreeningMatch(tx, {
        screeningId: screening.id,
        listType: match.listType,
        listName: match.listName,
        listEntryRef: match.listEntryRef,
        matchedName: match.matchedName,
        score: match.score.toFixed(2),
        attributesJson: jsonSafe(match.attributes ?? {}),
        disposition: "UNREVIEWED",
      });
    }

    return {
      screeningId: screening.id,
      subjectType: input.spec.subjectType,
      subjectId: input.spec.subjectId,
      result: input.result.result,
      matches: input.result.matches,
      highestScore: input.result.highestScore,
      inputHash: input.result.inputHash,
      providerCode: input.result.providerCode,
    };
  }
}

const severityRank = (severity: Severity): number =>
  severity === "CRITICAL" ? 3 : severity === "HIGH" ? 2 : severity === "MEDIUM" ? 1 : 0;

/**
 * The strongest result of a multi-subject screening.
 *
 * A confirmed match is the most severe outcome and always wins. Otherwise an
 * ERROR dominates every non-confirmed result: an unavailable provider must
 * never be masked by a CLEAR result of another subject (fail closed).
 */
const strongestResult = (results: readonly ScreeningResultCode[]): ScreeningResultCode => {
  if (results.includes("CONFIRMED_MATCH")) {
    return "CONFIRMED_MATCH";
  }
  if (results.includes("ERROR")) {
    return "ERROR";
  }
  if (results.includes("POTENTIAL_MATCH")) {
    return "POTENTIAL_MATCH";
  }
  return "CLEAR";
};
