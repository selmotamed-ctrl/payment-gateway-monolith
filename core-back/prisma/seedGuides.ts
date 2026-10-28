import type { PrismaClient } from "../generated/prisma/client";
import { Prisma } from "../generated/prisma/client";

/**
 * Seeds the content of the four built-in portal guides.
 *
 * The checkout help center is entirely data driven: the support channels come
 * from the `checkout.support_config` platform setting and the per-rail
 * walkthroughs come from `rails.help_guide_json`. An operator can edit both
 * from the admin portal, and the payer sees the change immediately.
 */

export interface SupportConfig {
  enabled: boolean;
  show_platform_contact: boolean;
  show_merchant_contact: boolean;
  support_phone: string;
  support_whatsapp: string;
  support_email: string;
  working_hours_ar: string;
  working_hours_en: string;
  faq_items: Array<{ q_ar: string; a_ar: string; q_en: string; a_en: string }>;
}

export const CHECKOUT_SUPPORT_CONFIG_KEY = "checkout.support_config";

export const DEFAULT_SUPPORT_CONFIG: SupportConfig = {
  enabled: true,
  show_platform_contact: true,
  show_merchant_contact: true,
  support_phone: "+218910000000",
  support_whatsapp: "+218910000000",
  support_email: "support@yourdomain.ly",
  working_hours_ar: "السبت - الخميس: 9:00 صباحاً - 6:00 مساءً",
  working_hours_en: "Sat - Thu: 09:00 AM - 06:00 PM (Tripoli Time)",
  faq_items: [
    {
      q_ar: "تم خصم المبلغ من حسابي ولكن الصفحة لا تزال قيد التأكيد، ماذا أفعل؟",
      a_ar: "لا تقم بإعادة الدفع. يحتفظ النظام برقم العملية المرجعي ويتحقق تلقائياً من المصرف أو المحفظة، وستتحول الصفحة إلى النتيجة النهائية بمجرد وصول التأكيد. إذا استمر التعليق أكثر من 15 دقيقة، أرسل الرقم المرجعي إلى الدعم.",
      q_en: "Money was deducted from my account but the page still says Confirming. What should I do?",
      a_en: "Do not pay again. The platform keeps your payment reference and verifies the status with the bank or wallet automatically; the page switches to the final result as soon as the confirmation arrives. If it stays pending for more than 15 minutes, share the reference with support.",
    },
    {
      q_ar: "لم يصلني رمز التحقق عبر الرسائل النصية.",
      a_ar: "تأكد من صحة رقم الهاتف وأنه مسجل في الخدمة، ثم استخدم زر إعادة الإرسال بعد انتهاء فترة الانتظار. لا تطلب الرمز أكثر من ثلاث مرات.",
      q_en: "I did not receive the verification code by SMS.",
      a_en: "Check the phone number and that it is enrolled in the service, then use Resend after the cooldown. Do not request the code more than three times.",
    },
    {
      q_ar: "هل يمكنني الدفع مرة أخرى إذا فشلت المحاولة؟",
      a_ar: "نعم، ما دام الرابط لم يستخدم بعد. إذا ظهرت حالة غير مؤكدة، افتح صفحة الحالة وانتظر التحقق بدلاً من إعادة الدفع.",
      q_en: "Can I pay again if the attempt failed?",
      a_en: "Yes, as long as the link has not been used. If the status is unknown, open the status page and wait for the verification instead of paying again.",
    },
  ],
};

export interface RailHelpGuide {
  steps_ar: string[];
  steps_en: string[];
  prerequisites_ar: string[];
  prerequisites_en: string[];
  troubleshooting_ar: Array<{ q_ar: string; a_ar: string }>;
  troubleshooting_en: Array<{ q_en: string; a_en: string }>;
}

