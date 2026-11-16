import { formatPlainNumber } from "@/utils/money";

export interface OpenQueueCounts {
    approvals: number;
    operatorCases: number;
    joinRequests: number;
    amlCases: number;
}

type Translate = (key: string) => string;

export const buildOpenActionQueueSubLabel = (counts: OpenQueueCounts, t: Translate): string =>
    [
        `${formatPlainNumber(counts.approvals)} ${t("Pending approvals")}`,
        `${formatPlainNumber(counts.operatorCases)} ${t("Operator cases")}`,
        `${formatPlainNumber(counts.joinRequests)} ${t("Join requests")}`,
        `${formatPlainNumber(counts.amlCases)} ${t("AML cases")}`,
        t("All time (not period-filtered)"),
    ].join(" · ");

export const buildUnknownBacklogSubLabel = (oldestLabel: string, t: Translate): string =>
    [t("All time (not period-filtered)"), `${oldestLabel} ${t("oldest")}`].join(" · ");

export const buildSuccessRateSubLabel = (succeeded: number, counted: number | undefined, t: Translate): string =>
    counted === undefined
        ? `${formatPlainNumber(succeeded)} ${t("succeeded")}`
        : `${formatPlainNumber(succeeded)} ${t("succeeded")} / ${formatPlainNumber(counted)} ${t("counted")}`;
