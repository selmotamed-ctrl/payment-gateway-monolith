import type { PrismaClient } from "../generated/prisma/client";
import {
  AdjustmentState,
  AmlCaseStatus,
  AmlScreeningResult,
  ApprovalState,
  AttemptStatus,
  CashoutState,
  DisputeStatus,
  GatewayInquiryScheduleStatus,
  GatewayStatus,
  JoinRequestStatus,
  KybDocumentStatus,
  MerchantStatus,
  OperatorCaseState,
  RegulatoryReportStatus,
  RouteStatus,
  UserStatus,
} from "../generated/prisma/client";
import { z } from "zod";
import {
  type AuthenticatedAdminActor,
  hasAllAuthorities,
  hasAnyAuthority,
  hasAuthority,
  hasConfidentialAmlAccess,
  hasMerchantSensitiveAccess,
} from "./auth/confidentialAccess";
import { ApiError, parseOrThrow } from "./error";
import {
  defineSearchProvider,
  parseSearchQuery,
  rankAndSliceCandidates,
  sanitizeResultItem,
  type ParsedSearchQuery,
  type SearchProviderPlugin,
} from "./search/engine";
import { extractSearchQueryTokens } from "./search/tokenIndex";
import type {
  GlobalSearchResponse,
  SearchResultGroup,
  SearchType,
} from "./search/types";

const compact = (values: Array<string | null | undefined>): string =>
  values.filter((value): value is string => Boolean(value)).join(" · ");

