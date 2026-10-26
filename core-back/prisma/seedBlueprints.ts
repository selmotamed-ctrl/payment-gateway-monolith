import type { CollectionMode, PrismaClient } from "../generated/prisma/client";

export interface BlueprintCatalogEntry {
  key: string;
  name: string;
  description: string;
  gatewayCodes: string[];
  railCodes: string[];
  collectionModes: string[];
  kind: "DIRECT" | "AGGREGATOR" | "NATIVE_ADAPTER" | "INTERNAL";
  country: string;
  riskClass: "NORMAL" | "HIGH_RISK";
}

export const BLUEPRINT_CATALOG: BlueprintCatalogEntry[] = [
  {
    key: "edfali-sadad-otp",
    name: "Edfali & Sadad OTP",
    description: "Two-step OTP_PULL payments with retryable OTP confirmation.",
    gatewayCodes: ["edfali", "sadad"],
    railCodes: ["edfali", "sadad"],
    collectionModes: ["OTP_PULL"],
    kind: "DIRECT",
    country: "LY",
    riskClass: "NORMAL",
  },
  {
    key: "moamalat-lightbox",
    name: "Moamalat National Switch",
    description: "EMBEDDED Lightbox with Hex-HMAC and mandatory inquiry.",
    gatewayCodes: ["moamalat"],
    railCodes: ["moamalat_card"],
    collectionModes: ["EMBEDDED"],
    kind: "DIRECT",
    country: "LY",
    riskClass: "NORMAL",
  },
  {
    key: "cbl-lypay",
    name: "CBL LYPay Instant Payment",
    description: "QR_DISPLAY and PUSH_APPROVAL with synchronous confirmation, webhook, and enquiry.",
    gatewayCodes: ["cbl_lypay"],
    railCodes: ["lypay"],
    collectionModes: ["QR_DISPLAY", "PUSH_APPROVAL"],
    kind: "DIRECT",
    country: "LY",
    riskClass: "NORMAL",
  },
  {
    key: "mypay-tlync-redirect",
    name: "MyPay & Tadawul T-LYNC Redirect",
    description: "REDIRECT hosted checkout with signed callbacks and receipt inquiry.",
    gatewayCodes: ["mypay", "tlync"],
    railCodes: ["mypay", "tlync"],
    collectionModes: ["REDIRECT"],
    kind: "AGGREGATOR",
    country: "LY",
    riskClass: "NORMAL",
  },
  {
    key: "hybrid-wallet-rails",
    name: "MobiCash, OnePay, Yussor & Sahara Hybrid",
    description: "HYBRID card, pay-code, and EMVCo QR collection rails.",
    gatewayCodes: ["mobicash", "onepay", "yussor", "sahara"],
    railCodes: ["mobicash", "onepay", "yussor", "sahara"],
    collectionModes: ["HYBRID"],
    kind: "DIRECT",
    country: "LY",
    riskClass: "NORMAL",
  },
  {
    key: "mpgs-evo-pay",
    name: "MPGS 3DS2 & Evo Pay",
    description: "EMBEDDED and REDIRECT multi-currency card and wallet checkout.",
    gatewayCodes: ["mpgs", "evo_pay"],
    railCodes: ["mpgs", "evo_pay"],
    collectionModes: ["EMBEDDED", "REDIRECT"],
    kind: "DIRECT",
    country: "LY",
    riskClass: "HIGH_RISK",
  },
  {
    key: "neompay-internal",
    name: "NeomPay First-Party Wallet",
    description: "INTERNAL PUSH_APPROVAL, OTP_PULL, and QR_DISPLAY wallet rail.",
    gatewayCodes: ["neompay"],
    railCodes: ["neompay_wallet"],
    collectionModes: ["PUSH_APPROVAL", "OTP_PULL", "QR_DISPLAY"],
    kind: "INTERNAL",
    country: "LY",
    riskClass: "NORMAL",
  },
];

