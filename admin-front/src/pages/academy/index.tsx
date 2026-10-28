import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import {
    VAlert,
    VBtn,
    VCard,
    VCardText,
    VChip,
    VExpansionPanel,
    VExpansionPanelText,
    VExpansionPanelTitle,
    VExpansionPanels,
    VProgressLinear,
    VRadio,
    VRadioGroup,
    VSwitch,
} from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { StatusChip } from "@/components/StatusChip";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

type QuizQuestion = {
    q_en: string;
    q_ar: string;
    options: string[];
    answer: number;
};

type Lesson = {
    titleEn: string;
    titleAr: string;
    bodyEn: string;
    bodyAr: string;
};

type Lab = {
    titleEn: string;
    titleAr: string;
    descriptionEn: string;
    descriptionAr: string;
};

type AcademyModule = {
    id: string;
    letter: string;
    titleEn: string;
    titleAr: string;
    summaryEn: string;
    summaryAr: string;
    lessons: Lesson[];
    lab: Lab;
    quiz: QuizQuestion[];
};

type AcademyProgress = {
    completedModules: string[];
    quizScores: Record<string, number>;
    completedLabs: string[];
    badges: string[];
    lastModuleId: string | null;
};

type SubmittedQuiz = {
    correct: number;
    total: number;
    pct: number;
    passed: boolean;
};

