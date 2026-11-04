import Decimal from "decimal.js";
import type {
    LedgerData,
    LedgerEvent,
    LedgerEventEntry,
    LedgerEventLine,
} from "@/content/guide";

type Variables = Record<string, Decimal>;

const TOKEN_RE = /\s*(\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*|[()+\-*/])/g;

const round4 = (value: Decimal): Decimal => value.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);

const tokenize = (expression: string): string[] => {
    const tokens: string[] = [];
    TOKEN_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    let consumed = 0;
    while ((match = TOKEN_RE.exec(expression)) !== null) {
        const matchedToken = match[1];
        if (!matchedToken) continue;
        const whitespace = expression.slice(
            consumed,
            match.index + match[0].indexOf(matchedToken),
        );
        if (whitespace.trim()) {
            throw new Error(`Unexpected text "${whitespace.trim()}" in amount expression.`);
        }
        const token = matchedToken;
        tokens.push(token);
        consumed = match.index + match[0].length;
    }
    if (expression.slice(consumed).trim()) {
        throw new Error(`Unexpected text "${expression.slice(consumed).trim()}" in amount expression.`);
    }
    return tokens;
};

export const evaluateAmountExpression = (expression: string, variables: Variables): Decimal => {
    const tokens = tokenize(expression);
    let index = 0;

    const peek = (): string | undefined => tokens[index];
    const take = (): string => {
        const token = tokens[index]!;
        index += 1;
        return token;
    };

    const parsePrimary = (): Decimal => {
        const token = peek();
        if (!token) throw new Error(`Amount expression "${expression}" ended unexpectedly.`);
        if (token === "(") {
            take();
            const value = parseExpression();
            if (take() !== ")") throw new Error(`Missing ")" in "${expression}".`);
            return value;
        }
        if (token === "-") {
            take();
            return parsePrimary().negated();
        }
        if (token === "+") {
            take();
            return parsePrimary();
        }
        if (/^\d/.test(token)) {
            take();
            return new Decimal(token);
        }
        if (/^[A-Za-z_]/.test(token)) {
            take();
            if (peek() === "(") {
                if (token !== "round4") {
                    throw new Error(`Unknown function "${token}" in "${expression}".`);
                }
                take();
                const value = parseExpression();
                if (take() !== ")") throw new Error(`Missing ")" in "${expression}".`);
                return round4(value);
            }
            const value = variables[token];
            if (!value) throw new Error(`Unknown variable "${token}" in "${expression}".`);
            return value;
        }
        throw new Error(`Unexpected token "${token}" in "${expression}".`);
    };

    const parseTerm = (): Decimal => {
        let value = parsePrimary();
        while (peek() === "*" || peek() === "/") {
            const operator = take();
            const right = parsePrimary();
            if (operator === "/" && right.isZero()) {
                throw new Error(`Division by zero in "${expression}".`);
            }
            value = operator === "*" ? value.mul(right) : value.div(right);
        }
        return value;
    };

    const parseExpression = (): Decimal => {
        let value = parseTerm();
        while (peek() === "+" || peek() === "-") {
            const operator = take();
            const right = parseTerm();
            value = operator === "+" ? value.plus(right) : value.minus(right);
        }
        return value;
    };

    const result = parseExpression();
    if (index !== tokens.length) {
        throw new Error(`Unexpected token "${tokens[index]}" in "${expression}".`);
    }
    return result;
};

export interface LedgerLineResult extends LedgerEventLine {
    value: string;
}

export interface LedgerEntryResult {
    label: string;
    lines: LedgerLineResult[];
    debitTotal: string;
    creditTotal: string;
    balanced: boolean;
}

export interface LedgerEquationResult {
    left: string;
    rightPlus: string;
    rightMinus: string;
    right: string;
    ok: boolean;
}

export interface LedgerEventResult {
    event: LedgerEvent;
    entries: LedgerEntryResult[];
    variables: Record<string, string>;
    balances: Record<string, string>;
    equation: LedgerEquationResult;
    showBalance?: { label: string; value: string };
}

export const formatLedgerAmount = (value: Decimal): string =>
    value.toFixed(4, Decimal.ROUND_HALF_UP);

const buildVariables = (
    data: LedgerData,
    overrides: Record<string, string | number> = {},
): Variables => {
    const variables: Variables = {};
    for (const [key, value] of Object.entries(data.defaults)) {
        if (key === "sur") continue;
        variables[key] = new Decimal(value);
    }
    for (const [key, value] of Object.entries(overrides)) {
        variables[key] = new Decimal(value);
    }
    for (const [key, expression] of Object.entries(data.derived)) {
        variables[key] = evaluateAmountExpression(expression, variables);
    }
    const surDefault = data.defaults.sur;
    if (overrides.sur !== undefined) {
        variables.sur = new Decimal(overrides.sur);
    } else if (surDefault !== undefined) {
        if (variables[surDefault]) {
            variables.sur = variables[surDefault];
        } else if (/^-?\d+(?:\.\d+)?$/.test(surDefault)) {
            variables.sur = new Decimal(surDefault);
        } else {
            variables.sur = evaluateAmountExpression(surDefault, variables);
        }
    }
    return variables;
};