const gatewayDetails: Record<string, { name: string; operator: string; aliases: string[] }> = {
  edfali: { name: "Edfali", operator: "Banque de Commerce", aliases: ["Edfaa Li", "Adfali"] },
  sadad: { name: "Sadad", operator: "Almadar Aljadeed", aliases: ["Almadar"] },
  moamalat: { name: "Moamalat National Switch", operator: "National Payment Gateway", aliases: ["NPG", "Moamalat"] },
  cbl_lypay: { name: "CBL LYPay", operator: "Central Bank of Libya", aliases: ["LYPay", "CBL Instant Payment"] },
  mypay: { name: "MyPay", operator: "MyPay", aliases: ["MyPay Aggregator"] },
  tlync: { name: "Tadawul T-LYNC", operator: "Tadawul", aliases: ["T-LYNC", "TDSP"] },
  mobicash: { name: "MobiCash", operator: "Masarat", aliases: ["Mobi Cash"] },
  onepay: { name: "OnePay", operator: "CBL", aliases: ["CBL OnePay"] },
  yussor: { name: "Yussor Pay", operator: "National Commercial Bank", aliases: ["Yussor"] },
  sahara: { name: "Sahara Pay", operator: "Sahara Bank", aliases: ["Sahara"] },
  mpgs: { name: "Mastercard Payment Gateway Services", operator: "MPGS", aliases: ["Visa", "Mastercard", "3DS2"] },
  evo_pay: { name: "Evo Pay", operator: "Evo Wallet", aliases: ["EvoPay"] },
  neompay: { name: "NeomPay", operator: "Neom", aliases: ["Neom Wallet"] },
};

const railDetails: Record<
  string,
  { nameAr: string; nameEn: string; mode: CollectionMode }
> = {
  edfali: { nameAr: "إدفالي", nameEn: "Edfali", mode: "OTP_PULL" },
  sadad: { nameAr: "سداد", nameEn: "Sadad", mode: "OTP_PULL" },
  moamalat_card: { nameAr: "بطاقة مصرففا مصرفف", nameEn: "Moamalat Card", mode: "EMBEDDED" },
  lypay: { nameAr: "لاي باي", nameEn: "LYPay", mode: "QR_DISPLAY" },
  mypay: { nameAr: "ماي باي", nameEn: "MyPay", mode: "REDIRECT" },
  tlync: { nameAr: "تي لينك", nameEn: "T-LYNC", mode: "REDIRECT" },
  mobicash: { nameAr: "موبي كاش", nameEn: "MobiCash", mode: "HYBRID" },
  onepay: { nameAr: "ون باي", nameEn: "OnePay", mode: "HYBRID" },
  yussor: { nameAr: "يوسور", nameEn: "Yussor Pay", mode: "HYBRID" },
  sahara: { nameAr: "صحراء باي", nameEn: "Sahara Pay", mode: "HYBRID" },
  mpgs: { nameAr: "فيزا وماستركارد", nameEn: "Visa & Mastercard", mode: "EMBEDDED" },
  evo_pay: { nameAr: "إيفو باي", nameEn: "Evo Pay", mode: "REDIRECT" },
  neompay_wallet: { nameAr: "محفظة نيوم باي", nameEn: "NeomPay Wallet", mode: "HYBRID" },
};

export const seedBlueprints = async (prisma: PrismaClient) => {
  for (const blueprint of BLUEPRINT_CATALOG) {
    for (const gatewayCode of blueprint.gatewayCodes) {
      const details = gatewayDetails[gatewayCode];
      if (!details) {
        continue;
      }
      await prisma.gateway.upsert({
        where: { code: gatewayCode },
        update: {
          name: details.name,
          operator: details.operator,
          aliases: details.aliases,
          kind: blueprint.kind,
          country: blueprint.country,
          riskClass: blueprint.riskClass,
          metadata: {
            blueprintKey: blueprint.key,
            collectionModes: blueprint.collectionModes,
            description: blueprint.description,
          },
        },
        create: {
          code: gatewayCode,
          name: details.name,
          operator: details.operator,
          aliases: details.aliases,
          kind: blueprint.kind,
          country: blueprint.country,
          riskClass: blueprint.riskClass,
          metadata: {
            blueprintKey: blueprint.key,
            collectionModes: blueprint.collectionModes,
            description: blueprint.description,
          },
        },
      });
    }

    for (const railCode of blueprint.railCodes) {
      const details = railDetails[railCode];
      if (!details) {
        continue;
      }
      await prisma.rail.upsert({
        where: { code: railCode },
        update: {
          nameAr: details.nameAr,
          nameEn: details.nameEn,
          collectionMode: details.mode,
          capabilities: {
            refund: true,
            partialRefund: true,
            void: true,
            capture: true,
            recurring: false,
          },
          metadata: {
            blueprintKey: blueprint.key,
            collectionModes: blueprint.collectionModes,
          },
        },
        create: {
          code: railCode,
          nameAr: details.nameAr,
          nameEn: details.nameEn,
          collectionMode: details.mode,
          capabilities: {
            refund: true,
            partialRefund: true,
            void: true,
            capture: true,
            recurring: false,
          },
          metadata: {
            blueprintKey: blueprint.key,
            collectionModes: blueprint.collectionModes,
          },
        },
      });
    }
  }
};