const amountText = (value: unknown): string => {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric.toFixed(2) : "0.00";
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const scopedStatusIn = <T extends string>(
  parsed: ParsedSearchQuery,
  allowed: Record<string, string>,
): T | undefined => {
  if (!parsed.scopedStatus) {
    return undefined;
  }
  return Object.values(allowed).includes(parsed.scopedStatus)
    ? (parsed.scopedStatus as T)
    : undefined;
};

type ErasedSearchProvider = SearchProviderPlugin<unknown>;

export class SearchProviderRegistry {
  private readonly providers = new Map<string, ErasedSearchProvider>();

  public register<TRow>(plugin: SearchProviderPlugin<TRow>): this {
    this.providers.set(plugin.type, {
      type: plugin.type,
      aliases: plugin.aliases,
      order: plugin.order,
      canAccess: plugin.canAccess,
      supportsTokenKind: plugin.supportsTokenKind,
      fetchCandidates: (context) => plugin.fetchCandidates(context),
      extractMatchSignals: (row, actor) =>
        plugin.extractMatchSignals(row as TRow, actor),
      toResultItem: (row, actor) => plugin.toResultItem(row as TRow, actor),
    });
    return this;
  }

  public unregister(type: SearchType): boolean {
    return this.providers.delete(type);
  }

  public get(type: SearchType): ErasedSearchProvider | undefined {
    return this.providers.get(type);
  }

  public getAllOrdered(): ErasedSearchProvider[] {
    return Array.from(this.providers.values()).sort((a, b) => {
      if (a.order !== b.order) {
        return a.order - b.order;
      }
      return a.type.localeCompare(b.type);
    });
  }

  public getRegisteredTypes(): Set<string> {
    return new Set(this.providers.keys());
  }

  public resolveAliasToTypes(alias: string): SearchType[] {
    const normalized = alias.toLowerCase().trim();
    const matches: SearchType[] = [];
    for (const plugin of this.providers.values()) {
      if (
        plugin.type.toLowerCase() === normalized ||
        plugin.aliases?.some(
          (candidate) => candidate.toLowerCase() === normalized,
        )
      ) {
        matches.push(plugin.type);
      }
    }
    return matches;
  }
}

export const defaultSearchRegistry = new SearchProviderRegistry();

export const registerSearchProvider = <TRow>(
  plugin: SearchProviderPlugin<TRow>,
  registry: SearchProviderRegistry = defaultSearchRegistry,
): SearchProviderPlugin<TRow> => {
  registry.register(plugin);
  return plugin;
};

export const merchantProvider = defineSearchProvider({
  type: "merchant",
  aliases: ["merchants", "mer", "store"],
  order: 10,
  canAccess: (actor) => hasAuthority(actor, "merchant:read"),
  fetchCandidates: async ({ prisma, parsed, actor, take }) => {
    const query = parsed.term;
    const status = scopedStatusIn<MerchantStatus>(parsed, MerchantStatus);
    const allowSensitive = hasMerchantSensitiveAccess(actor);
    return prisma.merchant.findMany({
      where: {
        ...(status ? { status } : {}),
        OR: [
          { id: { contains: query } },
          { legalName: { contains: query } },
          { tradeName: { contains: query } },
          { displayName: { contains: query } },
          { contactEmail: { contains: query } },
          { contactPhone: { contains: query } },
          ...parsed.phoneVariants.map((phone) => ({
            contactPhone: { contains: phone },
          })),
          ...(allowSensitive
            ? [
                { taxId: { contains: query } },
                { registrationNo: { contains: query } },
              ]
            : []),
        ],
      },
      select: {
        id: true,
        legalName: true,
        tradeName: true,
        displayName: true,
        contactEmail: true,
        contactPhone: true,
        status: true,
        riskTier: true,
        updatedAt: true,
        ...(allowSensitive
          ? {
              taxId: true,
              registrationNo: true,
            }
          : {}),
      },
      orderBy: { updatedAt: "desc" },
      take,
    });
  },
  extractMatchSignals: (row, actor) => {
    const allowSensitive = hasMerchantSensitiveAccess(actor);
    const sensitiveFields = row as typeof row & {
      taxId?: string | null;
      registrationNo?: string | null;
    };
    return {
      exactFields: [
        row.id,
        row.contactEmail,
        row.contactPhone,
        ...(allowSensitive
          ? [sensitiveFields.taxId, sensitiveFields.registrationNo]
          : []),
      ],
      primaryTextFields: [
        row.displayName,
        row.tradeName,
        row.legalName,
      ],
      secondaryTextFields: [row.riskTier],
      timestamp: row.updatedAt,
    };
  },
  toResultItem: (row) => ({
    id: row.id,
    title:
      row.displayName || row.tradeName || row.legalName || row.id,
    subtitle: compact([row.legalName, row.contactEmail, row.riskTier]),
    reference: row.id,
    status: row.status,
    merchantId: row.id,
  }),
});

export const paymentAttemptProvider = defineSearchProvider({
  type: "payment_attempt",
  aliases: ["attempt", "attempts", "tx", "transaction", "payment"],
  order: 20,
  canAccess: (actor) =>
    hasAllAuthorities(actor, ["attempt:read", "merchant:read"]),
  fetchCandidates: async ({ prisma, parsed, take }) => {
    const query = parsed.term;
    const status = scopedStatusIn<AttemptStatus>(parsed, AttemptStatus);
    return prisma.paymentAttempt.findMany({
      where: {
        ...(parsed.scopedMerchantId
          ? { merchantId: parsed.scopedMerchantId }
          : {}),
        ...(status ? { status } : {}),
        OR: [
          { id: { contains: query } },
          { reference: { contains: query } },
          { providerReference: { contains: query } },
          { networkReference: { contains: query } },
          { gatewayReference: { contains: query } },
          { idempotencyKey: { contains: query } },
          { merchant: { is: { tradeName: { contains: query } } } },
          { merchant: { is: { legalName: { contains: query } } } },
        ],
      },
      select: {
        id: true,
        reference: true,
        providerReference: true,
        networkReference: true,
        gatewayReference: true,
        requestedAmount: true,
        totalChargedAmount: true,
        currency: true,
        status: true,
        merchantId: true,
        createdAt: true,
        merchant: {
          select: {
            tradeName: true,
            legalName: true,
          },
        },
        rail: {
          select: {
            code: true,
            nameEn: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take,
    });
  },
  extractMatchSignals: (row) => ({
    exactFields: [
      row.id,
      row.reference,
      row.providerReference,
      row.networkReference,
      row.gatewayReference,
    ],
    primaryTextFields: [row.merchant?.tradeName, row.merchant?.legalName],
    secondaryTextFields: [row.rail?.code],
    timestamp: row.createdAt,
  }),
  toResultItem: (row) => ({
    id: row.id,
    title: `${row.reference} · ${amountText(
      row.totalChargedAmount ?? row.requestedAmount,
    )} ${row.currency}`,
    subtitle: compact([
      row.merchant?.tradeName || row.merchant?.legalName || row.merchantId,
      row.rail?.code?.toUpperCase(),
      row.providerReference ? `Prov: ${row.providerReference}` : null,
    ]),
    reference: row.reference,
    status: row.status,
    merchantId: row.merchantId,
  }),
});

export const operatorCaseProvider = defineSearchProvider({
  type: "operator_case",
  aliases: ["case", "cases"],
  order: 30,
  canAccess: (actor) =>
    hasAnyAuthority(actor, ["case:read", "operator:read"]),
  fetchCandidates: async ({ prisma, parsed, take }) => {
    const query = parsed.term;
    const status = scopedStatusIn<OperatorCaseState>(parsed, OperatorCaseState);
    return prisma.operatorCase.findMany({
      where: {
        ...(status ? { state: status } : {}),
        OR: [
          { id: { contains: query } },
          { attempt: { is: { reference: { contains: query } } } },
          { attempt: { is: { providerReference: { contains: query } } } },
          { attempt: { is: { networkReference: { contains: query } } } },
          {
            reconciliationItem: {
              is: { ourReference: { contains: query } },
            },
          },
          {
            reconciliationItem: {
              is: { providerReference: { contains: query } },
            },
          },
          { assignee: { is: { email: { contains: query } } } },
          {
            attempt: {
              is: { merchant: { is: { tradeName: { contains: query } } } },
            },
          },
          {
            attempt: {
              is: { merchant: { is: { legalName: { contains: query } } } },
            },
          },
        ],
      },
      select: {
        id: true,
        kind: true,
        priority: true,
        state: true,
        createdAt: true,
        attempt: {
          select: {
            reference: true,
            merchantId: true,
            merchant: {
              select: {
                tradeName: true,
                legalName: true,
              },
            },
          },
        },
        reconciliationItem: {
          select: {
            ourReference: true,
            providerReference: true,
          },
        },
        assignee: {
          select: {
            email: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take,
    });
  },
  extractMatchSignals: (row) => ({
    exactFields: [
      row.id,
      row.attempt?.reference,
      row.reconciliationItem?.ourReference,
      row.reconciliationItem?.providerReference,
      row.assignee?.email,
    ],
    primaryTextFields: [
      row.attempt?.merchant?.tradeName,
      row.attempt?.merchant?.legalName,
    ],
    secondaryTextFields: [row.kind, row.priority, row.state],
    timestamp: row.createdAt,
  }),
  toResultItem: (row) => ({
    id: row.id,
    title: `${row.kind} · ${row.priority}`,
    subtitle: compact([
      row.attempt?.merchant?.tradeName ||
        row.attempt?.merchant?.legalName,
      row.attempt?.reference ? `Ref: ${row.attempt.reference}` : null,
      row.assignee?.email,
    ]),
    reference:
      row.attempt?.reference ||
      row.reconciliationItem?.ourReference ||
      row.reconciliationItem?.providerReference ||
      row.id,
    status: row.state,
    merchantId: row.attempt?.merchantId,
    operatorCaseId: row.id,
  }),
});

export const gatewayInquiryProvider = defineSearchProvider({
  type: "gateway_inquiry",
  aliases: ["inquiry", "inquiries"],
  order: 40,
  canAccess: (actor) =>
    hasAnyAuthority(actor, ["case:read", "operator:read"]),
  fetchCandidates: async ({ prisma, parsed, take }) => {
    const query = parsed.term;
    const status = scopedStatusIn<GatewayInquiryScheduleStatus>(parsed, GatewayInquiryScheduleStatus);
    return prisma.gatewayInquirySchedule.findMany({
      where: {
        ...(status ? { status } : {}),
        OR: [
          { id: { contains: query } },
          { reason: { contains: query } },
          { operatorCaseId: { contains: query } },
          { attempt: { is: { reference: { contains: query } } } },
          { attempt: { is: { providerReference: { contains: query } } } },
          { attempt: { is: { gatewayReference: { contains: query } } } },
          { attempt: { is: { networkReference: { contains: query } } } },
          {
            attempt: {
              is: { merchant: { is: { tradeName: { contains: query } } } },
            },
          },
          {
            attempt: {
              is: { merchant: { is: { legalName: { contains: query } } } },
            },
          },
        ],
      },
      select: {
        id: true,
        operatorCaseId: true,
        source: true,
        status: true,
        reason: true,
        nextRunAt: true,
        createdAt: true,
        attempt: {
          select: {
            reference: true,
            providerReference: true,
            gatewayReference: true,
            networkReference: true,
            merchantId: true,
            merchant: {
              select: {
                tradeName: true,
                legalName: true,
              },
            },
            rail: {
              select: {
                code: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take,
    });
  },
  extractMatchSignals: (row) => ({
    exactFields: [
      row.id,
      row.attempt?.reference,
      row.attempt?.providerReference,
      row.attempt?.gatewayReference,
      row.operatorCaseId,
    ],
    primaryTextFields: [
      row.reason,
      row.attempt?.merchant?.tradeName,
      row.attempt?.merchant?.legalName,
    ],
    secondaryTextFields: [
      row.attempt?.rail?.code,
      row.source,
      row.status,
    ],
    timestamp: row.createdAt,
  }),
  toResultItem: (row) => ({
    id: row.id,
    title: `Inquiry ${row.attempt?.reference || row.id}`,
    subtitle: compact([
      row.attempt?.rail?.code?.toUpperCase(),
      row.attempt?.merchant?.tradeName ||
        row.attempt?.merchant?.legalName,
      row.source,
    ]),
    reference:
      row.attempt?.reference ||
      row.attempt?.providerReference ||
      row.attempt?.gatewayReference ||
      row.id,
    status: row.status,
    operatorCaseId: row.operatorCaseId ?? undefined,
    merchantId: row.attempt?.merchantId,
  }),
});

export const approvalProvider = defineSearchProvider({
  type: "approval",
  aliases: ["approvals", "maker_checker"],
  order: 50,
  canAccess: (actor) => hasAuthority(actor, "approval:read"),
  fetchCandidates: async ({ prisma, parsed, take }) => {
    const query = parsed.term;
    const status = scopedStatusIn<ApprovalState>(parsed, ApprovalState);
    return prisma.approvalRequest.findMany({
      where: {
        ...(status ? { state: status } : {}),
        OR: [
          { id: { contains: query } },
          { subjectId: { contains: query } },
          { subjectType: { contains: query } },
          { maker: { is: { email: { contains: query } } } },
          { checker: { is: { email: { contains: query } } } },
        ],
      },
      select: {
        id: true,
        subjectType: true,
        subjectId: true,
        mode: true,
        state: true,
        createdAt: true,
        maker: {
          select: {
            email: true,
          },
        },
        checker: {
          select: {
            email: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take,
    });
  },
  extractMatchSignals: (row) => ({
    exactFields: [
      row.id,
      row.subjectId,
      row.maker.email,
      row.checker?.email,
    ],
    primaryTextFields: [row.subjectType, row.mode],
    timestamp: row.createdAt,
  }),
  toResultItem: (row) => ({
    id: row.id,
    title: `Approval · ${row.subjectType}`,
    subtitle: compact([
      `Subject: ${row.subjectId}`,
      `Maker: ${row.maker.email}`,
      row.checker?.email ? `Checker: ${row.checker.email}` : null,
    ]),
    reference: row.subjectId || row.id,
    status: row.state,
  }),
});

export const joinRequestProvider = defineSearchProvider({
  type: "join_request",
  aliases: ["onboarding", "join", "kyb"],
  order: 60,
  canAccess: (actor) =>
    hasAnyAuthority(actor, ["kyb:read", "compliance:read"]),
  fetchCandidates: async ({ prisma, parsed, take }) => {
    const query = parsed.term;
    const status = scopedStatusIn<JoinRequestStatus>(parsed, JoinRequestStatus);
    return prisma.joinRequest.findMany({
      where: {
        ...(status ? { status } : {}),
        OR: [
          { id: { contains: query } },
          { merchantId: { contains: query } },
          {
            merchant: {
              is: { legalName: { contains: query } },
            },
          },
          {
            merchant: {
              is: { tradeName: { contains: query } },
            },
          },
          {
            merchant: {
              is: { contactEmail: { contains: query } },
            },
          },
          {
            merchant: {
              is: { contactPhone: { contains: query } },
            },
          },
          ...parsed.phoneVariants.map((phone) => ({
            merchant: {
              is: { contactPhone: { contains: phone } },
            },
          })),
        ],
      },
      select: {
        id: true,
        status: true,
        merchantId: true,
        proposedRiskTier: true,
        createdAt: true,
        merchant: {
          select: {
            legalName: true,
            tradeName: true,
            contactEmail: true,
            contactPhone: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take,
    });
  },
  extractMatchSignals: (row) => ({
    exactFields: [
      row.id,
      row.merchantId,
      row.merchant.contactEmail,
      row.merchant.contactPhone,
    ],
    primaryTextFields: [row.merchant.tradeName, row.merchant.legalName],
    secondaryTextFields: [row.proposedRiskTier, row.status],
    timestamp: row.createdAt,
  }),
  toResultItem: (row) => ({
    id: row.id,
    title:
      row.merchant.tradeName || row.merchant.legalName || row.id,
    subtitle: compact([
      row.merchant.contactEmail,
      row.merchant.contactPhone,
      row.proposedRiskTier,
    ]),
    reference: row.id,
    status: row.status,
    merchantId: row.merchantId,
  }),
});

export const kybDocumentProvider = defineSearchProvider({
  type: "kyb_document",
  aliases: ["doc", "docs", "document"],
  order: 70,
  canAccess: (actor) =>
    hasAnyAuthority(actor, ["kyb:read", "compliance:read"]),
  fetchCandidates: async ({ prisma, parsed, take }) => {
    const query = parsed.term;
    const status = scopedStatusIn<KybDocumentStatus>(parsed, KybDocumentStatus);
    return prisma.kybDocument.findMany({
      where: {
        ...(status ? { status } : {}),
        OR: [
          { id: { contains: query } },
          { originalFileName: { contains: query } },
          { sha256: { contains: query } },
          {
            merchant: {
              is: { tradeName: { contains: query } },
            },
          },
          {
            merchant: {
              is: { legalName: { contains: query } },
            },
          },
        ],
      },
      select: {
        id: true,
        docType: true,
        originalFileName: true,
        sha256: true,
        status: true,
        merchantId: true,
        createdAt: true,
        merchant: {
          select: {
            tradeName: true,
            legalName: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take,
    });
  },
  extractMatchSignals: (row) => ({
    exactFields: [row.id, row.sha256, row.originalFileName],
    primaryTextFields: [
      row.merchant.tradeName,
      row.merchant.legalName,
    ],
    secondaryTextFields: [row.docType],
    timestamp: row.createdAt,
  }),
  toResultItem: (row) => ({
    id: row.id,
    title: `${row.docType} · ${row.originalFileName || "Document"}`,
    subtitle: compact([
      row.merchant.tradeName || row.merchant.legalName || row.merchantId,
      row.sha256 ? `SHA256: ${row.sha256.slice(0, 12)}…` : null,
    ]),
    reference: row.sha256 ? row.sha256.slice(0, 12) : row.id,
    status: row.status,
    merchantId: row.merchantId,
  }),
});

export const disputeProvider = defineSearchProvider({
  type: "dispute",
  aliases: ["disputes", "chargeback"],
  order: 80,
  canAccess: (actor) => hasAuthority(actor, "dispute:read"),
  fetchCandidates: async ({ prisma, parsed, take }) => {
    const query = parsed.term;
    const status = scopedStatusIn<DisputeStatus>(parsed, DisputeStatus);
    return prisma.dispute.findMany({
      where: {
        ...(status ? { status } : {}),
        OR: [
          { id: { contains: query } },
          { externalDisputeRef: { contains: query } },
          { reasonCode: { contains: query } },
          { attempt: { is: { reference: { contains: query } } } },
          {
            attempt: {
              is: { merchant: { is: { tradeName: { contains: query } } } },
            },
          },
          {
            attempt: {
              is: { merchant: { is: { legalName: { contains: query } } } },
            },
          },
        ],
      },
      select: {
        id: true,
        externalDisputeRef: true,
        reasonCode: true,
        amount: true,
        currency: true,
        status: true,
        createdAt: true,
        attempt: {
          select: {
            reference: true,
            merchantId: true,
            merchant: {
              select: {
                tradeName: true,
                legalName: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take,
    });
  },
  extractMatchSignals: (row) => ({
    exactFields: [
      row.id,
      row.externalDisputeRef,
      row.reasonCode,
      row.attempt.reference,
    ],
    primaryTextFields: [
      row.attempt.merchant.tradeName,
      row.attempt.merchant.legalName,
    ],
    timestamp: row.createdAt,
  }),
  toResultItem: (row) => ({
    id: row.id,
    title: `Dispute ${row.externalDisputeRef}${
      row.reasonCode ? ` (${row.reasonCode})` : ""
    }`,
    subtitle: compact([
      row.attempt.merchant.tradeName || row.attempt.merchant.legalName,
      row.attempt.reference ? `Attempt: ${row.attempt.reference}` : null,
      `${amountText(row.amount)} ${row.currency}`,
    ]),
    reference: row.externalDisputeRef || row.attempt.reference || row.id,
    status: row.status,
    merchantId: row.attempt.merchantId,
  }),
});

export const adjustmentProvider = defineSearchProvider({
  type: "adjustment",
  aliases: ["adjustments", "refund", "fee_adjustment"],
  order: 90,
  canAccess: (actor) => hasAuthority(actor, "finance:read"),
  fetchCandidates: async ({ prisma, parsed, take }) => {
    const query = parsed.term;
    const status = scopedStatusIn<AdjustmentState>(parsed, AdjustmentState);
    return prisma.adjustment.findMany({
      where: {
        ...(status ? { state: status } : {}),
        OR: [
          { id: { contains: query } },
          { reason: { contains: query } },
          { externalDisputeRef: { contains: query } },
          { providerRefundRef: { contains: query } },
          {
            sourceAttempt: {
              is: { reference: { contains: query } },
            },
          },
          {
            sourceAttempt: {
              is: {
                merchant: { is: { tradeName: { contains: query } } },
              },
            },
          },
          {
            sourceAttempt: {
              is: {
                merchant: { is: { legalName: { contains: query } } },
              },
            },
          },
        ],
      },
      select: {
        id: true,
        type: true,
        amount: true,
        reason: true,
        externalDisputeRef: true,
        providerRefundRef: true,
        state: true,
        createdAt: true,
        sourceAttempt: {
          select: {
            reference: true,
            merchantId: true,
            currency: true,
            merchant: {
              select: {
                tradeName: true,
                legalName: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take,
    });
  },
  extractMatchSignals: (row) => ({
    exactFields: [
      row.id,
      row.providerRefundRef,
      row.externalDisputeRef,
      row.sourceAttempt?.reference,
    ],
    primaryTextFields: [row.reason, row.type],
    secondaryTextFields: [row.state],
    timestamp: row.createdAt,
  }),
  toResultItem: (row) => ({
    id: row.id,
    title: `${row.type} · ${amountText(row.amount)} ${
      row.sourceAttempt?.currency ?? "LYD"
    }`,
    subtitle: compact([
      row.reason,
      row.sourceAttempt?.reference
        ? `Attempt: ${row.sourceAttempt.reference}`
        : null,
    ]),
    reference:
      row.providerRefundRef ||
      row.externalDisputeRef ||
      row.sourceAttempt?.reference ||
      row.id,
    status: row.state,
    merchantId: row.sourceAttempt?.merchantId,
  }),
});

export const cashoutProvider = defineSearchProvider({
  type: "cashout",
  aliases: ["cashouts", "payout", "withdrawal"],
  order: 100,
  canAccess: (actor) => hasAuthority(actor, "cashout:read"),
  fetchCandidates: async ({ prisma, parsed, take }) => {
    const query = parsed.term;
    const status = scopedStatusIn<CashoutState>(parsed, CashoutState);
    return prisma.cashoutRequest.findMany({
      where: {
        ...(status ? { state: status } : {}),
        OR: [
          { id: { contains: query } },
          { walletId: { contains: query } },
          {
            merchant: {
              is: { tradeName: { contains: query } },
            },
          },
          {
            merchant: {
              is: { legalName: { contains: query } },
            },
          },
        ],
      },
      select: {
        id: true,
        walletId: true,
        amount: true,
        state: true,
        merchantId: true,
        createdAt: true,
        wallet: {
          select: {
            currency: true,
          },
        },
        merchant: {
          select: {
            tradeName: true,
            legalName: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take,
    });
  },
  extractMatchSignals: (row) => ({
    exactFields: [row.id, row.walletId],
    primaryTextFields: [row.merchant.tradeName, row.merchant.legalName],
    secondaryTextFields: [row.state],
    timestamp: row.createdAt,
  }),
  toResultItem: (row) => ({
    id: row.id,
    title: `Cash-out ${amountText(row.amount)} ${
      row.wallet?.currency ?? "LYD"
    }`,
    subtitle: compact([
      row.merchant.tradeName || row.merchant.legalName,
      `Wallet: ${row.walletId}`,
    ]),
    reference: row.id,
    status: row.state,
    merchantId: row.merchantId,
  }),
});

export const reconciliationRunProvider = defineSearchProvider({
  type: "reconciliation_run",
  aliases: ["recon", "reconciliation", "statement"],
  order: 110,
  canAccess: (actor) => hasAuthority(actor, "reconciliation:read"),
  fetchCandidates: async ({ prisma, parsed, take }) => {
    const query = parsed.term;
    return prisma.reconciliationRun.findMany({
      where: {
        OR: [
          { id: { contains: query } },
          { fileName: { contains: query } },
          { fileHash: { contains: query } },
          {
            statementSource: {
              is: { gateway: { is: { code: { contains: query } } } },
            },
          },
          {
            statementSource: {
              is: { gateway: { is: { name: { contains: query } } } },
            },
          },
          {
            statementSource: {
              is: { gateway: { is: { operator: { contains: query } } } },
            },
          },
        ],
      },
      select: {
        id: true,
        fileName: true,
        fileHash: true,
        statsJson: true,
        createdAt: true,
        ingestedAt: true,
        statementSource: {
          select: {
            gateway: {
              select: {
                code: true,
                name: true,
                operator: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take,
    });
  },
  extractMatchSignals: (row) => ({
    exactFields: [
      row.id,
      row.fileName,
      row.fileHash,
      row.statementSource.gateway.code,
    ],
    primaryTextFields: [
      row.statementSource.gateway.name,
      row.statementSource.gateway.operator,
    ],
    timestamp: row.createdAt,
  }),
  toResultItem: (row) => {
    const stats = asRecord(row.statsJson);
    const matched = Number(stats.matched ?? 0);
    const mismatched = Number(
      stats.mismatched ??
        (Number(stats.amountMismatch ?? 0) +
          Number(stats.missingAtGateway ?? 0) +
          Number(stats.missingLocally ?? 0) +
          Number(stats.duplicates ?? 0)),
    );
    return {
      id: row.id,
      title: `${row.statementSource.gateway.code.toUpperCase()} · ${
        row.fileName || "Statement"
      }`,
      subtitle: compact([
        Number.isFinite(matched) ? `Matched ${matched}` : null,
        Number.isFinite(mismatched) ? `Mismatched ${mismatched}` : null,
        row.ingestedAt
          ? `Ingested ${row.ingestedAt.toISOString().slice(0, 10)}`
          : "Pending ingestion",
      ]),
      reference: row.id,
      status: row.ingestedAt ? "INGESTED" : "PENDING",
    };
  },
});

export const amlCaseProvider = defineSearchProvider({
  type: "aml_case",
  aliases: ["aml"],
  order: 120,
  canAccess: (actor) => hasConfidentialAmlAccess(actor),
  fetchCandidates: async ({ prisma, parsed, take }) => {
    const query = parsed.term;
    const status = scopedStatusIn<AmlCaseStatus>(parsed, AmlCaseStatus);
    return prisma.amlCase.findMany({
      where: {
        ...(status ? { status } : {}),
        OR: [
          { id: { contains: query } },
          { subjectId: { contains: query } },
          { triggerReason: { contains: query } },
          { rule: { is: { code: { contains: query } } } },
          { rule: { is: { name: { contains: query } } } },
          {
            assignedReviewer: {
              is: { email: { contains: query } },
            },
          },
        ],
      },
      select: {
        id: true,
        subjectType: true,
        subjectId: true,
        triggerReason: true,
        severity: true,
        status: true,
        createdAt: true,
        rule: {
          select: {
            code: true,
            name: true,
          },
        },
        assignedReviewer: {
          select: {
            email: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take,
    });
  },
  extractMatchSignals: (row) => ({
    exactFields: [
      row.id,
      row.subjectId,
      row.rule?.code,
      row.assignedReviewer?.email,
    ],
    primaryTextFields: [row.triggerReason, row.rule?.name],
    secondaryTextFields: [row.subjectType, row.severity],
    timestamp: row.createdAt,
  }),
  toResultItem: (row) => ({
    id: row.id,
    title: `AML Case · ${row.rule?.code || row.triggerReason}`,
    subtitle: compact([
      `Subject: ${row.subjectType} ${row.subjectId}`,
      row.rule?.name,
      row.assignedReviewer?.email,
      row.severity,
    ]),
    reference: row.id,
    status: row.status,
  }),
});

export const amlScreeningProvider = defineSearchProvider({
  type: "aml_screening",
  aliases: ["screening"],
  order: 130,
  canAccess: (actor) => hasConfidentialAmlAccess(actor),
  fetchCandidates: async ({ prisma, parsed, take }) => {
    const query = parsed.term;
    const result = scopedStatusIn<AmlScreeningResult>(parsed, AmlScreeningResult);
    return prisma.amlScreening.findMany({
      where: {
        ...(result ? { result } : {}),
        OR: [
          { id: { contains: query } },
          { subjectId: { contains: query } },
          { providerCode: { contains: query } },
          { providerRequestRef: { contains: query } },
        ],
      },
      select: {
        id: true,
        subjectType: true,
        subjectId: true,
        providerCode: true,
        providerRequestRef: true,
        result: true,
        trigger: true,
        requestedAt: true,
        createdAt: true,
      },
      orderBy: { requestedAt: "desc" },
      take,
    });
  },
  extractMatchSignals: (row) => ({
    exactFields: [
      row.id,
      row.subjectId,
      row.providerRequestRef,
      row.providerCode,
    ],
    secondaryTextFields: [row.subjectType, row.result, row.trigger],
    timestamp: row.requestedAt ?? row.createdAt,
  }),
  toResultItem: (row) => ({
    id: row.id,
    title: `Screening · ${row.providerCode}`,
    subtitle: compact([
      `${row.subjectType}: ${row.subjectId}`,
      row.result,
      row.trigger,
    ]),
    reference: row.providerRequestRef || row.id,
    status: row.result,
  }),
});

export const amlRuleProvider = defineSearchProvider({
  type: "aml_rule",
  aliases: ["aml_rules"],
  order: 140,
  canAccess: (actor) => hasConfidentialAmlAccess(actor),
  fetchCandidates: async ({ prisma, parsed, take }) => {
    const query = parsed.term;
    const active =
      parsed.scopedStatus === "ACTIVE"
        ? true
        : parsed.scopedStatus === "INACTIVE"
          ? false
          : undefined;
    return prisma.amlRule.findMany({
      where: {
        ...(active === undefined ? {} : { active }),
        OR: [
          { id: { contains: query } },
          { code: { contains: query } },
          { name: { contains: query } },
        ],
      },
      select: {
        id: true,
        code: true,
        name: true,
        ruleType: true,
        action: true,
        baseSeverity: true,
        active: true,
        version: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: "desc" },
      take,
    });
  },
  extractMatchSignals: (row) => ({
    exactFields: [row.id, row.code],
    primaryTextFields: [row.name],
    secondaryTextFields: [row.ruleType, row.action, row.baseSeverity],
    timestamp: row.updatedAt,
  }),
  toResultItem: (row) => ({
    id: row.id,
    title: `${row.code} · ${row.name}`,
    subtitle: compact([
      row.ruleType,
      row.baseSeverity,
      `v${row.version}`,
    ]),
    reference: row.code,
    status: row.active ? "ACTIVE" : "INACTIVE",
  }),
});

export const amlReportProvider = defineSearchProvider({
  type: "aml_report",
  aliases: ["str", "sar", "regulatory_report"],
  order: 150,
  canAccess: (actor) => hasConfidentialAmlAccess(actor),
  fetchCandidates: async ({ prisma, parsed, take }) => {
    const query = parsed.term;
    const status = scopedStatusIn<RegulatoryReportStatus>(parsed, RegulatoryReportStatus);
    return prisma.regulatoryReport.findMany({
      where: {
        ...(status ? { status } : {}),
        OR: [
          { id: { contains: query } },
          { subjectId: { contains: query } },
          { submissionRef: { contains: query } },
          { authority: { contains: query } },
        ],
      },
      select: {
        id: true,
        reportType: true,
        subjectType: true,
        subjectId: true,
        status: true,
        submissionRef: true,
        authority: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take,
    });
  },
  extractMatchSignals: (row) => ({
    exactFields: [row.id, row.subjectId, row.submissionRef],
    primaryTextFields: [row.reportType],
    secondaryTextFields: [row.authority, row.subjectType],
    timestamp: row.createdAt,
  }),
  toResultItem: (row) => ({
    id: row.id,
    title: `${row.reportType} · ${row.subjectId}`,
    subtitle: compact([
      `Subject: ${row.subjectType}`,
      row.submissionRef,
      row.authority,
    ]),
    reference: row.submissionRef || row.id,
    status: row.status,
  }),
});

export const gatewayProvider = defineSearchProvider({
  type: "gateway",
  aliases: ["gateways", "gw"],
  order: 160,
  canAccess: (actor) => hasAuthority(actor, "gateway:read"),
  fetchCandidates: async ({ prisma, parsed, take }) => {
    const query = parsed.term;
    const status = scopedStatusIn<GatewayStatus>(parsed, GatewayStatus);
    return prisma.gateway.findMany({
      where: {
        ...(status ? { status } : {}),
        OR: [
          { id: { contains: query } },
          { code: { contains: query } },
          { name: { contains: query } },
          { operator: { contains: query } },
        ],
      },
      select: {
        id: true,
        code: true,
        name: true,
        operator: true,
        status: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: "desc" },
      take,
    });
  },
  extractMatchSignals: (row) => ({
    exactFields: [row.id, row.code],
    primaryTextFields: [row.name, row.operator],
    timestamp: row.updatedAt,
  }),
  toResultItem: (row) => ({
    id: row.id,
    title: `${row.name} (${row.code})`,
    subtitle: row.operator || undefined,
    reference: row.code,
    status: row.status,
  }),
});

export const railProvider = defineSearchProvider({
  type: "rail",
  aliases: ["rails"],
  order: 170,
  canAccess: (actor) => hasAuthority(actor, "gateway:read"),
  fetchCandidates: async ({ prisma, parsed, take }) => {
    const query = parsed.term;
    const blocked =
      parsed.scopedStatus === "BLOCKED"
        ? true
        : parsed.scopedStatus === "ACTIVE"
          ? false
          : undefined;
    return prisma.rail.findMany({
      where: {
        ...(blocked === undefined ? {} : { blocked }),
        OR: [
          { id: { contains: query } },
          { code: { contains: query } },
          { nameEn: { contains: query } },
          { nameAr: { contains: query } },
        ],
      },
      select: {
        id: true,
        code: true,
        nameEn: true,
        nameAr: true,
        collectionMode: true,
        currency: true,
        blocked: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: "desc" },
      take,
    });
  },
  extractMatchSignals: (row) => ({
    exactFields: [row.id, row.code],
    primaryTextFields: [row.nameEn, row.nameAr],
    secondaryTextFields: [row.collectionMode, row.currency],
    timestamp: row.updatedAt,
  }),
  toResultItem: (row) => ({
    id: row.id,
    title: `${row.nameEn}${row.nameAr ? ` (${row.nameAr})` : ""}`,
    subtitle: compact([row.collectionMode, row.currency]),
    reference: row.code,
    status: row.blocked ? "BLOCKED" : "ACTIVE",
  }),
});

export const routeProvider = defineSearchProvider({
  type: "route",
  aliases: ["routes", "rail_route"],
  order: 180,
  canAccess: (actor) => hasAuthority(actor, "gateway:read"),
  fetchCandidates: async ({ prisma, parsed, take }) => {
    const query = parsed.term;
    const status = scopedStatusIn<RouteStatus>(parsed, RouteStatus);
    return prisma.railRoute.findMany({
      where: {
        ...(status ? { status } : {}),
        OR: [
          { id: { contains: query } },
          { rail: { is: { code: { contains: query } } } },
          { rail: { is: { nameEn: { contains: query } } } },
          { rail: { is: { nameAr: { contains: query } } } },
          { gateway: { is: { code: { contains: query } } } },
          { gateway: { is: { name: { contains: query } } } },
          { gateway: { is: { operator: { contains: query } } } },
        ],
      },
      select: {
        id: true,
        priority: true,
        status: true,
        healthState: true,
        updatedAt: true,
        rail: {
          select: {
            code: true,
            nameEn: true,
            nameAr: true,
          },
        },
        gateway: {
          select: {
            code: true,
            name: true,
            operator: true,
          },
        },
      },
      orderBy: { updatedAt: "desc" },
      take,
    });
  },
  extractMatchSignals: (row) => ({
    exactFields: [row.id, row.rail.code, row.gateway.code],
    primaryTextFields: [
      row.rail.nameEn,
      row.rail.nameAr,
      row.gateway.name,
    ],
    secondaryTextFields: [
      row.gateway.operator,
      String(row.priority),
      row.healthState,
      row.status,
    ],
    timestamp: row.updatedAt,
  }),
  toResultItem: (row) => ({
    id: row.id,
    title: `${row.rail.code} → ${row.gateway.code}`,
    subtitle: `Priority ${row.priority} · Health: ${row.healthState}`,
    reference: row.id,
    status: row.status,
  }),
});

export const userProvider = defineSearchProvider({
  type: "user",
  aliases: ["users", "staff", "admin"],
  order: 190,
  canAccess: (actor) =>
    hasAnyAuthority(actor, ["user:read", "security:read"]),
  fetchCandidates: async ({ prisma, parsed, take }) => {
    const query = parsed.term;
    const status = scopedStatusIn<UserStatus>(parsed, UserStatus);
    return prisma.user.findMany({
      where: {
        ...(parsed.scopedMerchantId
          ? { merchantId: parsed.scopedMerchantId }
          : {}),
        ...(status ? { status } : {}),
        OR: [
          { id: { contains: query } },
          { email: { contains: query } },
          { phone: { contains: query } },
          ...parsed.phoneVariants.map((phone) => ({
            phone: { contains: phone },
          })),
        ],
      },
      select: {
        id: true,
        email: true,
        phone: true,
        role: true,
        status: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take,
    });
  },
  extractMatchSignals: (row) => ({
    exactFields: [row.id, row.email, row.phone],
    secondaryTextFields: [row.role],
    timestamp: row.createdAt,
  }),
  toResultItem: (row) => ({
    id: row.id,
    title: row.email || row.phone || row.id,
    subtitle: compact([
      row.role,
      row.email && row.phone ? row.phone : null,
    ]),
    reference: row.id,
    status: row.status,
  }),
});

export const auditLogProvider = defineSearchProvider({
  type: "audit_log",
  aliases: ["audit", "logs"],
  order: 200,
  canAccess: (actor) => hasAuthority(actor, "security:read"),
  fetchCandidates: async ({ prisma, parsed, take }) => {
    const query = parsed.term;
    return prisma.auditLog.findMany({
      where: {
        OR: [
          { id: { contains: query } },
          { action: { contains: query } },
          { entityType: { contains: query } },
          { entityId: { contains: query } },
          { actor: { is: { email: { contains: query } } } },
        ],
      },
      select: {
        id: true,
        action: true,
        entityType: true,
        entityId: true,
        createdAt: true,
        actor: {
          select: {
            email: true,
            role: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take,
    });
  },
  extractMatchSignals: (row) => ({
    exactFields: [row.id, row.entityId, row.actor.email, row.action],
    primaryTextFields: [row.entityType],
    secondaryTextFields: [row.actor.role],
    timestamp: row.createdAt,
  }),
  toResultItem: (row) => ({
    id: row.id,
    title: `${row.action} (${row.entityType})`,
    subtitle: compact([
      row.actor.email,
      row.entityId ? `Target: ${row.entityId}` : null,
      row.actor.role,
    ]),
    reference: row.entityId || row.id,
  }),
});

export const builtinSearchProviders = [
  merchantProvider,
  paymentAttemptProvider,
  operatorCaseProvider,
  gatewayInquiryProvider,
  approvalProvider,
  joinRequestProvider,
  kybDocumentProvider,
  disputeProvider,
  adjustmentProvider,
  cashoutProvider,
  reconciliationRunProvider,
  amlCaseProvider,
  amlScreeningProvider,
  amlRuleProvider,
  amlReportProvider,
  gatewayProvider,
  railProvider,
  routeProvider,
  userProvider,
  auditLogProvider,
] as const;

defaultSearchRegistry
  .register(merchantProvider)
  .register(paymentAttemptProvider)
  .register(operatorCaseProvider)
  .register(gatewayInquiryProvider)
  .register(approvalProvider)
  .register(joinRequestProvider)
  .register(kybDocumentProvider)
  .register(disputeProvider)
  .register(adjustmentProvider)
  .register(cashoutProvider)
  .register(reconciliationRunProvider)
  .register(amlCaseProvider)
  .register(amlScreeningProvider)
  .register(amlRuleProvider)
  .register(amlReportProvider)
  .register(gatewayProvider)
  .register(railProvider)
  .register(routeProvider)
  .register(userProvider)
  .register(auditLogProvider);

interface FastPathTokenRow {
  entityType: string;
  entityId: string;
  merchantId: string | null;
  isSensitive: boolean;
  baseWeight: number;
  token: string;
  title: string;
  subtitle: string | null;
  reference: string | null;
  status: string | null;
  operatorCaseId: string | null;
  entityCreatedAt: Date;
}

export interface GlobalSearchFastPathDeps {
  prisma: PrismaClient;
  actor: AuthenticatedAdminActor;
  parsed: ParsedSearchQuery;
  providers: Array<SearchProviderPlugin<unknown>>;
  limit: number;
}

export interface GlobalSearchFastPathResult {
  groups: SearchResultGroup[];
  total: number;
  scannedRows: number;
}

/**
 * Single-query indexed fan-out over `entity_search_tokens`. Returns null when
 * the query is not tokenizable (multi-word/free-text), so the caller can use
 * the legacy provider registry unchanged.
 */
export async function executeGlobalSearchFastPath(
  deps: GlobalSearchFastPathDeps,
): Promise<GlobalSearchFastPathResult | null> {
  const queryTokens = extractSearchQueryTokens(deps.parsed.term);
  if (queryTokens.length === 0 || deps.providers.length === 0) {
    return null;
  }
  const tokenDelegate = (
    deps.prisma as unknown as {
      entitySearchToken?: { findMany?: unknown };
    }
  ).entitySearchToken;
  if (!tokenDelegate || typeof tokenDelegate.findMany !== "function") {
    return null;
  }

  const entityTypes = deps.providers.map((provider) => provider.type);
  const queryTokenSet = new Set(queryTokens);
  const allowSensitive = hasMerchantSensitiveAccess(deps.actor);
  const where = {
    AND: [
      { entityType: { in: entityTypes } },
      { OR: queryTokens.map((token) => ({ token: { startsWith: token } })) },
      ...(deps.parsed.scopedStatus
        ? [{ status: deps.parsed.scopedStatus }]
        : []),
      ...(deps.parsed.scopedMerchantId
        ? [{ merchantId: deps.parsed.scopedMerchantId }]
        : []),
      ...(allowSensitive ? [] : [{ isSensitive: false }]),
    ],
  };

  const rows = (await deps.prisma.entitySearchToken.findMany({
    where: where as never,
    select: {
      entityType: true,
      entityId: true,
      merchantId: true,
      isSensitive: true,
      baseWeight: true,
      token: true,
      title: true,
      subtitle: true,
      reference: true,
      status: true,
      operatorCaseId: true,
      entityCreatedAt: true,
    },
    orderBy: [{ baseWeight: "desc" }, { entityCreatedAt: "desc" }] as never,
    take: 150,
  })) as FastPathTokenRow[];

  if (rows.length === 0) {
    return { groups: [], total: 0, scannedRows: 0 };
  }

  const providerByType = new Map(
    deps.providers.map((provider, index) => [provider.type, { provider, index }] as const),
  );
  const candidates = new Map<
    string,
    { type: SearchType; item: ReturnType<typeof sanitizeResultItem>; score: number; timeMs: number }
  >();

  for (const row of rows) {
    if (!providerByType.has(row.entityType)) {
      continue;
    }
    const key = `${row.entityType}\u0000${row.entityId}`;
    const score =
      row.baseWeight + (queryTokenSet.has(row.token) ? 200 : 0);
    const timeMs =
      row.entityCreatedAt instanceof Date
        ? row.entityCreatedAt.getTime()
        : new Date(row.entityCreatedAt).getTime();
    const existing = candidates.get(key);
    if (existing && (existing.score > score || (existing.score === score && existing.timeMs >= timeMs))) {
      continue;
    }
    candidates.set(key, {
      type: row.entityType,
      score,
      timeMs: Number.isFinite(timeMs) ? timeMs : 0,
      item: sanitizeResultItem({
        id: row.entityId,
        title: row.title,
        subtitle: row.subtitle ?? undefined,
        reference: row.reference ?? undefined,
        status: row.status ?? undefined,
        merchantId: row.merchantId ?? undefined,
        operatorCaseId: row.operatorCaseId ?? undefined,
      }),
    });
  }

  const grouped = new Map<string, Array<{ item: ReturnType<typeof sanitizeResultItem>; score: number; timeMs: number }>>();
  for (const candidate of candidates.values()) {
    const list = grouped.get(candidate.type) ?? [];
    list.push({ item: candidate.item, score: candidate.score, timeMs: candidate.timeMs });
    grouped.set(candidate.type, list);
  }

  const groups: SearchResultGroup[] = [];
  let total = 0;
  for (const provider of deps.providers) {
    const list = grouped.get(provider.type);
    if (!list || list.length === 0) {
      continue;
    }
    list.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (right.timeMs !== left.timeMs) {
        return right.timeMs - left.timeMs;
      }
      return left.item.id.localeCompare(right.item.id);
    });
    const items = list.slice(0, deps.limit).map((entry) => entry.item);
    if (items.length > 0) {
      groups.push({
        type: provider.type,
        items,
        truncated: list.length > deps.limit,
      });
      total += items.length;
    }
  }

  return { groups, total, scannedRows: rows.length };
}

export const globalSearchRequestSchema = z
  .object({
    query: z
      .string()
      .transform((value) => value.trim())
      .pipe(
        z
          .string()
          .min(2, "Query must be at least 2 characters")
          .max(120, "Query must be at most 120 characters"),
      ),
    types: z.array(z.string().min(1).max(64)).optional(),
    limit: z.number().int().min(1).max(10).default(5),
  })
  .strict();

export interface GlobalSearchLogger {
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
}

export interface ExecuteGlobalSearchDeps {
  prisma: PrismaClient;
  actor: AuthenticatedAdminActor;
  requestId?: string;
  logger?: GlobalSearchLogger;
  registry?: SearchProviderRegistry;
}

export async function executeGlobalSearch(
  rawBody: unknown,
  deps: ExecuteGlobalSearchDeps,
): Promise<GlobalSearchResponse> {
  const startedAt = performance.now();
  const registry = deps.registry ?? defaultSearchRegistry;
  const validated = parseOrThrow(globalSearchRequestSchema, rawBody);
  const registeredTypes = registry.getRegisteredTypes();
  const requestedTypes = validated.types;

  if (requestedTypes) {
    const invalid = requestedTypes.filter(
      (type) => !registeredTypes.has(type),
    );
    if (invalid.length > 0) {
      throw new ApiError(
        400,
        "SEARCH_TYPE_UNSUPPORTED",
        "The search request contains an unsupported record type",
        { types: invalid },
      );
    }
  }

  const parsed = parseSearchQuery(validated.query);
  const limit = validated.limit;
  const take = limit * 3;

  let allowedTypeSet: Set<string> | null = requestedTypes
    ? new Set(requestedTypes)
    : null;

  if (parsed.scopedTypeAliases.length > 0) {
    const aliasMatched = new Set<string>();
    for (const alias of parsed.scopedTypeAliases) {
      for (const matchedType of registry.resolveAliasToTypes(alias)) {
        aliasMatched.add(matchedType);
      }
    }
    if (aliasMatched.size > 0) {
      allowedTypeSet = allowedTypeSet
        ? new Set(
            [...allowedTypeSet].filter((type) => aliasMatched.has(type)),
          )
        : aliasMatched;
    }
  }

  const authorizedProviders = registry.getAllOrdered().filter((plugin) => {
    if (allowedTypeSet && !allowedTypeSet.has(plugin.type)) {
      return false;
    }
    if (!plugin.canAccess(deps.actor)) {
      return false;
    }
    if (
      plugin.supportsTokenKind &&
      !plugin.supportsTokenKind(parsed)
    ) {
      return false;
    }
    return true;
  });

  const runProviderGroups = async (
    providers: Array<SearchProviderPlugin<unknown>>,
  ): Promise<{ groups: SearchResultGroup[]; total: number; partial: boolean }> => {
    const settledResults = await Promise.allSettled(
      providers.map(async (plugin) => {
        const rows = await plugin.fetchCandidates({
          prisma: deps.prisma,
          parsed,
          actor: deps.actor,
          take,
        });
        const ranked = rankAndSliceCandidates(
          rows,
          plugin,
          parsed,
          deps.actor,
          limit,
        );
        return {
          type: plugin.type,
          items: ranked.items,
          truncated: ranked.truncated,
        } satisfies SearchResultGroup;
      }),
    );

    const groups: SearchResultGroup[] = [];
    let total = 0;
    let partial = false;

    settledResults.forEach((result, index) => {
      const plugin = providers[index];
      if (!plugin) {
        return;
      }
      if (result.status === "fulfilled") {
        if (result.value.items.length > 0) {
          groups.push(result.value);
          total += result.value.items.length;
        }
        return;
      }

      partial = true;
      deps.logger?.error("Global search provider failed", {
        requestId: deps.requestId,
        providerType: plugin.type,
        actorId: deps.actor.id,
        error:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
      });
    });

    return { groups, total, partial };
  };

  if (authorizedProviders.length > 0) {
    try {
      const fastPath = await executeGlobalSearchFastPath({
        prisma: deps.prisma,
        actor: deps.actor,
        parsed,
        providers: authorizedProviders,
        limit,
      });
      if (fastPath && fastPath.total > 0) {
        // Once the token index has a hit it is the authoritative search index.
        // Fanning out to the twenty `LIKE '%q%'` providers for the groups that
        // did not emit a token would reintroduce the scans this table replaces.
        // A zero-hit query still falls through to the legacy provider path.
        const tookMs = Math.max(1, Math.round(performance.now() - startedAt));
        if (tookMs > 750) {
          deps.logger?.warn("Slow global search execution detected", {
            requestId: deps.requestId,
            tookMs,
            providerCount: authorizedProviders.length,
            totalReturned: fastPath.total,
            partial: false,
            source: "token_index",
          });
        }
        return {
          query: validated.query,
          groups: fastPath.groups,
          total: fastPath.total,
          tookMs,
          partial: false,
        };
      }
    } catch (error) {
      deps.logger?.warn("Global search token index failed; falling back to providers", {
        requestId: deps.requestId,
        actorId: deps.actor.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const tokenKindProviderTypes: Partial<Record<ParsedSearchQuery["tokenKind"], readonly SearchType[]>> = {
    PHONE: ["merchant", "join_request", "user"],
    EMAIL: ["merchant", "join_request", "user"],
    SHA256_HEX: ["kyb_document"],
  };
  const narrowedTypes = tokenKindProviderTypes[parsed.tokenKind];
  const fallbackProviders = narrowedTypes
    ? authorizedProviders.filter((provider) => narrowedTypes.includes(provider.type))
    : authorizedProviders;
  const providerResult = await runProviderGroups(fallbackProviders);
  const { groups, total, partial } = providerResult;

  const tookMs = Math.max(1, Math.round(performance.now() - startedAt));
  if (tookMs > 750) {
    deps.logger?.warn("Slow global search execution detected", {
      requestId: deps.requestId,
      tookMs,
      providerCount: authorizedProviders.length,
      totalReturned: total,
      partial,
    });
  }

  return {
    query: validated.query,
    groups,
    total,
    tookMs,
    partial,
  };
}
