export type ChapterRole = "MERCHANT_ADMIN" | "MERCHANT_STAFF" | "MERCHANT_CASHIER" | "DEVELOPER" | "ALL";

export type GuideChapter = {
    id: string;
    role: ChapterRole;
    titleEn: string;
    titleAr: string;
    bodyEn: string;
    bodyAr: string;
    tags: string[];
};

export const GUIDE_CHAPTERS: GuideChapter[] = [
    {
        id: "kyb-onboarding",
        role: "MERCHANT_ADMIN",
        titleEn: "Completing KYB onboarding & beneficial owner declarations",
        titleAr: "إكمال التحقق من النشاط وإقرار المالكين المستفيدين",
        bodyEn: `KYB is completed once, before the first live payment. Upload the commercial registration, tax certificate, shareholder register, articles of association and the identity documents of every director. The platform re-screens the company and all beneficial owners against sanctions and PEP lists.
A beneficial owner is any natural person who ultimately owns or controls 25% or more of the company, directly or indirectly. Declare each one with full name, nationality, date of birth, identity number, ownership percentage and residential address.
Keep the ownership percentages adding up to 100%. If a corporate shareholder owns part of the company, look through it until you reach natural persons. When no individual reaches 25%, declare the senior managing official as the controlling person and explain the ownership chain.
Submit the declaration electronically; compliance may request source-of-funds evidence or a certified translation. A rejected item must be corrected in the same onboarding case before the application can go live.`,
        bodyAr: `يتم إكمال التحقق من النشاط مرة واحدة قبل أول عملية دفع حقيقية. ارفع السجل التجاري وشهادة الضريبة وسجل المساهمين وعقد التأسيس ووثائق هوية كل عضو في مجلس الإدارة. تعيد المنصة فحص الشركة وجميع المالكين المستفيدين مقابل قوائم العقوبات والأشخاص السياسيين البارزين.
المالك المستفيد هو أي شخص طبيعي يملك أو يسيطر فعلياً على 25% أو أكثر من الشركة، بشكل مباشر أو غير مباشر. أقرّ كل مالك بالاسم الكامل والجنسية وتاريخ الميلاد ورقم الهوية ونسبة الملكية وعنوان الإقامة.
يجب أن تكون مجموع نسب الملكية 100%. إذا كان أحد المساهمين شركة، فاخترق هيكل الملكية حتى تصل إلى الأشخاص الطبيعيين. وإذا لم يبلغ أي فرد 25%، فحدّد المسؤول التنفيذي الأعلى كشخص مسيطر مع شرح سلسلة الملكية.
قدّم الإقرار إلكترونياً؛ وقد يطلب فريق الامتثال إثبات مصدر الأموال أو ترجمة معتمدة. يجب تصحيح أي بند مرفوض في نفس ملف التحقق قبل تشغيل التطبيق.`,
        tags: ["kyb", "onboarding", "beneficial owner", "ubo", "25%", "compliance", "التحقق", "المالك المستفيد", "الامتثال"],
    },
    {
        id: "wallets-applications",
        role: "MERCHANT_ADMIN",
        titleEn: "Wallets, applications, and why each application connects to one wallet",
        titleAr: "المحافظ والتطبيقات وسبب ربط كل تطبيق بمحفظة واحدة",
        bodyEn: `Each merchant starts with at least one settlement wallet in a single currency. The wallet holds the net credited balance after every confirmed payment, commission and refund. Its balance is ledger-derived, so it always reconciles to the statement lines.
An application is the technical profile of one sales channel: a website, a mobile app, a POS fleet or an API integration. Every application must be linked to exactly one wallet, because the application determines the fee profile and the wallet determines where the net money lands.
You can create several applications under the same wallet when they share the same currency and settlement account, but never share one application between wallets. Each application also carries its own rail whitelist and redirect domain allowlist.
Changing the assigned wallet is an audited action and only applies to future payments. Open Wallets to see balances, then Applications to create or edit a channel, choose its allowed rails and set the redirect domains.`,
        bodyAr: `يبدأ كل تاجر بمحفظة تسوية واحدة على الأقل بعملة واحدة. تحتفظ المحفظة بصافي الرصيد الدائن بعد كل عملية دفع مؤكدة والعمولة والمبالغ المستردة. الرصيد مستخرج من دفتر القيود، لذلك يطابق دائماً بنود كشف الحساب.
التطبيق هو الملف التقني لقناة بيع واحدة: موقع إلكتروني أو تطبيق جوال أو أسطول نقاط بيع أو تكامل API. يجب ربط كل تطبيق بمحفظة واحدة فقط، لأن التطبيق يحدد هيكل العمولة والمحفظة تحدد مكان وصول صافي المبلغ.
يمكنك إنشاء عدة تطبيقات تحت المحفظة نفسها إذا كانت تشترك في العملة وحساب التسوية، لكن لا تشارك تطبيقاً واحداً بين محفظتين. يحمل كل تطبيق أيضاً قائمة القنوات المسموحة وقائمة نطاقات إعادة التوجيه المسموحة.
تغيير المحفظة المرتبطة إجراء مسجل في سجل التدقيق ويطبق على المدفوعات المستقبلية فقط. افتح المحافظ للاطلاع على الأرصدة، ثم التطبيقات لإنشاء قناة أو تعديلها واختيار القنوات المسموحة ونطاقات إعادة التوجيه.`,
        tags: ["wallet", "application", "settlement", "channel", "المحفظة", "التطبيق", "التسوية"],
    },
    {
        id: "payment-links",
        role: "MERCHANT_STAFF",
        titleEn: "Creating single-use vs multi-use payment links and using safe redirect URLs",
        titleAr: "إنشاء روابط دفع أحادية الاستخدام أو متعددة الاستخدام واستخدام روابط إعادة توجيه آمنة",
        bodyEn: `Single-use links are the default for invoices and one-off orders: maxUses = 1 and the link locks after a confirmed payment. Multi-use links accept a fixed number of confirmed payments (maxUses) or run without a cap when infinite use is enabled; use them only for repeated small collections such as subscriptions or a counter QR.
Always send the payer back to a URL you control. Add the exact scheme and host to the application redirect allowlist; wildcards are not accepted for production. The checkout appends the payment reference to the redirect, so verify the reference on your server before releasing goods or showing a receipt.
Prefer short expiries for high-value links and cancel links you no longer need. A cancelled or expired link cannot be paid, but it remains visible with its attempts for reconciliation.`,
        bodyAr: `الروابط أحادية الاستخدام هي الافتراضي للفواتير والطلبات لمرة واحدة: maxUses = 1 ويُقفل الرابط بعد عملية دفع مؤكدة. تقبل الروابط متعددة الاستخدام عدداً محدداً من المدفوعات المؤكدة (maxUses) أو تعمل بلا حد عند تفعيل الاستخدام اللانهائي؛ استخدمها فقط للتحصيلات الصغيرة المتكررة مثل الاشتراكات أو رمز QR عند الكاشير.
أعد الدافع دائماً إلى رابط تتحكم به. أضف المخطط والمضيف بدقة إلى قائمة نطاقات إعادة التوجيه في التطبيق؛ لا تُقبل العلامات البديلة (wildcards) في بيئة الإنتاج. تضيف صفحة الدفع رقم العملية المرجعي إلى رابط العودة، لذا تحقق من الرقم على خادمك قبل تسليم البضاعة أو إظهار الإيصال.
استخدم صلاحية قصيرة للروابط عالية القيمة وألغِ الروابط التي لم تعد تحتاجها. لا يمكن الدفع عبر رابط ملغى أو منتهي، لكنه يبقى ظاهراً مع محاولاته لأغراض المطابقة.`,
        tags: ["links", "single-use", "multi-use", "redirect", "qr", "invoice", "الروابط", "إعادة التوجيه"],
    },
    {
        id: "pos-pairing",
        role: "MERCHANT_CASHIER",
        titleEn: "Setting up POS terminals and pairing realtime cashier/customer screens (15-minute idle rule)",
        titleAr: "إعداد نقاط البيع وربط شاشات الكاشير والعميل الفورية (قاعدة الخمول 15 دقيقة)",
        bodyEn: `Create a POS terminal for each physical branch or counter, then pair two screens: a CASHIER screen that starts and confirms payments, and a CUSTOMER screen that displays the amount and the live status. Pairing uses a short code shown on the cashier screen; the customer screen stays read-only.
The 15-minute idle rule protects unattended counters. After 15 minutes without cashier activity the session expires and the cashier must re-enter the pairing code. An in-flight payment is never cancelled by the idle timer, but new payments cannot start until the terminal is paired again.
Keep terminal names and locations accurate so settlement and disputes can be traced to the right branch. If a device is lost or replaced, deactivate its screen and pair a new one from the terminal detail page.`,
        bodyAr: `أنشئ نقطة بيع لكل فرع أو كاونتر، ثم اربط شاشتين: شاشة الكاشير التي تبدأ المدفوعات وتؤكدها، وشاشة العميل التي تعرض المبلغ والحالة الفورية. يتم الربط عبر رمز قصير يظهر على شاشة الكاشير، وتبقى شاشة العميل للقراءة فقط.
تحمي قاعدة الخمول 15 دقيقة الكاونترات غير المراقبة. بعد 15 دقيقة دون نشاط للكاشير تنتهي الجلسة ويجب إدخال رمز الربط مرة أخرى. لا تؤدي قاعدة الخمول إلى إلغاء عملية دفع جارية، لكن لا يمكن بدء مدفوعات جديدة حتى يعاد ربط الجهاز.
احرص على دقة أسماء النقاط ومواقعها لتتبع التسوية والنزاعات إلى الفرع الصحيح. إذا فُقد جهاز أو استُبدل، فعطّل شاشته واربط شاشة جديدة من صفحة تفاصيل النقطة.`,
        tags: ["pos", "terminal", "cashier", "customer screen", "pairing", "idle", "15 minutes", "نقاط البيع", "الكاشير", "الربط"],
    },
    {
        id: "fee-bearers",
        role: "ALL",
        titleEn: "How fee bearers work (MERCHANT_ABSORBS vs PAYER_SURCHARGE vs SPLIT)",
        titleAr: "كيف تعمل أطراف تحمل العمولة (MERCHANT_ABSORBS مقابل PAYER_SURCHARGE مقابل SPLIT)",
        bodyEn: `MERCHANT_ABSORBS: the customer pays exactly the invoice amount. The platform commission is deducted from your side and the wallet is credited amount − commission.
PAYER_SURCHARGE: the customer pays amount + commission, and your wallet is credited the full amount. The surcharge must be visible at checkout before the payer confirms.
SPLIT: the commission is shared. The payer pays amount + (commission × platform share), and your wallet is credited amount − (commission − payer share). The platform share is a decimal ratio stored with the link, never a floating-point percentage.
The fee bearer is chosen when the link is created and is frozen for that payment attempt. Preview the three outcomes before publishing a link so the customer-facing price matches the price you advertise.`,
        bodyAr: `MERCHANT_ABSORBS: يدفع العميل مبلغ الفاتورة فقط. تُخصم عمولة المنصة من جانبك وتُضاف إلى المحفظة القيمة: المبلغ − العمولة.
PAYER_SURCHARGE: يدفع العميل المبلغ + العمولة، وتُضاف إلى محفظتك القيمة كاملة. يجب إظهار الرسوم الإضافية في صفحة الدفع قبل تأكيد الدافع.
SPLIT: تُقسم العمولة. يدفع الدافع المبلغ + (العمولة × حصة المنصة)، وتُضاف إلى محفظتك القيمة: المبلغ − (العمولة − حصة الدافع). حصة المنصة نسبة عشرية مخزنة مع الرابط وليست نسبة عائمة.
يُختار طرف تحمل العمولة عند إنشاء الرابط ويُثبّت لتلك المحاولة. عاين النتائج الثلاث قبل نشر الرابط حتى يطابق السعر الظاهر للعميل السعر المعلن.`,
        tags: ["fees", "commission", "fee bearer", "surcharge", "split", "العمولة", "الرسوم", "التقسيم"],
    },
    {
        id: "balance-statements-cashouts",
        role: "MERCHANT_ADMIN",
        titleEn: "Reading the real-time wallet balance, monthly hash-verified statements and requesting cash-outs",
        titleAr: "قراءة رصيد المحفظة الفوري وكشوف الحساب الشهرية المتحقق منها بالتجزئة وطلب السحب",
        bodyEn: `The wallet balance on the dashboard is real-time and ledger-derived: confirmed payments add net amounts, refunds and chargebacks debit them, and pending cash-outs reserve funds. Never treat an authorized but unconfirmed payment as available money.
At the end of each month the platform publishes a statement containing every ledger line, the opening and closing balance, commission, gateway fees and the statement hash. Download the PDF or CSV from Statements; keep the hash and verify the export with the monthly anchor published by the platform.
To move money out, open Cash-Outs, choose the wallet, enter the amount and the bank destination, then submit. The amount is reserved immediately; finance reviews the request and the bank transfer reference is attached to the cash-out when it is paid.`,
        bodyAr: `رصيد المحفظة في لوحة التحكم فوري ومستخرج من دفتر القيود: تضيف المدفوعات المؤكدة صافي المبالغ، وتخصم المرتجعات والمطالبات منها، وتحجز طلبات السحب المعلقة الأموال. لا تعتبر أي عملية مصرح بها وغير مؤكدة أموالاً متاحة.
في نهاية كل شهر تنشر المنصة كشف حساب يتضمن كل قيد ودفتر القيود والرصيد الافتتاحي والختامي والعمولة ورسوم البوابة وتجزئة الكشف. نزّل PDF أو CSV من كشوف الحساب؛ واحتفظ بالتجزئة وتحقق من التصدير باستخدام المرساة الشهرية التي تنشرها المنصة.
لسحب الأموال، افتح السحب واختر المحفظة وأدخل المبلغ ووجهة التحويل البنكي ثم أرسل الطلب. يُحجز المبلغ فوراً؛ ويراجع فريق المالية الطلب ويُرفق رقم التحويل البنكي بطلب السحب عند دفعه.`,
        tags: ["balance", "statement", "hash", "cashout", "settlement", "الرصيد", "كشف الحساب", "السحب", "التجزئة"],
    },
    {
        id: "disputes",
        role: "MERCHANT_STAFF",
        titleEn: "Responding to disputes and uploading evidence before the deadline",
        titleAr: "الرد على النزاعات وتحميل الأدلة قبل الموعد النهائي",
        bodyEn: `A dispute starts when a payer or issuer challenges a confirmed payment. You receive the reason code, the deadline and the amount at risk; the disputed amount is held from your available balance until the case closes.
Upload evidence before the deadline: receipts, signed delivery notes, terms and conditions, customer communications, refund policy and any proof that the service was delivered. Use the case page to attach files; evidence is timestamped and cannot be edited after submission.
Respond even if you intend to accept the dispute, so the case does not auto-close against you. Missing the deadline forfeits the right to contest. After the decision the held amount is either released back to the wallet or debited, and the outcome is recorded on the payment.`,
        bodyAr: `يبدأ النزاع عندما يعترض الدافع أو البنك المصدر على عملية دفع مؤكدة. تصلك شيفرة السبب والموعد النهائي والمبلغ المعرض للخطر؛ ويُحجز المبلغ المتنازع عليه من رصيدك المتاح حتى إغلاق الحالة.
ارفع الأدلة قبل الموعد النهائي: الإيصالات وإشعارات التسليم الموقعة والشروط والأحكام ومراسلات العميل وسياسة الاسترداد وأي إثبات لتسليم الخدمة. استخدم صفحة الحالة لإرفاق الملفات؛ تُختم الأدلة بالوقت ولا يمكن تعديلها بعد الإرسال.
ردّ على النزاع حتى لو كنت تنوي قبوله، كي لا تُغلق الحالة تلقائياً ضدك. تفويت الموعد النهائي يفقدك حق الاعتراض. بعد القرار يُعاد المبلغ المحجوز إلى المحفظة أو يُخصم، وتُسجل النتيجة على عملية الدفع.`,
        tags: ["dispute", "evidence", "chargeback", "deadline", "refund", "النزاع", "الأدلة", "الاسترداد"],
    },
    {
        id: "merchant-direct",
        role: "DEVELOPER",
        titleEn: "Using your own gateway credentials (MERCHANT_DIRECT) and how commission receivable netting works",
        titleAr: "استخدام بيانات بوابة الدفع الخاصة بك (MERCHANT_DIRECT) وطريقة مقاصة العمولة المستحقة",
        bodyEn: `MERCHANT_DIRECT means your own gateway credentials are used for the rail. Add the credential set under Credentials, choose LIVE or SANDBOX, and store the secret only in the platform vault; the portal never displays it again after saving.
When you settle directly with the provider, the provider pays you outside the platform. The platform still books its commission as a receivable: every confirmed payment creates a commission receivable that is netted against your next platform settlement or collected from your wallet. Watch the receivable balance so a direct-settlement period does not leave an unpaid commission.
Test each credential set in SANDBOX first, keep the credential check green, and rotate secrets through a new credential set rather than editing production values in place.`,
        bodyAr: `MERCHANT_DIRECT يعني استخدام بيانات بوابة الدفع الخاصة بك لتلك القناة. أضف مجموعة البيانات من صفحة البيانات، واختر LIVE أو SANDBOX، واحفظ السر في خزنة المنصة فقط؛ لا يعرضه البوابة مرة أخرى بعد الحفظ.
عندما تسوي مباشرة مع مزود الخدمة، يدفع لك المزود خارج المنصة. ومع ذلك تسجل المنصة عمولتها كمبلغ مستحق: كل عملية دفع مؤكدة تنشئ عمولة مستحقة تُقاص مقابل تسويتك التالية على المنصة أو تُحصّل من محفظتك. راقب رصيد المستحقات حتى لا تترك فترة التسوية المباشرة عمولة غير مدفوعة.
اختبر كل مجموعة بيانات في SANDBOX أولاً، وحافظ على نجاح فحص البيانات، وبدّل الأسرار عبر مجموعة جديدة بدلاً من تعديل قيم الإنتاج مباشرة.`,
        tags: ["merchant direct", "credentials", "commission receivable", "netting", "api", "البيانات", "العمولة المستحقة", "المقاصة"],
    },
    {
        id: "team-security",
        role: "MERCHANT_ADMIN",
        titleEn: "Managing team members, application scopes and security (MFA, IP whitelists)",
        titleAr: "إدارة أعضاء الفريق ونطاقات التطبيقات والأمان (التحقق متعدد العوامل وقوائم IP)",
        bodyEn: `Invite team members from Team & Roles and assign the smallest role that lets them work: MERCHANT_ADMIN for company settings, MERCHANT_STAFF for day-to-day operations and MERCHANT_CASHIER for POS only. Application scopes decide which applications a member can operate; an empty scope means no application access.
Require MFA for every admin and for anyone who can request a cash-out or change credentials. When a member leaves, disable the account immediately, revoke their API tokens and rotate shared secrets.
IP allowlists on access tokens restrict API use to your office or server ranges. Keep CIDR entries narrow, review last-used timestamps, and revoke unused tokens instead of letting them expire silently.`,
        bodyAr: `ادعُ أعضاء الفريق من صفحة الفريق والأدوار وامنحهم أصغر دور يمكّنهم من العمل: MERCHANT_ADMIN لإعدادات الشركة، وMERCHANT_STAFF للعمليات اليومية، وMERCHANT_CASHIER لنقاط البيع فقط. تحدد نطاقات التطبيقات أي التطبيقات يمكن للعضو تشغيلها؛ النطاق الفارغ يعني عدم وجود وصول لأي تطبيق.
فعّل التحقق متعدد العوامل لكل مسؤول ولكل من يمكنه طلب سحب أو تغيير بيانات الاعتماد. عند مغادرة عضو، عطّل الحساب فوراً وألغِ رموز API الخاصة به وبدّل الأسرار المشتركة.
تقيّد قوائم IP المسموحة على رموز الوصول استخدام API على نطاقات مكتبك أو خوادمك. اجعل إدخالات CIDR ضيقة، وراجع أوقات آخر استخدام، وألغِ الرموز غير المستخدمة بدلاً من تركها تنتهي بصمت.`,
        tags: ["team", "roles", "scopes", "security", "mfa", "ip whitelist", "الفريق", "الأدوار", "الأمان", "التحقق"],
    },
];