const MODULES: AcademyModule[] = [
    {
        id: "1",
        letter: "A–C",
        titleEn: "How money and links flow",
        titleAr: "كيف تتدفق الأموال والروابط",
        summaryEn: "Follow one payment from authorization to settlement, and learn why a browser link is never proof of money.",
        summaryAr: "تابع دفعة واحدة من التفويض إلى التسوية، واعرف لماذا رابط المتصفح ليس دليلاً على المال.",
        lessons: [
            {
                titleEn: "A — Authorization, capture, confirmation",
                titleAr: "أ — التفويض والالتقاط والتأكيد",
                bodyEn: `Authorization asks the provider whether the instrument can pay. Capture actually moves or reserves the money at the provider. Confirmation is the platform's acceptance of the money movement and the posting of the ledger entry. These are three different events and can happen minutes apart.

A payment is not "done" when the customer sees a success screen. It is done when the core has a confirmed attempt and a balanced journal. If the provider authorized but never captured, the attempt is not a collection. If the provider captured but the platform is unsure, the attempt is UNKNOWN and must be resolved by evidence.`,
                bodyAr: `التفويض يسأل المزوّد هل الأداة قادرة على الدفع. والالتقاط ينقل الأموال أو يحجزها فعلياً عند المزوّد. والتأكيد هو قبول المنصة لحركة المال وقيدها في الدفتر. هذه ثلاثة أحداث مختلفة وقد تفصلها دقائق.

الدفعة لا تكون منتهية عندما يرى العميل شاشة نجاح. تكون منتهية عندما تملك النواة محاولة مؤكدة وقيداً متوازناً. إذا فوّض المزوّد ولم يلتقط فالمحاولة ليست تحصيلاً. وإذا التقط المزوّد وشكّت المنصة فالمحاولة UNKNOWN ويجب حلّها بالدليل.`,
            },
            {
                titleEn: "B — The three links: request, callback, inquiry",
                titleAr: "ب — الروابط الثلاثة: الطلب والاستدعاء والاستعلام",
                bodyEn: `The request link is outbound: the platform asks the provider to collect. The callback link is inbound: the provider tells the platform what happened. The inquiry link is active: the platform asks the provider for the current state using the original reference.

Only the signed callback and the authenticated inquiry are evidence of money. A browser return URL is a fourth, weaker signal that is useful for the user interface and useless for posting. The platform stores the raw callback, de-duplicates it, and refuses to post from an unverified source.`,
                bodyAr: `رابط الطلب صادر: تطلب المنصة من المزوّد التحصيل. ورابط الاستدعاء وارد: يخبر المزوّد المنصة بما حدث. ورابط الاستعلام نشط: تسأل المنصة المزوّد عن الحالة الحالية بالمرجع الأصلي.

الاستدعاء الموقّع والاستعلام الموثق فقط دليلان على المال. عنوان عودة المتصفح إشارة رابعة أضعف، مفيدة للواجهة وغير مفيدة للقيد. تخزن المنصة الاستدعاء الخام وتزيل تكراره وترفض القيد من مصدر غير موثّق.`,
            },
            {
                titleEn: "C — Clearing, settlement, and the ledger handoff",
                titleAr: "ج — المقاصة والتسوية وتسليم الدفتر",
                bodyEn: `Clearing is the temporary pool that holds money between the provider and the merchant payable. Settlement moves the money from clearing to the platform bank and eventually to the merchant. The ledger records every step with ownership tags so finance can trace the gateway, route, merchant, currency, and environment.

When a payment is confirmed, the platform posts a debit to clearing and a credit to merchant payable. The fee accrues separately. A settlement sweep moves the cleared cash. Reconciliation proves that the statement and the ledger agree, and that the clearing pool really is empty aside from known timing differences.`,
                bodyAr: `المقاصة هي البركة المؤقتة التي تحتفظ بالأموال بين المزوّد ومستحق التاجر. والتسوية تنقل الأموال من المقاصة إلى بنك المنصة ثم إلى التاجر. يسجل الدفتر كل خطوة مع وسوم الملكية حتى تتتبع المالية البوابة والمسار والتاجر والعملة والبيئة.

عند تأكيد الدفعة تقيد المنصة مديناً للمقاصة ودائناً لمستحق التاجر. ويستحق الرسم منفصلاً. ومسح التسوية ينقل النقد المطابق. والمطابقة تثبت اتفاق الكشف والدفتر وأن بركة المقاصة فارغة فعلاً باستثناء فروق التوقيت المعروفة.`,
            },
        ],
        lab: {
            titleEn: "Trace one payment end to end",
            titleAr: "تتبّع دفعة واحدة من البداية للنهاية",
            descriptionEn: "Take a 1,250.500 LYD card payment. Write the request, the signed callback, the confirmation, the fee accrual, the settlement sweep, and the reconciliation match. Mark every point where a browser return would have been a bad source of truth.",
            descriptionAr: "خذ دفعة بطاقة بمبلغ 1,250.500 دينار. اكتب الطلب والاستدعاء الموقّع والتأكيد واستحقاق الرسم ومسح التسوية ومطابقة الكشف. حدّد كل نقطة كان فيها عنوان عودة المتصفح مصدراً خاطئاً للحقيقة.",
        },
        quiz: [
            {
                q_en: "Which source is never sufficient proof that money moved?",
                q_ar: "أي مصدر لا يكفي أبداً كدليل على حركة المال؟",
                options: ["A signed server-to-server webhook", "A browser return URL", "An authenticated status inquiry", "A reconciliation statement"],
                answer: 1,
            },
            {
                q_en: "What is the difference between capture and confirmation?",
                q_ar: "ما الفرق بين الالتقاط والتأكيد؟",
                options: [
                    "They are the same event",
                    "Capture happens at the provider; confirmation is the platform accepting the movement and posting the journal",
                    "Confirmation happens at the provider; capture happens in the browser",
                    "Capture only exists for refunds",
                ],
                answer: 1,
            },
            {
                q_en: "A payment is truly complete when...",
                q_ar: "تكون الدفعة مكتملة فعلاً عندما...",
                options: [
                    "The customer sees a success page",
                    "The provider returns any HTTP 200",
                    "The core has a confirmed attempt and a balanced journal",
                    "The merchant calls support",
                ],
                answer: 2,
            },
        ],
    },
    {
        id: "2",
        letter: "D–F",
        titleEn: "Four-eyes governance",
        titleAr: "حوكمة العيون الأربع",
        summaryEn: "Learn how maker-checker approvals protect sensitive changes and how to review a diff without rubber-stamping.",
        summaryAr: "تعلّم كيف تحمي موافقات المنشئ والمدقق التغييرات الحساسة وكيف تراجع الفرق دون ختم تلقائي.",
        lessons: [
            {
                titleEn: "D — Maker, checker, and separation of duty",
                titleAr: "د — المنشئ والمدقق وفصل الواجبات",
                bodyEn: `The maker proposes; the checker approves or rejects. The same user cannot be both, even if they hold both authorities. This is separation of duty, not a courtesy. It applies to gateway activation, commission changes, fee-bearer changes, limit increases, bank detail changes, large refunds, cash-outs, and manual ledger adjustments.

The system must enforce the rule, not the team culture. If the checker list is empty, the proposal waits. If the maker tries to approve their own proposal, the API rejects it. Operators must never share an account to work around an absent checker; escalate to another authorized checker instead.`,
                bodyAr: `المنشئ يقترح والمدقق يوافق أو يرفض. لا يمكن أن يكون الشخص نفسه الاثنين حتى لو حمل الصلاحيتين. هذا فصل واجبات لا مجاملة. ينطبق على تنشيط البوابة وتغيير العمولة ومتحمل الرسم ورفع الحدود وتغيير بيانات البنك والاستردادات الكبيرة والسحوبات والتعديلات اليدوية للدفتر.

يجب أن يفرض النظام القاعدة لا ثقافة الفريق. إذا كانت قائمة المدققين فارغة ينتظر الاقتراح. وإذا حاول المنشئ اعتماد اقتراحه يرفضه الـ API. لا تشارك الحسابات أبداً للالتفاف على غياب مدقق؛ صعّد إلى مدقق مخوّل آخر.`,
            },
            {
                titleEn: "E — Reading the diff, base version, and reason",
                titleAr: "هـ — قراءة الفرق والإصدار الأساسي والسبب",
                bodyEn: `A good checker reads three things before deciding: the diff, the base version, and the reason. The diff shows exactly what will change. The base version proves the proposal was built against the current entity and not a stale copy. The reason explains the business need and the risk being accepted.

Do not approve because the reason sounds urgent. Check that the diff contains only the intended change. A commission edit should not silently change a fee bearer. A bank detail change should include proof of ownership. If the diff is too large to review, reject and ask for a smaller proposal.`,
                bodyAr: `يقرأ المدقق الجيد ثلاثة أشياء قبل القرار: الفرق والإصدار الأساسي والسبب. الفرق يبين ما سيتغير بالضبط. والإصدار الأساسي يثبت أن الاقتراح بُني على الكيان الحالي لا نسخة قديمة. والسبب يشرح الحاجة التجارية والمخاطر المقبولة.

لا توافق لأن السبب يبدو عاجلاً. تحقق أن الفرق يحتوي التغيير المقصود فقط. تعديل العمولة لا يجب أن يغيّر متحمل الرسم بصمت. وتغيير بيانات البنك يجب أن يتضمن إثبات الملكية. وإذا كان الفرق كبيراً للمراجعة فارفض واطلب اقتراحاً أصغر.`,
            },
            {
                titleEn: "F — Escalation, ageing, and audit evidence",
                titleAr: "و — التصعيد والعمر ودليل التدقيق",
                bodyEn: `Approval queues age. The dashboard shows the oldest pending item by role so a proposal cannot sit forever behind an unavailable approver. Escalation means routing to another authorized checker, not bypassing the control.

Every decision keeps evidence: who proposed, who approved or rejected, the original payload, the diff, the reason, the base version, and the timestamp. A rejected proposal remains in the audit trail. This is what lets compliance reconstruct a decision months later without relying on memory.`,
                bodyAr: `تقدم طوابير الموافقات في العمر. تعرض اللوحة أقدم بند معلّق حسب الدور حتى لا يبقى اقتراح للأبد خلف مدقق غير متاح. التصعيد يعني التوجيه إلى مدقق مخوّل آخر لا تجاوز الضابط.

كل قرار يحتفظ بالدليل: من اقترح ومن وافق أو رفض والحمولة الأصلية والفرق والسبب والإصدار الأساسي والوقت. الاقتراح المرفوض يبقى في مسار التدقيق. هذا ما يتيح للامتثال إعادة بناء القرار بعد أشهر دون الاعتماد على الذاكرة.`,
            },
        ],
        lab: {
            titleEn: "Run a safe approval",
            titleAr: "نفّذ موافقة آمنة",
            descriptionEn: "Propose a commission change in your own name, inspect the diff and base version, then reject it and escalate to a second checker. Write the reason you would accept if the diff were clean.",
            descriptionAr: "اقترح تغيير عمولة باسمك وافحص الفرق والإصدار الأساسي ثم ارفضه وصعّده إلى مدقق ثانٍ. اكتب السبب الذي كنت ستقبله لو كان الفرق نظيفاً.",
        },
        quiz: [
            {
                q_en: "Who may approve a maker's proposal?",
                q_ar: "من يجوز له الموافقة على اقتراح المنشئ؟",
                options: ["The maker, if they are senior", "Any user with read access", "A different authorized checker", "The merchant"],
                answer: 2,
            },
            {
                q_en: "What should a checker verify before approving?",
                q_ar: "ماذا يتحقق منه المدقق قبل الموافقة؟",
                options: ["Only the reason text", "The diff, base version, and reason", "The maker's seniority", "Whether the queue is short"],
                answer: 1,
            },
            {
                q_en: "A rejected proposal should be...",
                q_ar: "الاقتراح المرفوض يجب أن يكون...",
                options: ["Deleted", "Kept as audit evidence", "Sent to the merchant", "Re-submitted by the checker"],
                answer: 1,
            },
        ],
    },
    {
        id: "3",
        letter: "G–I",
        titleEn: "Onboarding and KYB",
        titleAr: "التأهيل والتحقق من النشاط",
        summaryEn: "Move a join request to a merchant safely, verify beneficial ownership, and catch duplicates before they become risk.",
        summaryAr: "انقل طلب انضمام إلى تاجر بأمان وتحقق من الملكية الحقيقية واكتشف التكرار قبل أن يصبح مخاطرة.",
        lessons: [
            {
                titleEn: "G — From join request to merchant",
                titleAr: "ز — من طلب الانضمام إلى التاجر",
                bodyEn: `A join request captures the legal entity, commercial contact, expected volumes, settlement bank, and requested rails. The reviewer can request more information, reject with a reason, or approve into a merchant record. Approval creates the merchant and the initial configuration, but it does not activate every rail automatically.

High-risk requests need enhanced due diligence before approval. The reviewer should confirm the business exists, the contact is reachable, the bank account belongs to the legal entity, and the expected volume is plausible for the declared activity. A fast approval is not a good approval if the evidence is thin.`,
                bodyAr: `يجمع طلب الانضمام الكيان القانوني وجهة الاتصال التجارية والأحجام المتوقعة وبنك التسوية والسكك المطلوبة. يمكن للمراجع طلب معلومات إضافية أو الرفض بسبب أو الموافقة إلى سجل تاجر. الموافقة تنشئ التاجر والإعداد الأولي لكنها لا تنشط كل سكة تلقائياً.

الطلبات عالية المخاطر تحتاج عناية معززة قبل الموافقة. على المراجع تأكيد وجود النشاط ووصول جهة الاتصال وملكية الحساب البنكي للكيان وقابلية الحجم المتوقع للنشاط المعلن. الموافقة السريعة ليست جيدة إذا كان الدليل ضعيفاً.`,
            },
            {
                titleEn: "H — KYB evidence and beneficial owners",
                titleAr: "ح — أدلة KYB والمستفيدون الحقيقيون",
                bodyEn: `KYB verifies the legal entity, registration, tax status, licenses, bank ownership, and the beneficial owners behind the company. Ownership is traced until natural persons are identified. A nominal director is not automatically the beneficial owner.

Each document has a status: missing, uploaded, under review, accepted, or rejected. Rejections need a reason the applicant can act on. Expired documents must be refreshed. Never approve an entity whose ownership chain stops at an opaque offshore company without the required evidence and compliance sign-off.`,
                bodyAr: `يتحقق KYB من الكيان القانوني والسجل والوضع الضريبي والتراخيص وملكية البنك والمستفيدين الحقيقيين خلف الشركة. تُتبع الملكية حتى تحديد أشخاص طبيعيين. المدير الاسمي ليس بالضرورة المستفيد الحقيقي.

لكل وثيقة حالة: ناقصة أو مرفوعة أو قيد المراجعة أو مقبولة أو مرفوضة. الرفض يحتاج سبباً قابلاً للتصرف. والوثائق المنتهية يجب تحديثها. لا توافق على كيان تتوقف سلسلة ملكيته عند شركة خارجية غامضة دون الدليل المطلوب وموافقة الامتثال.`,
            },
            {
                titleEn: "I — Duplicate detection before risk",
                titleAr: "ط — كشف التكرار قبل المخاطرة",
                bodyEn: `Duplicate detection normalizes and compares names, commercial registration numbers, tax identifiers, bank accounts, phones, and addresses against existing merchants and open applications. An exact bank account or registration match is a hard stop.

A fuzzy name match is a review flag. The reviewer must decide whether it is the same entity, a related entity, or a coincidence, and record the evidence. Do not reject a legitimate business because its name resembles another; do not approve a duplicate because the applicant claims the first account was closed.`,
                bodyAr: `يطبّع كشف التكرار ويقارن الأسماء وأرقام السجل التجاري والمعرّفات الضريبية والحسابات البنكية والهواتف والعناوين مع التجار الحاليين والطلبات المفتوحة. تطابق الحساب البنكي أو السجل تطابقاً تاماً يوقف الإجراء.

تشابه الاسم مؤشر مراجعة. يقرر المراجع هل هو نفس الكيان أو كيان مرتبط أو مصادفة ويسجل الدليل. لا ترفض نشاطاً مشروعاً لأن اسمه يشبه اسماً آخر؛ ولا توافق على تكرار لأن مقدم الطلب يقول إن الحساب الأول أُغلق.`,
            },
        ],
        lab: {
            titleEn: "Screen a suspicious duplicate",
            titleAr: "افحص تكراراً مشبوهاً",
            descriptionEn: "Compare two applications with the same bank account but different trading names. Record the hard stop, request the ownership documents, and write the exact evidence needed before any approval.",
            descriptionAr: "قارن طلبين لهما الحساب البنكي نفسه وأسماء تجارية مختلفة. سجّل الإيقاف الإجباري واطلب وثائق الملكية واكتب الدليل المحدد المطلوب قبل أي موافقة.",
        },
        quiz: [
            {
                q_en: "An exact bank account match with an existing merchant is...",
                q_ar: "تطابق الحساب البنكي تماماً مع تاجر حالي هو...",
                options: ["A hard stop", "Automatic approval", "A reason to delete the application", "Irrelevant"],
                answer: 0,
            },
            {
                q_en: "Beneficial ownership is traced until...",
                q_ar: "تُتبع الملكية الحقيقية حتى...",
                options: ["The first company is found", "A natural person is identified", "The bank approves", "The merchant pays a fee"],
                answer: 1,
            },
            {
                q_en: "A fuzzy name match should be treated as...",
                q_ar: "تشابه الاسم الغامض يجب التعامل معه كـ...",
                options: ["An automatic rejection", "A review flag with recorded evidence", "A completed KYB", "A reason to ignore the bank check"],
                answer: 1,
            },
        ],
    },
    {
        id: "4",
        letter: "J–L",
        titleEn: "Double-entry ledger, fee bearers, and cash-outs",
        titleAr: "الدفتر المزدوج ومتحملو الرسوم والسحوبات",
        summaryEn: "Read a journal, choose the right fee bearer, and stop a cash-out that would break the negative balance ceiling.",
        summaryAr: "اقرأ القيد واختر متحمل الرسم الصحيح وأوقف سحباً يكسر سقف الرصيد السالب.",
        lessons: [
            {
                titleEn: "J — Debits, credits, and balanced journals",
                titleAr: "ي — المدين والدائن والقيود المتوازنة",
                bodyEn: `Every money event is a balanced journal. A payment debits clearing and credits merchant payable. A fee debits the bearer and credits fee revenue. A refund reverses the original entry. Debits must equal credits to the minor unit or the transaction is rejected.

Ownership tags are part of the entry. They identify the merchant, gateway, route, currency, and environment. Without them finance can see a total but cannot explain which gateway is short or which merchant is owed. Clearing is segregated by gateway, environment, and currency so statements match one pool at a time.`,
                bodyAr: `كل حدث مالي قيد متوازن. الدفعة تقيد المقاصة مديناً ومستحق التاجر دائناً. والرسم يقيد المتحمل مديناً وإيراد الرسوم دائناً. والاسترداد يعكس القيد الأصلي. يجب أن يتساوى المدين والدائن حتى أصغر وحدة وإلا رُفض القيد.

وسوم الملكية جزء من القيد وتحدد التاجر والبوابة والمسار والعملة والبيئة. بدونها ترى المالية الإجمالي لكن لا تفسر أي بوابة ناقصة أو أي تاجر مستحق. تُفصل المقاصة حسب البوابة والبيئة والعملة حتى يطابق الكشف بركة واحدة في كل مرة.`,
            },
            {
                titleEn: "K — Fee bearers and commission rules",
                titleAr: "ك — متحملو الرسوم وقواعد العمولة",
                bodyEn: `The fee bearer says who pays. CUSTOMER adds a surcharge to the payer. MERCHANT deducts the fee from the merchant receivable, so the merchant receives the net. PLATFORM absorbs the fee as a cost or a revenue reduction. The bearer must be explicit on every commission profile and every rail.

Changing the bearer changes who is owed what. That is why it is a four-eyes change. A mistaken bearer can look fine in the total volume but produce an unbalanced merchant statement, a wrong cash-out, and a dispute. Test the commission profile with a worked example before activation.`,
                bodyAr: `متحمل الرسم يحدد من يدفع. CUSTOMER يضيف رسماً على الدافع. MERCHANT يخصم الرسم من مستحق التاجر فيستلم التاجر الصافي. PLATFORM يتحمل الرسم كتكلفة أو تخفيض إيراد. يجب أن يكون المتحمل صريحاً في كل ملف عمولة وكل سكة.

تغيير المتحمل يغيّر من يُستحق له ماذا، ولهذا هو تغيير بعيون أربع. المتحمل الخاطئ قد يبدو سليماً في إجمالي الحجم لكنه ينتج كشف تاجر غير متوازن وسحباً خاطئاً ونزاعاً. اختبر ملف العمولة بمثال عملي قبل التنشيط.`,
            },
            {
                titleEn: "L — Cash-outs and the negative balance ceiling",
                titleAr: "ل — السحوبات وسقف الرصيد السالب",
                bodyEn: `A cash-out pays the merchant's available balance to their verified bank account. Available is not the same as ledger payable: pending settlements, holds, reserves, and open disputes reduce what can be paid today.

The negative_balance_ceiling prevents the platform from funding a merchant's losses. If a chargeback, fee, or adjustment would push the balance below the ceiling, new cash-outs are blocked and a receivable is posted. When the reserve is exhausted, the platform recognizes the loss. Operators cannot override the ceiling; only finance can approve a credit limit with a recovery plan.`,
                bodyAr: `السحب يدفع الرصيد المتاح للتاجر إلى حسابه البنكي الموثق. المتاح ليس هو مستحق الدفتر: التسويات المعلقة والحجوزات والاحتياطيات والنزاعات المفتوحة تقلل ما يمكن دفعه اليوم.

سقف الرصيد السالب يمنع المنصة من تمويل خسائر التاجر. إذا دفع الاسترداد العكسي أو الرسم أو التعديل الرصيد تحت السقف تُحجب السحوبات الجديدة ويُقيد مستحق. وعند نفاد الاحتياطي تعترف المنصة بالخسارة. لا يتجاوز المشغلون السقف؛ فقط المالية توافق على حد ائتمان مع خطة استرداد.`,
            },
        ],
        lab: {
            titleEn: "Post a fee and a cash-out",
            titleAr: "قيّد رسماً وسحباً",
            descriptionEn: "Using a 1,000.000 LYD payment and a 2.5% merchant-borne commission, write the confirm, fee accrual, settlement, and cash-out entries. Then show which account would block a cash-out after a 300.000 LYD chargeback loss.",
            descriptionAr: "باستخدام دفعة 1,000.000 دينار وعمولة 2.5% على التاجر، اكتب قيود التأكيد واستحقاق الرسم والتسوية والسحب. ثم بيّن أي حساب سيحجب السحب بعد خسارة استرداد عكسي 300.000 دينار.",
        },
        quiz: [
            {
                q_en: "A merchant-borne fee is posted as...",
                q_ar: "الرسم المتحمل على التاجر يُقيد كـ...",
                options: [
                    "Debit merchant payable, credit fee revenue",
                    "Debit fee revenue, credit merchant payable",
                    "Debit platform bank, credit cash",
                    "No entry until settlement",
                ],
                answer: 0,
            },
            {
                q_en: "The negative_balance_ceiling exists to...",
                q_ar: "سقف الرصيد السالب موجود لكي...",
                options: [
                    "Increase merchant credit without limits",
                    "Stop payouts that the merchant cannot cover",
                    "Hide chargebacks",
                    "Replace reconciliation",
                ],
                answer: 1,
            },
            {
                q_en: "Which balance can a cash-out pay?",
                q_ar: "أي رصيد يمكن للسحب دفعه؟",
                options: ["The gross ledger volume", "The available balance after holds and reserves", "The next month's expected sales", "Any amount approved by support"],
                answer: 1,
            },
        ],
    },
    {
        id: "5",
        letter: "M–P",
        titleEn: "The universal rail engine and the eight-step wizard",
        titleAr: "محرك السكك الموحد والمعالج ذو الخطوات الثماني",
        summaryEn: "Understand the four-layer catalog, compute visible rails, and configure a gateway without skipping the simulator.",
        summaryAr: "افهم الكتالوج الرباعي واحسب السكك المرئية وأعد بوابة دون تجاوز المحاكي.",
        lessons: [
            {
                titleEn: "M — Gateway, CredentialSet, Rail, RailRoute",
                titleAr: "م — البوابة ومجموعة الاعتماد والسكة ومسار السكة",
                bodyEn: `The four catalog layers answer four different questions. Gateway: who is the operator and what is the commercial relationship? CredentialSet: which environment, credentials, and secrets are in scope? Rail: which instrument or scheme capability is being offered? RailRoute: which executable path joins them, with what priority, limits, and maintenance state?

Do not clone a gateway to rotate a credential. Create or rotate a credential set. Do not create a new rail because a provider renamed a product; map the rename in the route configuration. Keeping the layers separate is what makes routing, rollback, and permissioning manageable.`,
                bodyAr: `طبقات الكتالوج الأربع تجيب على أربعة أسئلة. البوابة: من المشغّل وما العلاقة التجارية؟ مجموعة الاعتماد: أي بيئة واعتمادات وأسرار ضمن النطاق؟ السكة: أي أداة أو قدرة مخطط تُعرض؟ مسار السكة: أي مسار قابل للتنفيذ يربطها وبأي أولوية وحدود وحالة صيانة؟

لا تنسخ بوابة لتدوير اعتماد. أنشئ أو دوّر مجموعة اعتماد. ولا تنشئ سكة جديدة لأن المزوّد غيّر اسم منتج؛ اعكس التغيير في إعداد المسار. فصل الطبقات هو ما يجعل التوجيه والتراجع والصلاحيات قابلة للإدارة.`,
            },
            {
                titleEn: "N — Computing visible rails",
                titleAr: "ن — حساب السكك المرئية",
                bodyEn: `Visible rails are an intersection, not a wholesale list. Start with currency, country, amount, and instrument capability. Intersect with active and verified credential sets, non-suspended gateways, routes outside maintenance, and merchant entitlement. Remove amount-bound, velocity-bound, and scheme-ineligible routes. Sort by priority, success guard, and cost.

An empty result is a diagnosis. Check the terms in order: currency, country, amount bounds, credential status, gateway status, route maintenance, merchant entitlement, routing guard. Most "missing rail" tickets are a disabled credential or a route still in maintenance.`,
                bodyAr: `السكك المرئية تقاطع لا قائمة كاملة. ابدأ بالعملة والبلد والمبلغ وقدرة الأداة. ثم اقتصر على مجموعات الاعتماد النشطة والموثقة والبوابات غير الموقوفة والمسارات خارج الصيانة واستحقاق التاجر. أزل المسارات المقيدة بالمبلغ أو السرعة أو غير المؤهلة للمخطط. رتّب حسب الأولوية وحارس النجاح والتكلفة.

النتيجة الفارغة تشخيص. افحص الحدود بالترتيب: العملة والبلد وحدود المبلغ وحالة الاعتماد وحالة البوابة وصيانة المسار واستحقاق التاجر وحارس التوجيه. معظم تذاكر «السكة مفقودة» سببها اعتماد معطل أو مسار ما زال في الصيانة.`,
            },
            {
                titleEn: "O — The eight-step wizard",
                titleAr: "س — المعالج ذو الخطوات الثماني",
                bodyEn: `The eight steps are identity, environments and auth, customer catalog, crypto profiles, flow builder, client action and channels, status rules and costs, and simulator plus approval. Each step produces part of a versioned artifact. Saving a step does not publish anything.

The version lifecycle is DRAFT, VALIDATED, PENDING_APPROVAL, ACTIVE, RETIRED. The simulator is where a known request must produce the expected canonical string, outbound call, and internal status. Only a passing simulation should be submitted to four-eyes approval.`,
                bodyAr: `الخطوات الثماني هي الهوية والبيئات والمصادقة وكتالوج العميل وملفات التشفير وباني التدفق وإجراء العميل والقنوات وقواعد الحالة والتكاليف ثم المحاكي والموافقة. كل خطوة تنتج جزءاً من أصل مُصدّر، وحفظ الخطوة لا ينشر شيئاً.

دورة الإصدار هي DRAFT وVALIDATED وPENDING_APPROVAL وACTIVE وRETIRED. المحاكي هو حيث يجب أن ينتج طلب معروف السلسلة القياسية والاستدعاء الخارجي والحالة الداخلية المتوقعة. ولا يُقدّم للموافقة إلا محاكاة ناجحة.`,
            },
            {
                titleEn: "P — AI spec importer and the simulator",
                titleAr: "ص — مستورد المواصفات الذكي والمحاكي",
                bodyEn: `The Smart AI importer extracts endpoints, auth, field mappings, status codes, and error semantics, then proposes a draft version and verification vectors. It is an accelerator. It never publishes and never bypasses approval. Low-confidence fields are flagged for manual review.

The operator must confirm the amount pipeline, signature algorithm, canonicalization, and confirmation channels. A return URL in a spec is a channel hint, not a trust decision. Use the simulator to prove the behavior, then submit the version to the checker.`,
                bodyAr: `يستخرج المستورد الذكي نقاط النهاية والمصادقة وربط الحقول وأكواد الحالة ودلالات الأخطاء ثم يقترح مسودة إصدار ومتجهات تحقق. هو مسرّع لا ينشر ولا يتجاوز الموافقة. الحقول منخفضة الثقة تُعلّم للمراجعة اليدوية.

على المشغّل تأكيد خط المبلغ وخوارزمية التوقيع والتوحيد القياسي وقنوات التأكيد. عنوان العودة في المواصفة تلميح قناة لا قرار ثقة. استخدم المحاكي لإثبات السلوك ثم قدّم الإصدار للمدقق.`,
            },
        ],
        lab: {
            titleEn: "Configure a rail route",
            titleAr: "أعد مسار سكة",
            descriptionEn: "Choose a gateway, credential set, and rail, then write the visibility test for a 750.000 LYD wallet payment in Libya. List every term of the intersection and what you would check first if the route did not appear.",
            descriptionAr: "اختر بوابة ومجموعة اعتماد وسكة ثم اكتب اختبار الظهور لدفعة محفظة 750.000 دينار في ليبيا. اسرد كل حد من حدود التقاطع وما تفحصه أولاً إذا لم يظهر المسار.",
        },
        quiz: [
            {
                q_en: "Which layer is executable by the routing engine?",
                q_ar: "أي طبقة ينفذها محرك التوجيه؟",
                options: ["Gateway", "CredentialSet", "RailRoute", "Rail"],
                answer: 2,
            },
            {
                q_en: "An empty visible-rails result is best treated as...",
                q_ar: "النتيجة الفارغة للسكك المرئية تعامل أفضل معاملة كـ...",
                options: ["A routing engine bug", "A diagnosis of the intersection terms", "Permission to use any rail", "A reason to disable KYB"],
                answer: 1,
            },
            {
                q_en: "The AI spec importer may...",
                q_ar: "مستورد المواصفات الذكي يجوز له...",
                options: ["Publish a gateway automatically", "Bypass four-eyes approval", "Propose a draft and verification vectors", "Change merchant balances"],
                answer: 2,
            },
        ],
    },
    {
        id: "6",
        letter: "Q–S",
        titleEn: "UNKNOWN payments, outages, and reconciliation",
        titleAr: "المدفوعات UNKNOWN والانقطاعات والمطابقة",
        summaryEn: "Resolve ambiguity without double-charging, fail closed during outages, and close the loop with reconciliation.",
        summaryAr: "احل الغموض دون تحصيل مزدوج وافشل مغلقاً أثناء الانقطاع وأغلق الحلقة بالمطابقة.",
        lessons: [
            {
                titleEn: "Q — UNKNOWN and the inquiry path",
                titleAr: "ق — UNKNOWN ومسار الاستعلام",
                bodyEn: `UNKNOWN means the platform does not know whether money moved. The worst response is a blind retry, because it can create a second real payment. The correct response is an authenticated inquiry using the original external reference and the provider idempotency key, then a signed callback or statement if the inquiry is inconclusive.

The attempt keeps its slot and active_locked_count until evidence resolves it. If the provider confirms success, transition and post. If it confirms failure, release the slot. If it remains ambiguous past the policy deadline, open an operator case and escalate. Never "fix" UNKNOWN by editing the state without evidence.`,
                bodyAr: `UNKNOWN تعني أن المنصة لا تعرف هل تحرك المال. أسوأ استجابة هي إعادة محاولة عمياء لأنها قد تنشئ دفعة حقيقية ثانية. الاستجابة الصحيحة استعلام موثق بالمرجع الخارجي الأصلي ومفتاح منع التكرار، ثم استدعاء موقّع أو كشف إذا كان الاستعلام غير حاسم.

تحتفظ المحاولة بخانتها وactive_locked_count حتى يحلها الدليل. إذا أكد المزوّد النجاح فانتقل وقيّد. وإذا أكد الفشل فحرر الخانة. وإذا بقي الغموض بعد مهلة السياسة فافتح حالة مشغّل وصعّد. لا «تصلح» UNKNOWN بتعديل الحالة دون دليل.`,
            },
            {
                titleEn: "R — Outages, circuit breakers, and failing closed",
                titleAr: "ر — الانقطاعات وقواطع الدائرة والفشل المغلق",
                bodyEn: `The edge fails closed for money-moving calls when it cannot reach the core or verify its peer. A closed circuit breaker stops sending new traffic to a failing provider and surfaces an alert. It does not mean the provider is down forever; it means the platform is protecting itself from a storm of timeouts.

During an outage, do not retry every failed attempt. Preserve the evidence, let the breaker cool down, and use inquiry once the provider recovers. When the circuit closes, the backlog must be drained in a controlled order, with idempotency, not by replaying everything at once.`,
                bodyAr: `تفشل الحافة مغلقة للعمليات المالية عندما لا تستطيع الوصول للنواة أو التحقق من نظيرها. قاطع الدائرة المغلق يوقف إرسال حركة جديدة لمزوّد فاشل ويظهر تنبيهاً. هذا لا يعني أن المزوّد معطل للأبد بل أن المنصة تحمي نفسها من عاصفة مهل.

أثناء الانقطاع لا تعد محاولة كل دفعة فاشلة. احفظ الأدلة واترك القاطع يبرد واستخدم الاستعلام بعد تعافي المزوّد. وعند إغلاق الدائرة يجب تصريف التراكم بترتيب مضبوط وبمنع تكرار لا بإعادة تشغيل كل شيء دفعة واحدة.`,
            },
            {
                titleEn: "S — Reconciliation and fee variance",
                titleAr: "س — المطابقة وفرق الرسم",
                bodyEn: `Reconciliation matches statement lines to attempts and ledger entries by external reference, amount, currency, value date, and a date window. Matched lines close the loop. Unmatched platform entries become exceptions; unmatched statement lines become suspense items.

Fee variance is a normal outcome. The principal stays matched and the difference goes to a variance account or fee revenue, depending on policy. Never change the statement amount to force a match. Reconciliation proves the ledger and the provider agree; it is not a place to hide an unexplained difference.`,
                bodyAr: `تطابق المطابقة سطور الكشف بالمحاولات وقيود الدفتر عبر المرجع الخارجي والمبلغ والعملة وتاريخ القيمة ونافذة زمنية. السطور المطابقة تغلق الحلقة. قيود المنصة غير المطابقة تصبح استثناءات، وسطور الكشف غير المطابقة تصبح بنوداً معلقة.

فرق الرسم نتيجة طبيعية. يبقى الأصل مطابقاً ويذهب الفرق إلى حساب فروق أو إيراد رسوم حسب السياسة. لا تغيّر مبلغ الكشف لفرض المطابقة. المطابقة تثبت اتفاق الدفتر والمزوّد وليست مكاناً لإخفاء فرق غير مفسر.`,
            },
        ],
        lab: {
            titleEn: "Resolve an UNKNOWN payment",
            titleAr: "احل دفعة UNKNOWN",
            descriptionEn: "An attempt has been UNKNOWN for 40 minutes. Write the inquiry request, the three possible outcomes, the ledger effect of each, and the point at which you open an operator case instead of retrying.",
            descriptionAr: "محاولة UNKNOWN منذ 40 دقيقة. اكتب طلب الاستعلام والنتائج الثلاث المحتملة وأثر كل نتيجة على الدفتر والنقطة التي تفتح عندها حالة مشغّل بدل إعادة المحاولة.",
        },
        quiz: [
            {
                q_en: "The safest first action for an UNKNOWN attempt is...",
                q_ar: "أأمن إجراء أول لمحاولة UNKNOWN هو...",
                options: ["Retry immediately", "Authenticated inquiry with the original reference", "Mark it CONFIRMED", "Delete the slot"],
                answer: 1,
            },
            {
                q_en: "Why does an UNKNOWN attempt keep its slot?",
                q_ar: "لماذا تحتفظ محاولة UNKNOWN بخانتها؟",
                options: ["To punish the merchant", "Because it may still be live at the provider", "Because the ledger is broken", "To speed up retries"],
                answer: 1,
            },
            {
                q_en: "A fee variance should be...",
                q_ar: "فرق الرسم يجب أن...",
                options: ["Hidden by editing the statement", "Posted separately while the principal stays matched", "Ignored forever", "Charged twice to the customer"],
                answer: 1,
            },
        ],
    },
    {
        id: "7",
        letter: "T–V",
        titleEn: "AML, velocity, and no-tipping-off",
        titleAr: "مكافحة غسل الأموال والسرعة وعدم الإفصاح",
        summaryEn: "Run the seven-layer program, disposition screening hits, and protect confidential reporting.",
        summaryAr: "شغّل البرنامج ذا الطبقات السبع وصنّف نتائج الفحص واحمِ سرية الإبلاغ.",
        lessons: [
            {
                titleEn: "T — The seven-layer AML program",
                titleAr: "ت — برنامج مكافحة غسل الأموال ذو الطبقات السبع",
                bodyEn: `The seven layers are CDD/EDD, sanctions and PEP screening, transaction monitoring, velocity and limits, risk scoring, case management and reporting, and governance with independent testing. Each layer has an owner, a rule set, and an audit trail.

Layers are not alternatives. A clean sanctions screen does not excuse weak CDD, and a low risk score does not disable monitoring. When a layer fails, the case records the failure and the remediation. The program is judged by evidence, not by the absence of alerts.`,
                bodyAr: `الطبقات السبع هي العناية الواجبة والمعززة وفحص العقوبات والأشخاص السياسيين ومراقبة المعاملات والسرعة والحدود وتقييم المخاطر وإدارة الحالات والإبلاغ والحوكمة مع الاختبار المستقل. لكل طبقة مالك ومجموعة قواعد ومسار تدقيق.

الطبقات ليست بدائل. فحص عقوبات نظيف لا يعفي من ضعف العناية، ودرجة مخاطر منخفضة لا تعطل المراقبة. وعند فشل طبقة تسجل الحالة الفشل والمعالجة. يُحكم على البرنامج بالدليل لا بغياب التنبيهات.`,
            },
            {
                titleEn: "U — Screening dispositions and velocity",
                titleAr: "ث — تصنيفات الفحص والسرعة",
                bodyEn: `Screening produces candidates. TRUE_MATCH blocks or escalates. FALSE_POSITIVE records the discriminating evidence. ESCALATED goes to investigation. PENDING has a deadline. A disposition without evidence is not a disposition; it is a guess with a button.

Velocity rules protect against structuring and abuse: count and amount per customer, per instrument, per merchant, and per time window. A limit breach is not automatically a crime, but it must be explainable. Tune rules with real false-positive data, and record every tuning change through four-eyes.`,
                bodyAr: `ينتج الفحص مرشحين. TRUE_MATCH يحجب أو يصعّد. FALSE_POSITIVE يسجل الدليل الفاصل. ESCALATED يذهب للتحقيق. PENDING له مهلة. التصنيف بلا دليل ليس تصنيفاً بل تخميناً بزر.

قواعد السرعة تحمي من التجزئة والإساءة: العدد والمبلغ لكل عميل وأداة وتاجر ونافذة زمنية. تجاوز الحد ليس جريمة تلقائياً لكنه يجب أن يكون قابلاً للتفسير. اضبط القواعد ببيانات إنذارات كاذبة حقيقية وسجّل كل تعديل بعيون أربع.`,
            },
            {
                titleEn: "V — No-tipping-off and CBL reporting",
                titleAr: "ف — عدم الإفصاح وإبلاغ المصرف المركزي",
                bodyEn: `No-tipping-off means the customer is never told that a suspicious activity report exists or that they are under investigation. Support scripts, merchant messages, and call notes must stay neutral. Never paste case notes, screening reasons, or report references into a customer-facing channel.

CBL reporting produces the regulated output from the case file and preserves the submission reference. Reports are confidential and restricted to compliance and MLRO roles. A submitted report is immutable; corrections are new linked records. The reporting decision is recorded even when the decision is not to report.`,
                bodyAr: `عدم الإفصاح يعني ألا يُخبر العميل أبداً بوجود تقرير نشاط مشبوه أو أنه قيد التحقيق. يجب أن تبقى نصوص الدعم ورسائل التاجر وملاحظات المكالمات محايدة. لا تلصق ملاحظات الحالة أو أسباب الفحص أو مراجع التقارير في قناة موجهة للعميل.

إبلاغ المصرف المركزي ينتج المخرج التنظيمي من ملف الحالة ويحفظ مرجع التقديم. التقارير سرية ومقصورة على الامتثال ومسؤول مكافحة غسل الأموال. التقرير المقدم غير قابل للتعديل؛ والتصحيحات سجلات جديدة مرتبطة. ويُسجل قرار الإبلاغ حتى إذا كان عدم الإبلاغ.`,
            },
        ],
        lab: {
            titleEn: "Disposition a sanctions match",
            titleAr: "صنّف تطابق عقوبات",
            descriptionEn: "A customer matches a sanctions name at 82%. Write what evidence you need, how you decide TRUE_MATCH versus FALSE_POSITIVE, who must approve the disposition, and what you may never say to the customer.",
            descriptionAr: "عميل يطابق اسماً في قائمة عقوبات بنسبة 82%. اكتب الأدلة المطلوبة وكيف تقرر TRUE_MATCH مقابل FALSE_POSITIVE ومن يعتمد التصنيف وما لا يجوز قوله للعميل أبداً.",
        },
        quiz: [
            {
                q_en: "A FALSE_POSITIVE disposition must include...",
                q_ar: "تصنيف FALSE_POSITIVE يجب أن يتضمن...",
                options: ["Only a click", "The discriminating evidence", "A customer apology", "A refund"],
                answer: 1,
            },
            {
                q_en: "No-tipping-off means...",
                q_ar: "عدم الإفصاح يعني...",
                options: [
                    "Tell the customer about the SAR so they can explain",
                    "Never disclose the investigation or report to the customer",
                    "Share case notes with the merchant",
                    "Send reports to support",
                ],
                answer: 1,
            },
            {
                q_en: "A submitted CBL report is...",
                q_ar: "تقرير المصرف المركزي المقدم يكون...",
                options: ["Editable by any operator", "Immutable; corrections are new linked records", "Deleted after a year", "Stored in the customer portal"],
                answer: 1,
            },
        ],
    },
    {
        id: "8",
        letter: "W–Z",
        titleEn: "Disputes, chargebacks, and go-live gates",
        titleAr: "النزاعات والاسترداد العكسي وبوابات الإطلاق",
        summaryEn: "Build evidence packets, protect reserves, and prove every go-live gate before a release.",
        summaryAr: "ابنِ حزم الأدلة واحمِ الاحتياطيات وأثبت كل بوابة إطلاق قبل الإصدار.",
        lessons: [
            {
                titleEn: "W — Disputes and automated drafting",
                titleAr: "و — النزاعات والإعداد الآلي",
                bodyEn: `A dispute is a deadline-driven evidence process. The platform links the original attempt, the ledger entry, the signed confirmation, the device metadata, the merchant descriptor, delivery proof, and customer communication. The response must arrive before the scheme deadline or the case is lost by default.

Automated drafting assembles a proposal, not a submission. An operator removes irrelevant or sensitive material, adds a written rebuttal, and approves the final packet. Never submit raw case notes, AML material, or internal risk scores to a scheme or a customer.`,
                bodyAr: `النزاع عملية أدلة مرتبطة بمهلة. تربط المنصة المحاولة الأصلية وقيد الدفتر والتأكيد الموقّع وبيانات الجهاز ووصف التاجر وإثبات التسليم وتواصل العميل. ويجب وصول الرد قبل مهلة المخطط وإلا خسرت القضية افتراضياً.

الإعداد الآلي يجمع اقتراحاً لا تقديماً. يحذف المشغّل المواد غير الضرورية أو الحساسة ويضيف رداً مكتوباً ويعتمد الحزمة النهائية. لا تقدم ملاحظات الحالة الخام أو مواد مكافحة غسل الأموال أو درجات المخاطر الداخلية لمخطط أو عميل.`,
            },
            {
                titleEn: "X — Chargebacks, reserves, and the ceiling",
                titleAr: "س — الاسترداد العكسي والاحتياطيات والسقف",
                bodyEn: `A chargeback can create a reserve, a receivable, or a direct loss. When the merchant has funds, the reserve is built from merchant payable. When the merchant wins, the reserve is released. When the merchant loses, the reserve is consumed. When the merchant cannot cover it, the platform recognizes the loss and blocks cash-outs.

The negative_balance_ceiling is the guard. Do not approve a cash-out to "help" a merchant who is below the ceiling. That converts a merchant liability into a platform loss without approval. Finance may set a credit limit only with a documented recovery plan.`,
                bodyAr: `قد ينشئ الاسترداد العكسي احتياطياً أو مستحقاً أو خسارة مباشرة. عندما يملك التاجر أموالاً يُبنى الاحتياطي من مستحقه. وعندما يفوز يُفرج عنه. وعندما يخسر يُستهلك. وعندما لا يستطيع التغطية تعترف المنصة بالخسارة وتحجب السحوبات.

سقف الرصيد السالب هو الحارس. لا توافق على سحب «لمساعدة» تاجر تحت السقف؛ فهذا يحول التزام التاجر إلى خسارة منصة دون موافقة. يجوز للمالية وضع حد ائتمان فقط بخطة استرداد موثقة.`,
            },
            {
                titleEn: "Y — Refunds and idempotency",
                titleAr: "ص — الاستردادات ومنع التكرار",
                bodyEn: `A full refund reverses the principal and, when policy allows, the fee. A partial refund posts only the requested amount and leaves the attempt partially refunded. Refunds are idempotent: the same idempotency key must return the same result, not create a second credit.

Refunding an UNKNOWN attempt is dangerous because the original money may still move. Refunding a disputed attempt can conflict with the scheme process. In both cases open an operator case, gather evidence, and follow the runbook instead of clicking refund twice.`,
                bodyAr: `الاسترداد الكامل يعكس الأصل ويعكس الرسم عندما تسمح السياسة. والجزئي يقيد المبلغ المطلوب فقط ويترك المحاولة مستردة جزئياً. الاستردادات مانعة للتكرار: المفتاح نفسه يجب أن يعيد النتيجة نفسها لا أن ينشئ دائناً ثانياً.

استرداد محاولة UNKNOWN خطير لأن المال الأصلي قد يتحرك. واسترداد محاولة متنازع عليها قد يتعارض مع عملية المخطط. في الحالتين افتح حالة مشغّل واجمع الأدلة واتبع الدليل التشغيلي بدل النقر على الاسترداد مرتين.`,
            },
            {
                titleEn: "Z — The twelve go-live gates",
                titleAr: "ز — بوابات الإطلاق الاثنتا عشرة",
                bodyEn: `The gates are security review, mTLS and certificate rotation, idempotency and replay, UNKNOWN handling, reconciliation parity, ledger invariant, AML sign-off, four-eyes, load and soak, rollback, observability, and runbooks plus training. Each gate needs evidence, not an opinion.

Go-live is a decision. If a gate fails, delay, reduce scope, or roll back. Never waive a money-safety gate under delivery pressure. The 140 edge cases are the institutional memory behind these gates; cite the case id in the release evidence when it applies.`,
                bodyAr: `البوابات هي المراجعة الأمنية وmTLS وتدوير الشهادات ومنع التكرار وإعادة التشغيل ومعالجة UNKNOWN وتكافؤ المطابقة وثبات الدفتر وموافقة مكافحة غسل الأموال والعيون الأربع والحمل والتحمل والتراجع والرصد والأدلة التشغيلية والتدريب. كل بوابة تحتاج دليلاً لا رأياً.

الإطلاق قرار. إذا فشلت بوابة فأجّل أو قلّص النطاق أو تراجع. لا تتنازل عن بوابة سلامة مالية تحت ضغط التسليم. الحالات الطرفية المئة والأربعون هي الذاكرة المؤسسية خلف هذه البوابات؛ اذكر معرّف الحالة في دليل الإصدار عندما تنطبق.`,
            },
        ],
        lab: {
            titleEn: "Draft a chargeback response",
            titleAr: "أعد رداً على استرداد عكسي",
            descriptionEn: "Assemble the evidence packet for a 1,250.500 LYD chargeback, write the rebuttal, identify what must be removed for confidentiality, and list the gates that must be green before the next gateway release.",
            descriptionAr: "اجمع حزمة أدلة لاسترداد عكسي 1,250.500 دينار واكتب الرد وحدد ما يجب حذفه للسرية واسرد البوابات التي يجب أن تكون خضراء قبل إصدار البوابة التالي.",
        },
        quiz: [
            {
                q_en: "An automated chargeback draft is...",
                q_ar: "مسودة الاسترداد العكسي الآلية هي...",
                options: ["Submitted automatically", "A proposal that an operator must review and approve", "A customer receipt", "A replacement for the ledger"],
                answer: 1,
            },
            {
                q_en: "When a merchant cannot cover a chargeback, the platform should...",
                q_ar: "عندما لا يستطيع التاجر تغطية الاسترداد العكسي على المنصة أن...",
                options: ["Ignore it", "Recognize the loss and enforce the ceiling", "Increase the merchant's payout", "Delete the reserve"],
                answer: 1,
            },
            {
                q_en: "A failed go-live gate means...",
                q_ar: "فشل بوابة إطلاق يعني...",
                options: ["Waive it for speed", "Delay, reduce scope, or roll back", "Ship anyway", "Disable reconciliation"],
                answer: 1,
            },
        ],
    },
];

