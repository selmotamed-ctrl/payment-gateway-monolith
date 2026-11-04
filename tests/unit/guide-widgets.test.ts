import { describe, expect, test } from "vitest";
import { applyTransforms } from "@/components/guide/widgets/engine/transforms";
import { hmacSha256 } from "@/components/guide/widgets/engine/crypto";
import {
    simulateLedger,
    simulateLedgerEvent,
} from "@/components/guide/widgets/engine/ledger";
import { evaluateVisibleRails } from "@/components/guide/widgets/engine/visibleRails";
import {
    applyAttemptEvent,
    availableEvents,
} from "@/components/guide/widgets/engine/attemptStates";
import data from "@/content/guide/generated/data.json";
import type {
    AttemptTransitionsData,
    LedgerData,
    VisibleRailsData,
} from "@/content/guide";

const ledgerData = (data as unknown as { "ledger-events": LedgerData })["ledger-events"];
const railsData = (data as unknown as { "visible-rails": VisibleRailsData })["visible-rails"];
const attemptData = (data as unknown as { "attempt-transitions": AttemptTransitionsData })[
    "attempt-transitions"
];

describe("transform sandbox vectors", () => {
    const run = async (input: string, operations: any[]) => applyTransforms(input, operations);

    test("T1 scale to integer", async () => {
        expect((await run("10.50", [{ op: "scale", args: [1000] }, { op: "to_int" }, { op: "to_string" }])).value).toBe("10500");
    });
    test("T2 nearest rounding", async () => {
        expect((await run("76.255", [{ op: "round", args: ["NEAREST"] }, { op: "format_decimal", args: [2] }])).value).toBe("76.26");
    });
    test("T3 down rounding", async () => {
        expect((await run("76.255", [{ op: "round", args: ["DOWN"] }, { op: "format_decimal", args: [2] }])).value).toBe("76.25");
    });
    test("T4 Arabic digits", async () => {
        expect((await run("٠٩١٢٣٤٥٦٧٨", [{ op: "arabic_digits_to_ascii" }])).value).toBe("0912345678");
    });
    test("T5 local phone", async () => {
        expect((await run("+218912345678", [{ op: "phone_normalize", args: ["LOCAL_09"] }])).value).toBe("0912345678");
    });
    test("T6 international 218 phone", async () => {
        expect((await run("0912345678", [{ op: "phone_normalize", args: ["INTL_218"] }])).value).toBe("218912345678");
    });
    test("T7 E164 phone", async () => {
        expect((await run("0912345678", [{ op: "phone_normalize", args: ["E164"] }])).value).toBe("+218912345678");
    });
    test("T8 masking", async () => {
        expect((await run("0912345678", [{ op: "mask", args: [3, 2] }])).value).toBe("091*****78");
    });
    test("T9 left padding", async () => {
        expect((await run("5", [{ op: "pad_left", args: [10, "0"] }])).value).toBe("0000000005");
    });
    test("T10 XML escaping", async () => {
        expect((await run("a&b<c", [{ op: "xml_escape" }])).value).toBe("a&amp;b&lt;c");
    });
    test("T11 SHA-256 then lowercase hex", async () => {
        expect((await run("MID=1&TID=2&Amt=10500", [{ op: "sha256" }, { op: "hex_lower" }])).value).toBe(
            "c88bf5122e21ae0d4276e271860775a2ea936ea8ea657f057c29188a921f24d0",
        );
    });
    test("T12 scale 0.001", async () => {
        expect((await run("0.001", [{ op: "scale", args: [1000] }, { op: "to_int" }])).value).toBe("1");
    });
    test("unknown operation is an inline error, not a thrown exception", async () => {
        const result = await run("1", [{ op: "eval", args: ["1+1"] }]);
        expect(result.error).toContain("Unknown operation");
    });
});