const accountClass = (data: LedgerData, account: string): string =>
    data.accounts.find((entry) => entry.id === account)?.class ?? "LEFT";

const accountNormal = (data: LedgerData, account: string): string =>
    data.accounts.find((entry) => entry.id === account)?.normal ?? "DEBIT";

const evaluateEntry = (
    data: LedgerData,
    entry: LedgerEventEntry,
    variables: Variables,
): LedgerEntryResult => {
    const lines: LedgerLineResult[] = entry.lines.map((line) => ({
        ...line,
        value: formatLedgerAmount(evaluateAmountExpression(line.amount, variables)),
    }));
    const debit = lines
        .filter((line) => line.side === "DR")
        .reduce((total, line) => total.plus(line.value), new Decimal(0));
    const credit = lines
        .filter((line) => line.side === "CR")
        .reduce((total, line) => total.plus(line.value), new Decimal(0));
    return {
        label: entry.label,
        lines,
        debitTotal: formatLedgerAmount(debit),
        creditTotal: formatLedgerAmount(credit),
        balanced: debit.eq(credit),
    };
};

const addEntryToBalances = (
    data: LedgerData,
    balances: Record<string, Decimal>,
    entry: LedgerEntryResult,
): void => {
    for (const line of entry.lines) {
        const account = line.account;
        if (!balances[account]) balances[account] = new Decimal(0);
        const amount = new Decimal(line.value);
        const normal = accountNormal(data, account);
        if (normal === "DEBIT") {
            balances[account] = line.side === "DR" ? balances[account].plus(amount) : balances[account].minus(amount);
        } else {
            balances[account] = line.side === "CR" ? balances[account].plus(amount) : balances[account].minus(amount);
        }
    }
};

export const equationFor = (
    data: LedgerData,
    balances: Record<string, Decimal>,
): LedgerEquationResult => {
    let left = new Decimal(0);
    let rightPlus = new Decimal(0);
    let rightMinus = new Decimal(0);
    for (const [account, balance] of Object.entries(balances)) {
        const klass = accountClass(data, account);
        if (klass === "LEFT") left = left.plus(balance);
        else if (klass === "RIGHT_PLUS") rightPlus = rightPlus.plus(balance);
        else if (klass === "RIGHT_MINUS") rightMinus = rightMinus.plus(balance);
    }
    const right = rightPlus.minus(rightMinus);
    return {
        left: formatLedgerAmount(left),
        rightPlus: formatLedgerAmount(rightPlus),
        rightMinus: formatLedgerAmount(rightMinus),
        right: formatLedgerAmount(right),
        ok: left.eq(right),
    };
};

export const simulateLedger = (
    data: LedgerData,
    overrides: Record<string, string | number> = {},
): LedgerEventResult[] => {
    const variables = buildVariables(data, overrides);
    const balances: Record<string, Decimal> = {};
    const results: LedgerEventResult[] = [];
    for (const event of data.events) {
        const entries = event.entries.map((entry) => evaluateEntry(data, entry, variables));
        for (const entry of entries) {
            addEntryToBalances(data, balances, entry);
        }
        const equation = equationFor(data, balances);
        results.push({
            event,
            entries,
            variables: Object.fromEntries(
                Object.entries(variables).map(([key, value]) => [key, formatLedgerAmount(value)]),
            ),
            balances: Object.fromEntries(
                Object.entries(balances).map(([key, value]) => [key, formatLedgerAmount(value)]),
            ),
            equation,
            showBalance:
                event.showBalance && event.showBalance.expr
                    ? {
                          label: event.showBalance.label,
                          value: formatLedgerAmount(
                              evaluateAmountExpression(event.showBalance.expr, variables),
                          ),
                      }
                    : undefined,
        });
    }
    return results;
};

export const simulateLedgerEvent = (
    data: LedgerData,
    eventId: string,
    overrides: Record<string, string | number> = {},
): LedgerEventResult | undefined =>
    simulateLedger(data, overrides).find((result) => result.event.id === eventId);

export const ledgerVariables = (data: LedgerData, overrides: Record<string, string | number> = {}) =>
    Object.fromEntries(
        Object.entries(buildVariables(data, overrides)).map(([key, value]) => [key, formatLedgerAmount(value)]),
    );