const BADGE_TRACKS: { badge: string; titleEn: string; titleAr: string; modules: string[] }[] = [
    { badge: "CERTIFIED_OPERATOR", titleEn: "Certified Operator", titleAr: "مشغّل معتمد", modules: ["1", "2", "5", "6"] },
    { badge: "CERTIFIED_COMPLIANCE", titleEn: "Certified Compliance", titleAr: "امتثال معتمد", modules: ["3", "7"] },
    { badge: "CERTIFIED_FINANCE", titleEn: "Certified Finance", titleAr: "مالية معتمدة", modules: ["4", "8"] },
    {
        badge: "CERTIFIED_GATEWAY_ARCHITECT",
        titleEn: "Certified Gateway Architect",
        titleAr: "مهندس بوابات معتمد",
        modules: ["5", "8"],
    },
];

const emptyProgress = (): AcademyProgress => ({
    completedModules: [],
    quizScores: {},
    completedLabs: [],
    badges: [],
    lastModuleId: null,
});

const asStringArray = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

const asScoreRecord = (value: unknown): Record<string, number> => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return {};
    }
    const result: Record<string, number> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (typeof entry === "number" && Number.isFinite(entry)) {
            result[key] = Math.max(0, Math.min(100, Math.round(entry)));
        }
    }
    return result;
};

