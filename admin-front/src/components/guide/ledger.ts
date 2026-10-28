import Decimal from "decimal.js";

export type LedgerAccountType = "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";

export type LedgerEvent = {
    id: string;
    labelEn: string;
    labelAr: string;
    noteEn: string;
    noteAr: string;
};

export type LedgerLine = {
    account: string;
    side: "DEBIT" | "CREDIT";
    amount: Decimal;
};

export type LedgerRow = LedgerLine & {
    runningBalance: Decimal;
    accountType: LedgerAccountType;
};

export type Journal = {
    lines: LedgerLine[];
    debitTotal: Decimal;
    creditTotal: Decimal;
    balanced: boolean;
};

export const ACCOUNT_TYPES: Record<string, LedgerAccountType> = {
    GATEWAY_CLEARING: "ASSET",
    INTERNAL_CLEARING: "ASSET",
    PLATFORM_BANK: "ASSET",
    MERCHANT_RECEIVABLE: "ASSET",
    AML_HOLD: "LIABILITY",
    CHARGEBACK_RESERVE: "LIABILITY",
    MERCHANT_PAYABLE: "LIABILITY",
    FEE_REVENUE: "REVENUE",
    PLATFORM_LOSS: "EXPENSE",
};

export const LEDGER_EVENTS: LedgerEvent[] = [
    {
        id: "1",
        labelEn: "Platform-held confirm",
        labelAr: "تأكيد الدفع المحتفظ به لدى المنصة",
        noteEn: "Customer money lands in gateway clearing; the merchant payable is credited.",
        noteAr: "أموال العميل تدخل مقاصة البوابة ويُقيد مستحق التاجر دائناً.",
    },
    {
        id: "2",
        labelEn: "Fee accrual",
        labelAr: "استحقاق الرسم",
        noteEn: "Commission is deducted from the merchant payable and recognized as fee revenue.",
        noteAr: "تُخصم العمولة من مستحق التاجر وتُعترف إيراداً للرسوم.",
    },
    {
        id: "3",
        labelEn: "Settlement sweep",
        labelAr: "مسح التسوية",
        noteEn: "Cleared funds move from gateway clearing to the platform bank account.",
        noteAr: "تنتقل الأموال المطابقة من مقاصة البوابة إلى حساب بنك المنصة.",
    },
    {
        id: "4",
        labelEn: "Fee variance",
        labelAr: "فرق الرسم",
        noteEn: "A statement fee differs from the expected fee; the small difference is posted to fee revenue.",
        noteAr: "رسم الكشف يختلف عن الرسم المتوقع، ويُقيد الفرق الصغير في إيراد الرسوم.",
    },
    {
        id: "5",
        labelEn: "Payer surcharge",
        labelAr: "رسم إضافي على الدافع",
        noteEn: "The payer covers the commission, so clearing and merchant payable both increase.",
        noteAr: "يتحمل الدافع العمولة، فيزداد كل من المقاصة ومستحق التاجر.",
    },
    {
        id: "6",
        labelEn: "Merchant-direct confirm / netting",
        labelAr: "تأكيد مباشر للتاجر / التسوية الصافية",
        noteEn: "The merchant receives directly; the platform records the gross receivable, net payable, and fee.",
        noteAr: "يستلم التاجر مباشرة؛ تسجل المنصة المستحق الإجمالي والصافي والرسم.",
    },
    {
        id: "7",
        labelEn: "AML hold / release",
        labelAr: "حجز مكافحة غسل الأموال / الإفراج",
        noteEn: "The paying amount is held, then released. Both legs are shown so the hold account returns to zero.",
        noteAr: "يُحجز مبلغ الدفع ثم يُفرج عنه. يظهر الشقان ليعود حساب الحجز إلى الصفر.",
    },
    {
        id: "8",
        labelEn: "Merchant cash-out",
        labelAr: "سحب نقدي للتاجر",
        noteEn: "Net merchant funds leave the payable and are paid from the platform bank.",
        noteAr: "تخرج صافي أموال التاجر من المستحق وتُدفع من بنك المنصة.",
    },
    {
        id: "9",
        labelEn: "Full refund",
        labelAr: "استرداد كامل",
        noteEn: "Principal is returned and the commission is reversed.",
        noteAr: "يُعاد الأصل ويُعكس الرسم.",
    },
    {
        id: "10",
        labelEn: "Chargeback reserve / lost",
        labelAr: "احتياطي الاسترداد العكسي / الخسارة",
        noteEn: "A reserve is built from the merchant payable, then consumed when the chargeback is lost.",
        noteAr: "يُبنى احتياطي من مستحق التاجر ثم يُستهلك عند خسارة الاسترداد العكسي.",
    },
    {
        id: "11",
        labelEn: "AML void",
        labelAr: "إبطال إجراء مكافحة غسل الأموال",
        noteEn: "The hold is voided and the merchant payable is restored.",
        noteAr: "يُبطل الحجز ويُعاد مستحق التاجر.",
    },
    {
        id: "12",
        labelEn: "Chargeback won",
        labelAr: "كسب الاسترداد العكسي",
        noteEn: "The reserve is released back to the merchant payable.",
        noteAr: "يُفرج عن الاحتياطي لصالح مستحق التاجر.",
    },
    {
        id: "13",
        labelEn: "Internal gateway confirm",
        labelAr: "تأكيد بوابة داخلية",
        noteEn: "No external clearing: the internal receivable, net payable, and fee are posted.",
        noteAr: "لا مقاصة خارجية: يُقيد المستحق الداخلي والصافي والرسم.",
    },
    {
        id: "14",
        labelEn: "Internal gateway refund",
        labelAr: "استرداد بوابة داخلية",
        noteEn: "The internal payment is reversed together with its commission.",
        noteAr: "تُعكس الدفعة الداخلية مع عمولتها.",
    },
    {
        id: "15",
        labelEn: "Insufficient chargeback",
        labelAr: "استرداد عكسي غير مغطى",
        noteEn: "The merchant cannot cover the chargeback; the platform recognizes the loss.",
        noteAr: "لا يستطيع التاجر تغطية الاسترداد العكسي؛ تعترف المنصة بالخسارة.",
    },
];