/** The 13 seeded rails, each with its own walkthrough. */
export const RAIL_HELP_GUIDES: Record<string, RailHelpGuide> = {
  edfali: {
    steps_ar: [
      "أدخل رقم هاتفك (091xxxxxxx) واضغط متابعة.",
      "سيصلك رمز تحقق عبر رسالة نصية من Edfali.",
      "أدخل الرمز خلال 10 دقائق لتأكيد الدفع.",
    ],
    steps_en: [
      "Enter your phone number (091xxxxxxx) and continue.",
      "You will receive a verification code by SMS from Edfali.",
      "Enter the code within 10 minutes to confirm the payment.",
    ],
    prerequisites_ar: ["يجب أن يكون رقمك مسجلاً في خدمة Edfali", "تأكد من وجود رصيد كافٍ في المحفظة"],
    prerequisites_en: ["Your number must be enrolled in Edfali", "Make sure the wallet has enough balance"],
    troubleshooting_ar: [
      { q_ar: "لم يصل الرمز", a_ar: "انتظر دقيقة ثم استخدم إعادة الإرسال؛ لا تطلب الرمز أكثر من ثلاث مرات." },
      { q_ar: "الرمز غير صحيح", a_ar: "أعد إدخال الرمز بدقة. بعد ثلاث محاولات خاطئة تُلغى العملية تلقائياً." },
    ],
    troubleshooting_en: [
      { q_en: "The code did not arrive", a_en: "Wait a minute then use Resend; do not request it more than three times." },
      { q_en: "The code is incorrect", a_en: "Re-enter it carefully. After three wrong attempts the payment is cancelled automatically." },
    ],
  },
  sadad: {
    steps_ar: [
      "أدخل رقمك (091xxxxxxx) وسنة الميلاد المكونة من 4 أرقام.",
      "سيصلك رمز من 6 أرقام عبر رسالة نصية من Sadad.",
      "أدخل الرمز خلال 10 دقائق لإتمام الدفع.",
    ],
    steps_en: [
      "Enter your number (091xxxxxxx) and your 4-digit birth year.",
      "You will receive a 6-digit code by SMS from Sadad.",
      "Enter the code within 10 minutes to complete the payment.",
    ],
    prerequisites_ar: ["أن تكون مشتركاً في خدمة سداد", "معرفة سنة الميلاد المسجلة في الخدمة"],
    prerequisites_en: ["You must be subscribed to Sadad", "Know the birth year registered with the service"],
    troubleshooting_ar: [
      { q_ar: "سنة الميلاد مرفوضة", a_ar: "استخدم سنة الميلاد المسجلة في سداد، وليس سنة أخرى." },
      { q_ar: "الحساب موقوف", a_ar: "تواصل مع سداد لإعادة تفعيل الخدمة ثم أعد المحاولة." },
    ],
    troubleshooting_en: [
      { q_en: "The birth year is rejected", a_en: "Use the birth year registered with Sadad, not another one." },
      { q_en: "The account is suspended", a_en: "Contact Sadad to reactivate the service, then try again." },
    ],
  },
  moamalat_card: {
    steps_ar: [
      "اضغط \"ادفع الآن\" لفتح نافذة Moamalat الآمنة.",
      "أدخل رقم بطاقتك المحلية وتاريخ الانتهاء والرقم السري.",
      "انتظر التأكيد التلقائي ثم عد إلى هذه الصفحة.",
    ],
    steps_en: [
      "Click \"Pay now\" to open the secure Moamalat window.",
      "Enter your local card number, expiry date and PIN.",
      "Wait for the automatic confirmation, then return to this page.",
    ],
    prerequisites_ar: ["بطاقة مصرفية محلية مفعّلة للدفع عبر الإنترنت"],
    prerequisites_en: ["A local bank card enabled for online payments"],
    troubleshooting_ar: [
      { q_ar: "أُغلقت النافذة", a_ar: "أعد المحاولة ولا تغلق الصفحة حتى تظهر النتيجة." },
      { q_ar: "تم الخصم ولم تظهر النتيجة", a_ar: "انتظر التحقق التلقائي، ولا تدفع مرة أخرى؛ استخدم الرقم المرجعي مع الدعم." },
    ],
    troubleshooting_en: [
      { q_en: "The window closed", a_en: "Try again and do not close the page until the result appears." },
      { q_en: "Charged but no result", a_en: "Wait for the automatic verification and do not pay again; use the reference with support." },
    ],
  },
  cbl_lypay: {
    steps_ar: [
      "سيظهر رمز QR أو رمز دفع خاص بالعملية.",
      "افتح تطبيق LYPay وامسح الرمز أو أدخل رمز الدفع.",
      "أكّد التحويل من التطبيق وانتظر التحقق التلقائي.",
    ],
    steps_en: [
      "A QR code or pay code for this payment is shown.",
      "Open the LYPay app and scan the code or enter the pay code.",
      "Confirm the transfer in the app and wait for the automatic verification.",
    ],
    prerequisites_ar: ["تطبيق LYPay مفعّل", "رصيد كافٍ في المحفظة"],
    prerequisites_en: ["The LYPay app is activated", "Enough wallet balance"],
    troubleshooting_ar: [
      { q_ar: "الرمز انتهت صلاحيته", a_ar: "أعد تحميل الصفحة لإنشاء رمز جديد." },
      { q_ar: "لم يتم التعرف على الرمز", a_ar: "تأكد من استخدامك لرمز هذه العملية وليس رمزاً سابقاً." },
    ],
    troubleshooting_en: [
      { q_en: "The code expired", a_en: "Reload the page to generate a new code." },
      { q_en: "The code is not recognised", a_en: "Make sure you use this payment's code, not an older one." },
    ],
  },
  lypay: {
    steps_ar: [
      "سيظهر رمز QR متوافق مع EMVCo.",
      "امسح الرمز من تطبيق LYPay في هاتفك.",
      "أكّد الدفع وانتظر ظهور النتيجة.",
    ],
    steps_en: [
      "An EMVCo-compatible QR code is shown.",
      "Scan it with the LYPay app on your phone.",
      "Confirm the payment and wait for the result.",
    ],
    prerequisites_ar: ["تطبيق LYPay", "رصيد كافٍ"],
    prerequisites_en: ["The LYPay app", "Enough balance"],
    troubleshooting_ar: [{ q_ar: "الكاميرا لا تتعرف على الرمز", a_ar: "زد سطوع الشاشة وقرّب الهاتف من الرمز." }],
    troubleshooting_en: [{ q_en: "The camera does not read the code", a_en: "Increase the screen brightness and move the phone closer." }],
  },
  mypay: {
    steps_ar: ["اضغط \"متابعة\" للانتقال إلى صفحة MyPay.", "اختر وسيلة الدفع وأكمل العملية.", "ستعود إلى هذه الصفحة تلقائياً بعد الدفع."],
    steps_en: ["Click \"Continue\" to go to the MyPay page.", "Choose your payment method and complete it.", "You are returned to this page automatically afterwards."],
    prerequisites_ar: ["أن تكون الصفحة المنبثقة مسموحة في المتصفح"],
    prerequisites_en: ["Pop-ups must be allowed in your browser"],
    troubleshooting_ar: [{ q_ar: "لم أعد إلى الصفحة", a_ar: "افتح صفحة الحالة من الرابط المرجعي الموجود في الصفحة." }],
    troubleshooting_en: [{ q_en: "I was not returned to the page", a_en: "Open the status page from the reference link shown here." }],
  },
  tlync: {
    steps_ar: ["اضغط \"متابعة\" للانتقال إلى T-LYNC.", "أدخل بيانات البطاقة أو اختر وسيلة الدفع.", "انتظر التأكيد ثم عد إلى هذه الصفحة."],
    steps_en: ["Click \"Continue\" to go to T-LYNC.", "Enter your card details or choose a method.", "Wait for the confirmation and return to this page."],
    prerequisites_ar: ["وسيلة دفع مفعّلة لدى T-LYNC"],
    prerequisites_en: ["A payment method enabled at T-LYNC"],
    troubleshooting_ar: [{ q_ar: "فشل التحقق", a_ar: "أعد المحاولة أو استخدم بطاقة أخرى." }],
    troubleshooting_en: [{ q_en: "Verification failed", a_en: "Try again or use another card." }],
  },
  mobicash: {
    steps_ar: [
      "احصل على رقم بطاقة المعاملة المكوّن من 7 أرقام من تطبيق Masarat أو MobiMal.",
      "أدخل الرقم في الحقل المخصص هنا.",
      "أكّد العملية من التطبيق.",
    ],
    steps_en: [
      "Get the 7-digit transaction card number from the Masarat or MobiMal app.",
      "Enter it in the field on this page.",
      "Confirm the operation in the app.",
    ],
    prerequisites_ar: ["تطبيق Masarat أو MobiMal", "رقم معاملة صالح"],
    prerequisites_en: ["The Masarat or MobiMal app", "A valid transaction number"],
    troubleshooting_ar: [{ q_ar: "الرقم مرفوض", a_ar: "تأكد من أنه 7 أرقام ومن أنه رقم هذه العملية." }],
    troubleshooting_en: [{ q_en: "The number is rejected", a_en: "Make sure it has 7 digits and belongs to this payment." }],
  },
  onepay: {
    steps_ar: ["سيظهر رمز QR قابل للمسح.", "امسحه من أحد تطبيقات المصارف الليبية المدعومة.", "أكّد الدفع."],
    steps_en: ["A scannable QR code is shown.", "Scan it with a supported Libyan bank app.", "Confirm the payment."],
    prerequisites_ar: ["تطبيق مصرفي يدعم OnePay"],
    prerequisites_en: ["A bank app that supports OnePay"],
    troubleshooting_ar: [{ q_ar: "تطبيقي غير مدعوم", a_ar: "استخدم أحد التطبيقات المذكورة أو اختر وسيلة أخرى." }],
    troubleshooting_en: [{ q_en: "My app is not supported", a_en: "Use one of the listed apps or choose another method." }],
  },
  yussor: {
    steps_ar: ["احصل على رقم بطاقة المعاملة من تطبيق Yussor.", "أدخله في الحقل المخصص.", "أكّد العملية من التطبيق."],
    steps_en: ["Get the transaction card number from the Yussor app.", "Enter it in the field on this page.", "Confirm the operation in the app."],
    prerequisites_ar: ["تطبيق Yussor ورصيد كافٍ"],
    prerequisites_en: ["The Yussor app and enough balance"],
    troubleshooting_ar: [{ q_ar: "انتهت صلاحية الرقم", a_ar: "أنشئ رقماً جديداً من التطبيق وأعد المحاولة." }],
    troubleshooting_en: [{ q_en: "The number expired", a_en: "Create a new one in the app and try again." }],
  },
  sahara: {
    steps_ar: ["احصل على رقم بطاقة المعاملة من تطبيق Sahara Pay.", "أدخله في الحقل المخصص.", "أكّد العملية من التطبيق."],
    steps_en: ["Get the transaction card number from the Sahara Pay app.", "Enter it in the field on this page.", "Confirm the operation in the app."],
    prerequisites_ar: ["تطبيق Sahara Pay ورصيد كافٍ"],
    prerequisites_en: ["The Sahara Pay app and enough balance"],
    troubleshooting_ar: [{ q_ar: "لم يتم العثور على العملية", a_ar: "تأكد من مطابقة رقم المعاملة." }],
    troubleshooting_en: [{ q_en: "The payment was not found", a_en: "Make sure the transaction number matches." }],
  },
  mpgs: {
    steps_ar: ["اضغط \"ادفع الآن\" لفتح صفحة الدفع الآمنة للبطاقة.", "أدخل بيانات البطاقة وأكمل التحقق المصرفي.", "انتظر التأكيد التلقائي."],
    steps_en: ["Click \"Pay now\" to open the secure card page.", "Enter your card details and complete the bank verification.", "Wait for the automatic confirmation."],
    prerequisites_ar: ["بطاقة فيزا أو ماستركارد مفعّلة للدفع عبر الإنترنت"],
    prerequisites_en: ["A Visa or Mastercard enabled for online payments"],
    troubleshooting_ar: [{ q_ar: "رفض البنك العملية", a_ar: "تواصل مع بنكك أو استخدم بطاقة أخرى." }],
    troubleshooting_en: [{ q_en: "The bank declined the payment", a_en: "Contact your bank or use another card." }],
  },
  evo_pay: {
    steps_ar: ["اضغط \"متابعة\" للانتقال إلى Evo Pay.", "أدخل بيانات البطاقة.", "انتظر التأكيد ثم عد إلى هذه الصفحة."],
    steps_en: ["Click \"Continue\" to go to Evo Pay.", "Enter your card details.", "Wait for the confirmation and return to this page."],
    prerequisites_ar: ["بطاقة مفعّلة"],
    prerequisites_en: ["An enabled card"],
    troubleshooting_ar: [{ q_ar: "فشل الدفع", a_ar: "أعد المحاولة أو استخدم وسيلة أخرى." }],
    troubleshooting_en: [{ q_en: "The payment failed", a_en: "Try again or use another method." }],
  },
  neompay_wallet: {
    steps_ar: ["أدخل رقم محفظة NeomPay (NP- متبوعاً بـ 12 رقماً).", "أكّد العملية من تطبيق NeomPay.", "انتظر التحقق التلقائي."],
    steps_en: ["Enter your NeomPay wallet id (NP- followed by 12 digits).", "Confirm the operation in the NeomPay app.", "Wait for the automatic verification."],
    prerequisites_ar: ["محفظة NeomPay مفعّلة", "رقم المحفظة الصحيح"],
    prerequisites_en: ["An activated NeomPay wallet", "The correct wallet id"],
    troubleshooting_ar: [{ q_ar: "رقم المحفظة غير صحيح", a_ar: "تأكد من الصيغة NP- ثم 12 رقماً." }],
    troubleshooting_en: [{ q_en: "The wallet id is invalid", a_en: "Make sure the format is NP- followed by 12 digits." }],
  },
};

export const seedCheckoutSupport = async (client: PrismaClient): Promise<void> => {
  await client.platformSetting.upsert({
    where: { key_scope_version: { key: CHECKOUT_SUPPORT_CONFIG_KEY, scope: "PLATFORM", version: 1 } },
    update: { valueJson: DEFAULT_SUPPORT_CONFIG as unknown as Prisma.InputJsonValue },
    create: {
      key: CHECKOUT_SUPPORT_CONFIG_KEY,
      scope: "PLATFORM",
      version: 1,
      valueJson: DEFAULT_SUPPORT_CONFIG as unknown as Prisma.InputJsonValue,
      effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    },
  });
};

export const seedRailHelpGuides = async (client: PrismaClient): Promise<number> => {
  let updated = 0;
  for (const [code, guide] of Object.entries(RAIL_HELP_GUIDES)) {
    const rail = await client.rail.findUnique({ where: { code } });
    if (!rail) {
      continue;
    }
    await client.rail.update({
      where: { id: rail.id },
      data: { helpGuideJson: guide as unknown as Prisma.InputJsonValue },
    });
    updated += 1;
  }
  return updated;
};