describe("signature lab vectors", () => {
    const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const fields = {
        MerchantReference: "1234567890",
        AmountTrxn: "10500",
        MerchantId: "10081014649",
        TerminalId: "99179395",
        DateTimeLocalTrxn: "202610311030",
    };

    test("C1 sorted key/value ampersand upper hex", async () => {
        const result = await hmacSha256({
            mode: "SORTED_KEY_VALUE_AMP",
            key,
            keyEncoding: "HEX",
            outputEncoding: "HEX_UPPER",
            fields,
        });
        expect(result.canonical).toBe(
            "AmountTrxn=10500&DateTimeLocalTrxn=202610311030&MerchantId=10081014649&MerchantReference=1234567890&TerminalId=99179395",
        );
        expect(result.output).toBe(
            "8694D44C6AADF96FD26CAEDC8D491DF1D230E2E87B104C8E5F59D0AE8103D7A7",
        );
    });
    test("C1b lower hex", async () => {
        const result = await hmacSha256({
            mode: "SORTED_KEY_VALUE_AMP",
            key,
            keyEncoding: "HEX",
            outputEncoding: "HEX_LOWER",
            fields,
        });
        expect(result.output).toBe(
            "8694d44c6aadf96fd26caedc8d491df1d230e2e87b104c8e5f59d0ae8103d7a7",
        );
    });
    test("C2 timestamp dot raw body", async () => {
        const result = await hmacSha256({
            mode: "TIMESTAMP_DOT_RAW_BODY",
            key: "whsec_teaching_key",
            keyEncoding: "UTF8",
            outputEncoding: "HEX_LOWER",
            timestamp: "1761900000",
            body: '{"event":"payment.completed","id":"evt_001","amount":"100.00"}',
        });
        expect(result.canonical).toBe(
            '1761900000.{"event":"payment.completed","id":"evt_001","amount":"100.00"}',
        );
        expect(result.output).toBe(
            "964e8b23d675fe23f4809bdea2b940c058c084ba9bbfacfea21ee6bfba1c56e5",
        );
    });
    test("C3 sorted values hash", async () => {
        const result = await hmacSha256({
            mode: "SORTED_VALUES_HASH",
            key: "teaching_secret",
            keyEncoding: "UTF8",
            outputEncoding: "HEX_UPPER",
            fields: { transaction_id: "T1001", amount: "10.50", status: "approved" },
        });
        expect(result.canonical).toBe("10.50approvedT1001");
        expect(result.output).toBe(
            "463780F6809FB37551F390521DA47A570F82D68FBB5CD63F1B1B853487CD61CD",
        );
    });
    test("C4 raw body base64", async () => {
        const result = await hmacSha256({
            mode: "RAW_BODY",
            key: "teaching_secret",
            keyEncoding: "UTF8",
            outputEncoding: "BASE64",
            body: '{"status":"paid","ref":"R-77"}',
        });
        expect(result.output).toBe("X67eZeei+tBYGebSBABV3f26mTgmmAP+6cRan61vTpM=");
    });
});

describe("ledger explorer", () => {
    test("E02 with defaults produces the published vector", () => {
        const result = simulateLedgerEvent(ledgerData, "E02");
        expect(result).toBeDefined();
        const entry = result!.entries[0];
        const line = (account: string) =>
            entry.lines.find((candidate) => candidate.account === account)?.value;
        expect(line("GATEWAY_CLEARING")).toBe("100.0000");
        expect(line("GATEWAY_FEE_EXPENSE")).toBe("0.8000");
        expect(line("MERCHANT_WALLET")).toBe("97.0000");
        expect(line("PLATFORM_INCOME")).toBe("3.0000");
        expect(line("GATEWAY_FEE_ACCRUAL")).toBe("0.8000");
        expect(entry.debitTotal).toBe("100.8000");
        expect(entry.creditTotal).toBe("100.8000");
        expect(entry.balanced).toBe(true);
    });

    test("every event balances and the system equation holds after each event", () => {
        const results = simulateLedger(ledgerData);
        expect(results.length).toBe(16);
        for (const result of results) {
            for (const entry of result.entries) {
                expect(entry.balanced, `${result.event.id}/${entry.label}`).toBe(true);
            }
            expect(result.equation.ok, `${result.event.id} equation`).toBe(true);
        }
    });

    test("E15 shows the wallet balance expression", () => {
        const result = simulateLedgerEvent(ledgerData, "E15");
        expect(result?.showBalance?.value).toBe("-57.0000");
    });
});

describe("visible rails", () => {
    test("all seven published vectors pass", () => {
        for (const vector of railsData.vectors) {
            const results = evaluateVisibleRails(railsData, vector.input as any);
            const actual = Object.fromEntries(
                results.map((rail) => [
                    rail.code,
                    rail.visible ? "VISIBLE" : `HIDDEN:${rail.reason?.predicate}`,
                ]),
            );
            expect(actual, vector.id).toEqual(vector.expected);
        }
    });
});

describe("attempt state teaching model", () => {
    test("confirmation timeout becomes UNKNOWN, never FAILED", () => {
        const result = applyAttemptEvent(attemptData, "AUTHORIZING", "ev-confirm-timeout");
        expect(result?.state.stateId).toBe("UNKNOWN");
        expect(result?.state.money).toBe("none");
    });

    test("late success on an already-paid link keeps the state and parks money", () => {
        const result = applyAttemptEvent(attemptData, "EXPIRED", "ev-late-success-paid");
        expect(result?.state.stateId).toBe("EXPIRED");
        expect(result?.unchanged).toBe(true);
        expect(result?.note).toContain("SUSPENSE");
    });

    test("events are only offered from reachable states", () => {
        expect(availableEvents(attemptData, "AUTHORIZING").some((event) => event.id === "ev-confirm-success")).toBe(true);
        expect(availableEvents(attemptData, "SUCCEEDED").some((event) => event.id === "ev-confirm-success")).toBe(false);
        const impossible = applyAttemptEvent(attemptData, "SUCCEEDED", "ev-confirm-success");
        expect(impossible?.error).toContain("not possible");
    });
});
