import { describe, expect, test } from "vitest";
import { buildOpenActionQueueSubLabel, buildSuccessRateSubLabel, buildUnknownBacklogSubLabel } from "../metricLabels";

const translate = (key: string) => `[${key}]`;

describe("dashboard all-time metric labels", () => {
    test("the open action queues sub-label names every source and the all-time scope", () => {
        const label = buildOpenActionQueueSubLabel(
            { approvals: 3, operatorCases: 4, joinRequests: 2, amlCases: 1 },
            translate,
        );
        expect(label).toBe(
            "3 [Pending approvals] · 4 [Operator cases] · 2 [Join requests] · 1 [AML cases] · [All time (not period-filtered)]",
        );
    });

    test("the unknown backlog sub-label carries the all-time scope before its oldest age", () => {
        expect(buildUnknownBacklogSubLabel("12h", translate)).toBe(
            "[All time (not period-filtered)] · 12h [oldest]",
        );
    });

    test("the success rate sub-label shows the succeeded and counted attempts", () => {
        expect(buildSuccessRateSubLabel(468, 955, translate)).toBe("468 [succeeded] / 955 [counted]");
        expect(buildSuccessRateSubLabel(468, undefined, translate)).toBe("468 [succeeded]");
    });
});