const normalizeProgress = (input: unknown): AcademyProgress => {
    const source = input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
    const lastModuleId = typeof source.lastModuleId === "string" ? source.lastModuleId : null;
    return {
        completedModules: asStringArray(source.completedModules),
        quizScores: asScoreRecord(source.quizScores),
        completedLabs: asStringArray(source.completedLabs),
        badges: asStringArray(source.badges),
        lastModuleId,
    };
};

const earnedBadges = (completedModules: string[]): string[] =>
    BADGE_TRACKS.filter((track) => track.modules.every((moduleId) => completedModules.includes(moduleId))).map((track) => track.badge);

const moduleIsComplete = (progress: AcademyProgress, moduleId: string): boolean =>
    progress.completedModules.includes(moduleId) ||
    (progress.quizScores[moduleId] ?? 0) >= 67 ||
    progress.completedLabs.includes(moduleId);

const AcademyPage = dc(() => {
    const { t, current } = useLocale();
    const isArabic = computed(() => current.value === "ar");

    const progress = ref<AcademyProgress>(emptyProgress());
    const loading = ref(true);
    const loadError = ref<string | null>(null);
    const persistWarning = ref<string | null>(null);
    const saving = ref(false);
    const selectedId = ref<string>(MODULES[0]?.id ?? "1");
    const answers = ref<Record<string, Record<number, number | undefined>>>({});
    const submitted = ref<Record<string, SubmittedQuiz>>({});

    const selectedModule = computed<AcademyModule>(() => MODULES.find((module) => module.id === selectedId.value) ?? MODULES[0]!);

    const moduleTitle = (module: AcademyModule): string => (isArabic.value ? module.titleAr : module.titleEn);
    const moduleSummary = (module: AcademyModule): string => (isArabic.value ? module.summaryAr : module.summaryEn);
    const lessonTitle = (lesson: Lesson): string => (isArabic.value ? lesson.titleAr : lesson.titleEn);
    const lessonBody = (lesson: Lesson): string => (isArabic.value ? lesson.bodyAr : lesson.bodyEn);
    const labTitle = (lab: Lab): string => (isArabic.value ? lab.titleAr : lab.titleEn);
    const labDescription = (lab: Lab): string => (isArabic.value ? lab.descriptionAr : lab.descriptionEn);

    const completedCount = computed(() => MODULES.filter((module) => moduleIsComplete(progress.value, module.id)).length);
    const progressPercent = computed(() => Math.round((completedCount.value / Math.max(1, MODULES.length)) * 100));

    const refreshBadges = () => {
        const derived = earnedBadges(progress.value.completedModules);
        progress.value.badges = Array.from(new Set([...progress.value.badges, ...derived]));
    };

    const loadProgress = async () => {
        loading.value = true;
        loadError.value = null;
        try {
            const response = await api.get(urlsMap.academyProgress);
            const payload = response.data?.data ?? response.data ?? {};
            const source = payload?.progress ?? payload;
            progress.value = normalizeProgress(source);
            refreshBadges();
            if (progress.value.lastModuleId && MODULES.some((module) => module.id === progress.value.lastModuleId)) {
                selectedId.value = progress.value.lastModuleId;
            }
        } catch (error) {
            loadError.value = extractApiErrorMessage(error);
            persistWarning.value = t("Progress could not be loaded. The academy still works, but progress will not persist until the API is reachable.");
        } finally {
            loading.value = false;
        }
    };

    const persist = async () => {
        saving.value = true;
        try {
            await api.put(urlsMap.academyProgress, {
                progress: {
                    completedModules: progress.value.completedModules,
                    quizScores: progress.value.quizScores,
                    completedLabs: progress.value.completedLabs,
                    badges: progress.value.badges,
                    lastModuleId: progress.value.lastModuleId,
                },
            });
            persistWarning.value = null;
        } catch (error) {
            const message = extractApiErrorMessage(error);
            persistWarning.value = `${t("Progress will not persist")}: ${message}`;
            showSnackBar({ type: "error", message });
        } finally {
            saving.value = false;
        }
    };

    void loadProgress();

    const selectModule = (moduleId: string) => {
        selectedId.value = moduleId;
        if (progress.value.lastModuleId !== moduleId) {
            progress.value.lastModuleId = moduleId;
            void persist();
        }
    };

    const setAnswer = (moduleId: string, questionIndex: number, value: number | null) => {
        const existing = answers.value[moduleId] ?? {};
        answers.value = {
            ...answers.value,
            [moduleId]: { ...existing, [questionIndex]: value ?? undefined },
        };
    };

    const allAnswered = (module: AcademyModule): boolean =>
        module.quiz.every((_, index) => answers.value[module.id]?.[index] !== undefined);

    const submitQuiz = async (module: AcademyModule) => {
        const moduleAnswers = answers.value[module.id] ?? {};
        let correct = 0;
        module.quiz.forEach((question, index) => {
            if (moduleAnswers[index] === question.answer) {
                correct += 1;
            }
        });
        const total = module.quiz.length;
        const pct = total > 0 ? Math.round((correct / total) * 100) : 0;
        const passed = total > 0 && correct * 3 >= total * 2;
        progress.value.quizScores = {
            ...progress.value.quizScores,
            [module.id]: Math.max(progress.value.quizScores[module.id] ?? 0, pct),
        };
        submitted.value = {
            ...submitted.value,
            [module.id]: { correct, total, pct, passed },
        };
        if (passed && !progress.value.completedModules.includes(module.id)) {
            progress.value.completedModules = [...progress.value.completedModules, module.id];
        }
        refreshBadges();
        showSnackBar({
            type: passed ? "success" : "warning",
            message: passed ? t("Quiz passed") : t("Quiz not passed yet"),
        });
        await persist();
    };

    const retryQuiz = (moduleId: string) => {
        answers.value = { ...answers.value, [moduleId]: {} };
        const nextSubmitted = { ...submitted.value };
        delete nextSubmitted[moduleId];
        submitted.value = nextSubmitted;
    };

    const labDone = (moduleId: string): boolean => progress.value.completedLabs.includes(moduleId);

    const toggleLab = async (module: AcademyModule, value: boolean) => {
        const next = new Set(progress.value.completedLabs);
        if (value) {
            next.add(module.id);
        } else {
            next.delete(module.id);
        }
        progress.value.completedLabs = Array.from(next);
        if (value && !progress.value.completedModules.includes(module.id)) {
            progress.value.completedModules = [...progress.value.completedModules, module.id];
        }
        refreshBadges();
        await persist();
    };

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Employee Academy")}
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                            <StatusChip label={`${completedCount.value} / ${MODULES.length} ${t("modules")}`} tone="info" />
                            <VChip color="primary" variant="tonal" size="small">
                                {t("Certification Tracks")}
                            </VChip>
                        </ThemedView>
                    )}
                />

                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        <ThemedView style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: "10px" }}>
                            <ThemedText type="defaultSemiBold">{t("Overall progress")}</ThemedText>
                            <ThemedText type="defaultSemiBold">{`${progressPercent.value}%`}</ThemedText>
                        </ThemedView>
                        <VProgressLinear modelValue={progressPercent.value} color="success" height="10px" rounded />
                        <ThemedView style={{ flexDirection: "row", flexWrap: "wrap", gap: "8px" }}>
                            {BADGE_TRACKS.map((track) => {
                                const earned = progress.value.badges.includes(track.badge);
                                return (
                                    <VChip
                                        key={track.badge}
                                        color={earned ? "success" : undefined}
                                        variant={earned ? "flat" : "outlined"}
                                        prependIcon={earned ? "mdi-certificate" : "mdi-lock-outline"}
                                        size="small"
                                    >
                                        {isArabic.value ? track.titleAr : track.titleEn}
                                    </VChip>
                                );
                            })}
                        </ThemedView>
                        {saving.value && (
                            <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>{t("Saving progress")}</ThemedText>
                        )}
                    </VCardText>
                </VCard>

                {persistWarning.value && (
                    <VAlert type="warning" variant="tonal" density="compact">
                        <ThemedView style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}>
                            <ThemedText style={{ fontSize: "13px" }}>{persistWarning.value}</ThemedText>
                            <VBtn size="small" variant="text" onClick={() => void loadProgress()}>
                                {t("Retry")}
                            </VBtn>
                        </ThemedView>
                    </VAlert>
                )}

                {loading.value ? (
                    <StateView loading />
                ) : (
                    <>
                        {loadError.value && (
                            <VAlert type="warning" variant="tonal" density="compact">
                                <ThemedText style={{ fontSize: "13px" }}>
                                    {`${t("Progress could not be loaded")}: ${loadError.value}`}
                                </ThemedText>
                            </VAlert>
                        )}
                        <ThemedView style={{ flexDirection: "row", flexWrap: "wrap", gap: "16px", alignItems: "flex-start" }}>
                            <ThemedView style={{ flex: "1 1 320px", gap: "10px" }}>
                                {MODULES.map((module) => {
                                    const active = module.id === selectedModule.value.id;
                                    const complete = moduleIsComplete(progress.value, module.id);
                                    return (
                                        <VCard
                                            key={module.id}
                                            onClick={() => selectModule(module.id)}
                                            style={{
                                                cursor: "pointer",
                                                border: active ? "2px solid var(--v-theme-primary)" : "1px solid rgba(100,116,139,0.18)",
                                            }}
                                        >
                                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                                <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "10px" }}>
                                                    <StatusChip label={module.letter} tone={active ? "primary" : "neutral"} />
                                                    <ThemedText type="defaultSemiBold" style={{ fontSize: "14px", flex: 1 }}>
                                                        {moduleTitle(module)}
                                                    </ThemedText>
                                                    {complete && <StatusChip label={t("Complete")} tone="success" size="x-small" />}
                                                </ThemedView>
                                                <ThemedText style={{ fontSize: "12px", opacity: 0.7 }}>{moduleSummary(module)}</ThemedText>
                                                <ThemedView style={{ flexDirection: "row", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                                                    <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>
                                                        {`${module.lessons.length} ${t("lessons")}`}
                                                    </ThemedText>
                                                    <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>
                                                        {`${t("Best quiz")}: ${progress.value.quizScores[module.id] ?? 0}%`}
                                                    </ThemedText>
                                                    {labDone(module.id) && <StatusChip label={t("Lab done")} tone="info" size="x-small" />}
                                                </ThemedView>
                                            </VCardText>
                                        </VCard>
                                    );
                                })}
                            </ThemedView>

                            <ThemedView style={{ flex: "2 1 520px", gap: "16px" }}>
                                <VCard>
                                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                        <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                                            <StatusChip label={selectedModule.value.letter} tone="primary" />
                                            <ThemedText type="defaultSemiBold" style={{ fontSize: "20px" }}>
                                                {moduleTitle(selectedModule.value)}
                                            </ThemedText>
                                            {moduleIsComplete(progress.value, selectedModule.value.id) && (
                                                <StatusChip label={t("Complete")} tone="success" />
                                            )}
                                        </ThemedView>
                                        <ThemedText style={{ fontSize: "13px", opacity: 0.8 }}>
                                            {moduleSummary(selectedModule.value)}
                                        </ThemedText>
                                    </VCardText>
                                </VCard>

                                <VCard>
                                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                        <ThemedText type="defaultSemiBold">{t("Lessons")}</ThemedText>
                                        <VExpansionPanels multiple>
                                            {selectedModule.value.lessons.map((lesson, index) => (
                                                <VExpansionPanel key={`${selectedModule.value.id}-lesson-${index}`} value={index}>
                                                    <VExpansionPanelTitle>{lessonTitle(lesson)}</VExpansionPanelTitle>
                                                    <VExpansionPanelText>
                                                        <ThemedText style={{ fontSize: "13px", lineHeight: 1.75, whiteSpace: "pre-line" }}>
                                                            {lessonBody(lesson)}
                                                        </ThemedText>
                                                    </VExpansionPanelText>
                                                </VExpansionPanel>
                                            ))}
                                        </VExpansionPanels>
                                    </VCardText>
                                </VCard>

                                <VCard variant="outlined">
                                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                        <ThemedView style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
                                            <ThemedText type="defaultSemiBold">{labTitle(selectedModule.value.lab)}</ThemedText>
                                            <VSwitch
                                                modelValue={labDone(selectedModule.value.id)}
                                                onUpdate:modelValue={(value: boolean | null) =>
                                                    void toggleLab(selectedModule.value, !!value)
                                                }
                                                label={t("Mark lab complete")}
                                                color="success"
                                                hideDetails
                                                density="compact"
                                            />
                                        </ThemedView>
                                        <ThemedText style={{ fontSize: "13px", opacity: 0.8 }}>
                                            {labDescription(selectedModule.value.lab)}
                                        </ThemedText>
                                    </VCardText>
                                </VCard>

                                <VCard>
                                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                                        <ThemedView style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}>
                                            <ThemedText type="defaultSemiBold">{t("Quiz")}</ThemedText>
                                            <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>
                                                {`${t("Best score")}: ${progress.value.quizScores[selectedModule.value.id] ?? 0}%`}
                                            </ThemedText>
                                        </ThemedView>

                                        {selectedModule.value.quiz.map((question, index) => {
                                            const result = submitted.value[selectedModule.value.id];
                                            const chosen = answers.value[selectedModule.value.id]?.[index];
                                            return (
                                                <ThemedView key={`${selectedModule.value.id}-quiz-${index}`} style={{ gap: "6px" }}>
                                                    <ThemedText type="defaultSemiBold" style={{ fontSize: "14px" }}>
                                                        {`${index + 1}. ${isArabic.value ? question.q_ar : question.q_en}`}
                                                    </ThemedText>
                                                    <VRadioGroup
                                                        modelValue={chosen}
                                                        onUpdate:modelValue={(value: number | null) => setAnswer(selectedModule.value.id, index, value)}
                                                    >
                                                        {question.options.map((option, optionIndex) => (
                                                            <VRadio
                                                                key={`${selectedModule.value.id}-${index}-${optionIndex}`}
                                                                value={optionIndex}
                                                                label={option}
                                                                color={
                                                                    result
                                                                        ? optionIndex === question.answer
                                                                            ? "success"
                                                                            : optionIndex === chosen
                                                                              ? "error"
                                                                              : undefined
                                                                        : undefined
                                                                }
                                                            />
                                                        ))}
                                                    </VRadioGroup>
                                                </ThemedView>
                                            );
                                        })}

                                        {submitted.value[selectedModule.value.id] && (
                                            <VAlert
                                                type={submitted.value[selectedModule.value.id]?.passed ? "success" : "warning"}
                                                variant="tonal"
                                                density="compact"
                                            >
                                                <ThemedText style={{ fontSize: "13px" }}>
                                                    {`${submitted.value[selectedModule.value.id]?.correct ?? 0} / ${submitted.value[selectedModule.value.id]?.total ?? 0} · ${submitted.value[selectedModule.value.id]?.pct ?? 0}% ${submitted.value[selectedModule.value.id]?.passed ? `— ${t("passed")}` : `— ${t("needs 2/3 to pass")}`}`}
                                                </ThemedText>
                                            </VAlert>
                                        )}

                                        <ThemedView style={{ flexDirection: "row", gap: "10px", flexWrap: "wrap" }}>
                                            <VBtn
                                                disabled={!allAnswered(selectedModule.value)}
                                                loading={saving.value}
                                                onClick={() => void submitQuiz(selectedModule.value)}
                                            >
                                                {t("Submit quiz")}
                                            </VBtn>
                                            <VBtn
                                                variant="tonal"
                                                disabled={!submitted.value[selectedModule.value.id]}
                                                onClick={() => retryQuiz(selectedModule.value.id)}
                                            >
                                                {t("Retry")}
                                            </VBtn>
                                        </ThemedView>
                                    </VCardText>
                                </VCard>
                            </ThemedView>
                        </ThemedView>
                    </>
                )}
            </ThemedView>
        </ScreenContainer>
    );
});

export default AcademyPage;