const d = (value: Decimal.Value): Decimal => new Decimal(value);

const eventById = (id: string): LedgerEvent =>
    LEDGER_EVENTS.find((entry) => entry.id === id) ?? LEDGER_EVENTS[0]!;

export const describeEvent = (id: string): LedgerEvent => eventById(id);

export const computeJournal = (eventId: string, rawAmount: string, rawCommission: string): Journal => {
    const parsedAmount = new Decimal(rawAmount || "0");
    const amount = parsedAmount.isFinite() && parsedAmount.greaterThan(0) ? parsedAmount.toDecimalPlaces(3, Decimal.ROUND_HALF_UP) : d(0);
    const parsedCommission = new Decimal(rawCommission || "0");
    const commission = parsedCommission.isFinite() && parsedCommission.greaterThanOrEqualTo(0) ? parsedCommission : d(0);
    const fee = amount.times(commission).div(100).toDecimalPlaces(3, Decimal.ROUND_HALF_UP);
    const net = amount.minus(fee);
    const variance = fee.times("0.1").toDecimalPlaces(3, Decimal.ROUND_HALF_UP);
    const surcharge = fee.greaterThan(0) ? fee : amount.times("0.01").toDecimalPlaces(3, Decimal.ROUND_HALF_UP);

    const line = (account: string, side: LedgerLine["side"], value: Decimal): LedgerLine => ({ account, side, amount: value });

    let lines: LedgerLine[] = [];

    switch (eventId) {
        case "1":
            lines = [line("GATEWAY_CLEARING", "DEBIT", amount), line("MERCHANT_PAYABLE", "CREDIT", amount)];
            break;
        case "2":
            lines = [line("MERCHANT_PAYABLE", "DEBIT", fee), line("FEE_REVENUE", "CREDIT", fee)];
            break;
        case "3":
            lines = [line("PLATFORM_BANK", "DEBIT", amount), line("GATEWAY_CLEARING", "CREDIT", amount)];
            break;
        case "4":
            lines = [line("MERCHANT_PAYABLE", "DEBIT", variance), line("FEE_REVENUE", "CREDIT", variance)];
            break;
        case "5":
            lines = [line("GATEWAY_CLEARING", "DEBIT", surcharge), line("MERCHANT_PAYABLE", "CREDIT", surcharge)];
            break;
        case "6":
        case "13":
            lines = [
                line("MERCHANT_RECEIVABLE", "DEBIT", amount),
                line("MERCHANT_PAYABLE", "CREDIT", net),
                line("FEE_REVENUE", "CREDIT", fee),
            ];
            break;
        case "7":
            lines = [
                line("MERCHANT_PAYABLE", "DEBIT", amount),
                line("AML_HOLD", "CREDIT", amount),
                line("AML_HOLD", "DEBIT", amount),
                line("MERCHANT_PAYABLE", "CREDIT", amount),
            ];
            break;
        case "8":
            lines = [line("MERCHANT_PAYABLE", "DEBIT", net), line("PLATFORM_BANK", "CREDIT", net)];
            break;
        case "9":
        case "14":
            lines = [
                line("MERCHANT_PAYABLE", "DEBIT", amount),
                line(eventId === "14" ? "INTERNAL_CLEARING" : "GATEWAY_CLEARING", "CREDIT", amount),
                line("FEE_REVENUE", "DEBIT", fee),
                line("MERCHANT_PAYABLE", "CREDIT", fee),
            ];
            break;
        case "10":
            lines = [
                line("MERCHANT_PAYABLE", "DEBIT", amount),
                line("CHARGEBACK_RESERVE", "CREDIT", amount),
                line("CHARGEBACK_RESERVE", "DEBIT", amount),
                line("GATEWAY_CLEARING", "CREDIT", amount),
            ];
            break;
        case "11":
            lines = [line("AML_HOLD", "DEBIT", amount), line("MERCHANT_PAYABLE", "CREDIT", amount)];
            break;
        case "12":
            lines = [line("CHARGEBACK_RESERVE", "DEBIT", amount), line("MERCHANT_PAYABLE", "CREDIT", amount)];
            break;
        case "15":
            lines = [line("PLATFORM_LOSS", "DEBIT", amount), line("GATEWAY_CLEARING", "CREDIT", amount)];
            break;
        default:
            lines = [line("GATEWAY_CLEARING", "DEBIT", amount), line("MERCHANT_PAYABLE", "CREDIT", amount)];
            break;
    }

    const debitTotal = lines.filter((entry) => entry.side === "DEBIT").reduce((total, entry) => total.plus(entry.amount), d(0));
    const creditTotal = lines.filter((entry) => entry.side === "CREDIT").reduce((total, entry) => total.plus(entry.amount), d(0));

    return {
        lines,
        debitTotal,
        creditTotal,
        balanced: debitTotal.equals(creditTotal),
    };
};

export const buildLedgerRows = (lines: LedgerLine[]): LedgerRow[] => {
    const balances: Record<string, Decimal> = {};
    return lines.map((entry) => {
        const accountType = ACCOUNT_TYPES[entry.account] ?? "ASSET";
        const previous = balances[entry.account] ?? d(0);
        const debitNormal = accountType === "ASSET" || accountType === "EXPENSE";
        const delta = debitNormal
            ? entry.side === "DEBIT"
                ? entry.amount
                : entry.amount.negated()
            : entry.side === "CREDIT"
              ? entry.amount
              : entry.amount.negated();
        const runningBalance = previous.plus(delta);
        balances[entry.account] = runningBalance;
        return { ...entry, runningBalance, accountType };
    });
};

export const formatLedgerAmount = (value: Decimal): string => value.toFixed(3);
