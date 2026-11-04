/**
 * English/Arabic catalogue for the public landing page (`pages/public/landing/**`).
 * Merged into the app messages by `plugins/i18n.ts`. Keys are the English text,
 * matching `i18nCatalogue.ts`. Keys that already exist there are NOT repeated here
 * (enforced by `src/content/__tests__/landing-content.test.ts`).
 */
export const landingCatalogue: Record<string, [string, string]> = {
    // Header / navigation
    "Skip to main content": ["Skip to main content", "تخطَّ إلى المحتوى الرئيسي"],
    "Sections": ["Sections", "الأقسام"],
    "How it works": ["How it works", "كيف يعمل"],
    "Product": ["Product", "المنتج"],
    "Developers": ["Developers", "المطورون"],
    "Security": ["Security", "الأمان"],
    "Get started": ["Get started", "ابدأ الآن"],
    "Footer": ["Footer", "تذييل الصفحة"],
    "Create account": ["Create account", "إنشاء حساب"],
    "Merchant guide": ["Merchant guide", "دليل التاجر"],
    "Developer guide": ["Developer guide", "دليل المطوّرين"],

    // Document meta
    "Payment links, in-store POS screens and a server API for Libyan businesses, backed by a bilingual hosted checkout and a double-entry ledger.": [
        "Payment links, in-store POS screens and a server API for Libyan businesses, backed by a bilingual hosted checkout and a double-entry ledger.",
        "روابط دفع وشاشات نقاط بيع داخل المتجر وواجهة برمجية للخوادم للأعمال الليبية، مدعومة بصفحة دفع مستضافة ثنائية اللغة ودفتر أستاذ بالقيد المزدوج.",
    ],

    // Hero
    "Built for Libyan businesses": ["Built for Libyan businesses", "مصمَّمة للأعمال الليبية"],
    "Collect on any rail.": ["Collect on any rail.", "حصِّل عبر أي قناة دفع."],
    "Reconcile every dinar.": ["Reconcile every dinar.", "وطابِق كل دينار."],
    "Collect on any rail. Reconcile every dinar.": [
        "Collect on any rail. Reconcile every dinar.",
        "حصِّل عبر أي قناة دفع، وطابِق كل دينار.",
    ],
    "Payment links, in-store POS screens and a server API — one KYB-verified merchant account, a bilingual hosted checkout, and a double-entry ledger behind every balance.": [
        "Payment links, in-store POS screens and a server API — one KYB-verified merchant account, a bilingual hosted checkout, and a double-entry ledger behind every balance.",
        "روابط دفع، وشاشات نقاط بيع داخل المتجر، وواجهة برمجية لخوادمك — بحساب تاجر واحد موثَّق بإجراءات «اعرف عميلك التجاري»، وصفحة دفع مستضافة باللغتين، ودفتر أستاذ بالقيد المزدوج وراء كل رصيد.",
    ],
    "Create a merchant account": ["Create a merchant account", "أنشئ حساب تاجر"],
    "Sign in to the portal": ["Sign in to the portal", "سجّل الدخول إلى البوابة"],
    "Bilingual hosted checkout": ["Bilingual hosted checkout", "صفحة دفع مستضافة باللغتين"],
    "KYB-verified before live money": ["KYB-verified before live money", "تحقُّق تجاري قبل أي تحصيل فعلي"],
    "Ledger-derived balances": ["Ledger-derived balances", "أرصدة مستمدة من دفتر الأستاذ"],

    // Hero simulator
    "Interactive payment simulation": ["Interactive payment simulation", "محاكاة تفاعلية لعملية دفع"],
    "Al-Waha Electronics": ["Al-Waha Electronics", "الواحة للإلكترونيات"],
    "Order #4092": ["Order #4092", "الطلب رقم 4092"],
    "Price locked on the server": ["Price locked on the server", "السعر مثبَّت على الخادم"],
    "Server-priced": ["Server-priced", "سعر من الخادم"],
    "Payment method": ["Payment method", "طريقة الدفع"],
    "One-time code": ["One-time code", "رمز لمرة واحدة"],
    "Scan QR": ["Scan QR", "مسح رمز QR"],
    "Approve in app": ["Approve in app", "موافقة من التطبيق"],
    "Bank redirect": ["Bank redirect", "تحويل إلى صفحة المصرف"],
    "Card form": ["Card form", "نموذج البطاقة"],
    "Choose how to pay": ["Choose how to pay", "اختر طريقة الدفع"],
    "Verifying with the provider": ["Verifying with the provider", "جارٍ التحقق لدى مزوّد الخدمة"],
    "Payment confirmed": ["Payment confirmed", "تم تأكيد الدفع"],
    "Redirecting to the bank page": ["Redirecting to the bank page", "جارٍ التحويل إلى صفحة المصرف"],
    "Awaiting customer": ["Awaiting customer", "بانتظار العميل"],
    "Verifying": ["Verifying", "قيد التحقق"],
    "Succeeded": ["Succeeded", "ناجحة"],
    "Journal entry": ["Journal entry", "قيد اليومية"],
    "Dr": ["Dr", "مدين"],
    "Cr": ["Cr", "دائن"],
    "Gateway clearing": ["Gateway clearing", "مقاصة البوابة"],
    "Your wallet": ["Your wallet", "محفظتك"],
    "Balanced: debits equal credits": ["Balanced: debits equal credits", "متوازن: المدين يساوي الدائن"],
    "Unbalanced": ["Unbalanced", "غير متوازن"],
    "Wallet": ["Wallet", "المحفظة"],
    "Play simulation": ["Play simulation", "تشغيل المحاكاة"],
    "Pause simulation": ["Pause simulation", "إيقاف المحاكاة مؤقتًا"],
    "Next step": ["Next step", "الخطوة التالية"],
    "Illustrative simulation. Example commission": ["Illustrative simulation. Example commission", "محاكاة توضيحية. عمولة على سبيل المثال"],
    "Payer opens your link and picks a rail": ["Payer opens your link and picks a rail", "يفتح الدافع رابطك ويختار قناة الدفع"],
    "The rail asks the payer to act": ["The rail asks the payer to act", "تطلب قناة الدفع من الدافع إتمام الإجراء"],
    "The gateway verifies with the provider": ["The gateway verifies with the provider", "تتحقق البوابة من العملية لدى مزوّد الخدمة"],
    "Trusted success: confirmed server-side": ["Trusted success: confirmed server-side", "نجاح موثوق: تأكيد من جهة الخادم"],
    "Double-entry journal posted, wallet credited": ["Double-entry journal posted, wallet credited", "رُحِّل قيد مزدوج وأُضيف المبلغ إلى المحفظة"],

    // Flow
    "How money moves": ["How money moves", "كيف تتحرك الأموال"],
    "From a shared link to a reconciled wallet": ["From a shared link to a reconciled wallet", "من رابط تشاركه إلى محفظة مطابَقة"],
    "Every step is a real state in the platform, so what you see in the portal is what happened.": [
        "Every step is a real state in the platform, so what you see in the portal is what happened.",
        "كل خطوة هنا حالة حقيقية في المنصة، فما تراه في البوابة هو ما حدث فعلًا.",
    ],
    "Payment link": ["Payment link", "رابط الدفع"],
    "You set the amount once. It is stored on the server and the checkout cannot change it.": [
        "You set the amount once. It is stored on the server and the checkout cannot change it.",
        "تحدد المبلغ مرة واحدة، فيُحفظ على الخادم ولا يمكن لصفحة الدفع تغييره.",
    ],
    "Hosted checkout": ["Hosted checkout", "صفحة الدفع المستضافة"],
    "The payer sees only the rails enabled for your application, in Arabic or English.": [
        "The payer sees only the rails enabled for your application, in Arabic or English.",
        "لا يرى الدافع إلا قنوات الدفع المفعّلة لتطبيقك، بالعربية أو الإنجليزية.",
    ],
    "Trusted confirmation": ["Trusted confirmation", "تأكيد موثوق"],
    "Success is accepted only on verified provider evidence, never on a browser return.": [
        "Success is accepted only on verified provider evidence, never on a browser return.",
        "لا يُعتمد النجاح إلا بدليل موثَّق من مزوّد الخدمة، وليس بمجرد عودة المتصفح.",
    ],
    "Double-entry ledger": ["Double-entry ledger", "دفتر أستاذ بالقيد المزدوج"],
    "Every attempt posts a balanced journal: commission, fees and your net, to four decimal places.": [
        "Every attempt posts a balanced journal: commission, fees and your net, to four decimal places.",
        "كل عملية ترحّل قيدًا متوازنًا: العمولة والرسوم وصافي مستحقاتك، بدقة أربع خانات عشرية.",
    ],
    "Wallet & cash-out": ["Wallet & cash-out", "المحفظة والسحب"],
    "Your balance is derived from the ledger. Request a cash-out to your verified bank account.": [
        "Your balance is derived from the ledger. Request a cash-out to your verified bank account.",
        "رصيدك مستمد من دفتر الأستاذ، ويمكنك طلب سحبه إلى حسابك المصرفي الموثَّق.",
    ],

    // Bento
    "Everything a Libyan merchant needs to get paid": ["Everything a Libyan merchant needs to get paid", "كل ما يحتاجه التاجر الليبي لتحصيل مستحقاته"],
    "Online, in store and from your own systems — one workspace, one ledger.": [
        "Online, in store and from your own systems — one workspace, one ledger.",
        "عبر الإنترنت وداخل المتجر ومن أنظمتك الخاصة — مساحة عمل واحدة ودفتر أستاذ واحد.",
    ],
    "Payment links & QR": ["Payment links & QR", "روابط الدفع ورموز QR"],
    "Single-use or multi-use links with expiry, a rail whitelist and a QR code. Share them anywhere; the amount is locked on the server.": [
        "Single-use or multi-use links with expiry, a rail whitelist and a QR code. Share them anywhere; the amount is locked on the server.",
        "روابط للاستخدام مرة واحدة أو لعدة مرات، مع تاريخ انتهاء وقائمة قنوات مسموح بها ورمز QR. شاركها في أي مكان، فالمبلغ مثبَّت على الخادم.",
    ],
    "Single-use": ["Single-use", "استخدام واحد"],
    "Multi-use": ["Multi-use", "استخدام متعدد"],
    "Rail whitelist": ["Rail whitelist", "قنوات مسموح بها"],
    "Live POS screens": ["Live POS screens", "شاشات نقاط بيع مباشرة"],
    "Pair a cashier terminal with a customer-facing screen that updates in real time.": [
        "Pair a cashier terminal with a customer-facing screen that updates in real time.",
        "اربط جهاز الكاشير بشاشة يراها العميل وتتحدّث لحظيًا.",
    ],
    "Waiting for payment": ["Waiting for payment", "بانتظار الدفع"],
    "Paid": ["Paid", "مدفوع"],
    "Fees you can see": ["Fees you can see", "رسوم واضحة أمامك"],
    "Absorb the fee, pass it to the payer, or split it. Try it:": [
        "Absorb the fee, pass it to the payer, or split it. Try it:",
        "تحمَّل الرسوم بنفسك، أو حمِّلها للدافع، أو اقسمها بينكما. جرِّب:",
    ],
    "Sale amount (LYD)": ["Sale amount (LYD)", "مبلغ البيع (د.ل)"],
    "Example commission %": ["Example commission %", "نسبة عمولة افتراضية %"],
    "Who pays the fee": ["Who pays the fee", "من يدفع الرسوم"],
    "You absorb": ["You absorb", "تتحمّلها أنت"],
    "Payer pays": ["Payer pays", "يدفعها العميل"],
    "Split 50/50": ["Split 50/50", "مناصفةً 50/50"],
    "Payer is charged": ["Payer is charged", "المبلغ على الدافع"],
    "Credited to your wallet": ["Credited to your wallet", "يُضاف إلى محفظتك"],
    "Wallets & sealed statements": ["Wallets & sealed statements", "محافظ وكشوف حساب مختومة"],
    "Balances come from the ledger, not an editable number. Monthly statements carry a snapshot hash and export to Excel.": [
        "Balances come from the ledger, not an editable number. Monthly statements carry a snapshot hash and export to Excel.",
        "الأرصدة مستمدة من دفتر الأستاذ لا من رقم قابل للتعديل، وكشوف الحساب الشهرية تحمل بصمة لقطة وتُصدَّر إلى Excel.",
    ],
    "Opening balance": ["Opening balance", "الرصيد الافتتاحي"],
    "Net credits": ["Net credits", "صافي الإيداعات"],
    "Cash-outs": ["Cash-outs", "السحوبات"],
    "Closing balance": ["Closing balance", "الرصيد الختامي"],
    "Snapshot hash": ["Snapshot hash", "بصمة اللقطة"],
    "Four-eyes changes": ["Four-eyes changes", "تغييرات بمبدأ العينين الأربع"],
    "Sensitive application changes are proposals until a second person approves them.": [
        "Sensitive application changes are proposals until a second person approves them.",
        "تبقى التغييرات الحساسة على التطبيق مقترحات حتى يعتمدها شخص ثانٍ.",
    ],
    "Disputes with deadlines": ["Disputes with deadlines", "نزاعات بمواعيد نهائية"],
    "See every chargeback, its evidence deadline, and upload your evidence in time.": [
        "See every chargeback, its evidence deadline, and upload your evidence in time.",
        "اطّلع على كل عملية استرداد وموعد تقديم أدلتها، وارفع أدلتك في الوقت المناسب.",
    ],
    "Roles for your team": ["Roles for your team", "أدوار لفريقك"],
    "Invite owners, accountants, cashiers and developers with scoped authorities.": [
        "Invite owners, accountants, cashiers and developers with scoped authorities.",
        "ادعُ المالكين والمحاسبين والكاشيرية والمطورين بصلاحيات محددة النطاق.",
    ],
    "Bring your own gateway": ["Bring your own gateway", "استخدم بوابتك الخاصة"],
    "Use your own gateway credentials and settle directly; the platform records only its commission.": [
        "Use your own gateway credentials and settle directly; the platform records only its commission.",
        "استخدم بيانات اعتماد بوابتك الخاصة واستلم أموالك مباشرة، ولا تسجّل المنصة إلا عمولتها.",
    ],

    // Stats
    "At a glance": ["At a glance", "لمحة سريعة"],
    "ways to pay on one checkout": ["ways to pay on one checkout", "طرق دفع في صفحة دفع واحدة"],
    "fee-bearer modes per link": ["fee-bearer modes per link", "أنماط لتحمّل الرسوم في كل رابط"],
    "languages, with full right-to-left": ["languages, with full right-to-left", "لغتان، مع دعم كامل للكتابة من اليمين إلى اليسار"],
    "floating-point operations on your money": ["floating-point operations on your money", "عمليات بالفاصلة العائمة على أموالك"],

    // Developers
    "Create a link from your backend in one request": ["Create a link from your backend in one request", "أنشئ رابط دفع من خادمك بطلب واحد"],
    "A small, strict server API: create, read and cancel links, and look up payments by reference.": [
        "A small, strict server API: create, read and cancel links, and look up payments by reference.",
        "واجهة برمجية صغيرة وصارمة للخوادم: أنشئ الروابط واقرأها وألغِها، واستعلم عن المدفوعات بمرجعها.",
    ],
    "pg_live_ bearer tokens": ["pg_live_ bearer tokens", "رموز الوصول \u2066pg_live_\u2069"],
    "Scoped, shown once, stored only as a hash, revocable at any time.": [
        "Scoped, shown once, stored only as a hash, revocable at any time.",
        "محددة الصلاحيات، تُعرض مرة واحدة، وتُخزَّن بصمتها فقط، ويمكن إلغاؤها في أي وقت.",
    ],
    "IP CIDR allowlists": ["IP CIDR allowlists", "قوائم عناوين IP مسموح بها (CIDR)"],
    "Lock a token to your servers so a leaked secret is useless elsewhere.": [
        "Lock a token to your servers so a leaked secret is useless elsewhere.",
        "اقصر استخدام الرمز على خوادمك، فلا ينفع إن تسرّب إلى أي مكان آخر.",
    ],
    "Decimal-string amounts": ["Decimal-string amounts", "مبالغ بصيغة نص عشري"],
    "Money travels as strings like \"250.000\" and is re-validated by the core. Never floats.": [
        "Money travels as strings like \"250.000\" and is re-validated by the core. Never floats.",
        "تُرسل المبالغ نصوصًا مثل \"250.000\" وتعيد الخدمة الأساسية التحقق منها، ولا تُستخدم الأعداد العائمة أبدًا.",
    ],
    "Verify, don't trust the browser": ["Verify, don't trust the browser", "تحقَّق ولا تثق بالمتصفح"],
    "Confirm with GET /links/:key or /payments/:reference before you ship the order.": [
        "Confirm with GET /links/:key or /payments/:reference before you ship the order.",
        "تأكّد عبر \u2066GET /links/:key\u2069 أو \u2066/payments/:reference\u2069 قبل تسليم الطلب.",
    ],
    "Read the developer guide": ["Read the developer guide", "اقرأ دليل المطوّرين"],
    "Sign-in required": ["Sign-in required", "يتطلب تسجيل الدخول"],
    "Code language": ["Code language", "لغة الشيفرة"],
    "Create a payment link request": ["Create a payment link request", "طلب إنشاء رابط دفع"],
    "Example response": ["Example response", "مثال على الاستجابة"],

    // Security
    "Security & compliance": ["Security & compliance", "الأمان والامتثال"],
    "Controls a central-bank auditor expects": ["Controls a central-bank auditor expects", "ضوابط يتوقعها مدقق المصرف المركزي"],
    "Designed around four-eyes governance, KYB/AML and an immutable ledger.": [
        "Designed around four-eyes governance, KYB/AML and an immutable ledger.",
        "مبنية على حوكمة العينين الأربع، والتحقق التجاري ومكافحة غسل الأموال، ودفتر أستاذ غير قابل للتعديل.",
    ],
    "Maker-checker on sensitive changes": ["Maker-checker on sensitive changes", "منشئ ومراجع للتغييرات الحساسة"],
    "Wallet assignment, rail whitelists and redirect allowlists wait for a second person. The server enforces maker ≠ checker.": [
        "Wallet assignment, rail whitelists and redirect allowlists wait for a second person. The server enforces maker ≠ checker.",
        "ربط المحفظة وقوائم القنوات المسموح بها ونطاقات إعادة التوجيه تنتظر اعتماد شخص ثانٍ، ويفرض الخادم أن يختلف المنشئ عن المراجع.",
    ],
    "KYB and AML before live money": ["KYB and AML before live money", "تحقق تجاري ومكافحة غسل الأموال قبل التحصيل الفعلي"],
    "Business profile, beneficial owners, documents and payout account are reviewed before activation.": [
        "Business profile, beneficial owners, documents and payout account are reviewed before activation.",
        "تُراجَع بيانات النشاط والمستفيدين الحقيقيين والمستندات وحساب الصرف قبل التفعيل.",
    ],
    "Mutual TLS between services": ["Mutual TLS between services", "تشفير TLS متبادل بين الخدمات"],
    "The merchant edge and the core service talk over mutual TLS 1.3 with channel-bound certificates.": [
        "The merchant edge and the core service talk over mutual TLS 1.3 with channel-bound certificates.",
        "تتواصل واجهة التاجر الطرفية مع الخدمة الأساسية عبر TLS 1.3 متبادل بشهادات مرتبطة بكل قناة.",
    ],
    "Encrypted, write-only secrets": ["Encrypted, write-only secrets", "أسرار مشفّرة للكتابة فقط"],
    "Gateway credentials are encrypted with AES-256-GCM and can never be read back from the portal.": [
        "Gateway credentials are encrypted with AES-256-GCM and can never be read back from the portal.",
        "تُشفَّر بيانات اعتماد البوابات بخوارزمية AES-256-GCM ولا يمكن قراءتها مجددًا من البوابة.",
    ],
    "Append-only ledger": ["Append-only ledger", "دفتر أستاذ للإضافة فقط"],
    "Balances are never edited. Corrections are new, approved journal entries with an audit trail.": [
        "Balances are never edited. Corrections are new, approved journal entries with an audit trail.",
        "لا تُعدَّل الأرصدة أبدًا، فالتصحيحات قيود جديدة معتمدة ولها سجل تدقيق.",
    ],
    "Least-privilege teams": ["Least-privilege teams", "فرق بأقل صلاحيات لازمة"],
    "Owners, accountants, cashiers and developers each get only the authorities they need.": [
        "Owners, accountants, cashiers and developers each get only the authorities they need.",
        "يحصل كل من المالكين والمحاسبين والكاشيرية والمطورين على الصلاحيات التي يحتاجونها فقط.",
    ],

    // Onboarding
    "From sign-up to your first payment": ["From sign-up to your first payment", "من التسجيل إلى أول عملية دفع"],
    "The same steps you will see in the portal's onboarding page.": [
        "The same steps you will see in the portal's onboarding page.",
        "هي الخطوات نفسها التي ستراها في صفحة التهيئة داخل البوابة.",
    ],
    "Create your account": ["Create your account", "أنشئ حسابك"],
    "Register with your name, phone number and email.": ["Register with your name, phone number and email.", "سجّل باسمك ورقم هاتفك وبريدك الإلكتروني."],
    "Business profile": ["Business profile", "بيانات النشاط التجاري"],
    "Legal name, registration, tax ID, category and expected volume.": [
        "Legal name, registration, tax ID, category and expected volume.",
        "الاسم القانوني والسجل التجاري والرقم الضريبي والفئة وحجم التعاملات المتوقع.",
    ],
    "Owners & documents": ["Owners & documents", "المالكون والمستندات"],
    "Beneficial owners and the KYB documents that prove them.": [
        "Beneficial owners and the KYB documents that prove them.",
        "المستفيدون الحقيقيون ومستندات التحقق التجاري التي تثبت ذلك.",
    ],
    "Payout account": ["Payout account", "حساب الصرف"],
    "The corporate bank account your cash-outs go to.": ["The corporate bank account your cash-outs go to.", "الحساب المصرفي للشركة الذي تُحوَّل إليه السحوبات."],
    "Compliance review": ["Compliance review", "مراجعة الامتثال"],
    "The platform team reviews KYB and screening, and may ask for more information.": [
        "The platform team reviews KYB and screening, and may ask for more information.",
        "يراجع فريق المنصة التحقق التجاري ونتائج الفحص، وقد يطلب معلومات إضافية.",
    ],
    "Go live": ["Go live", "ابدأ التحصيل الفعلي"],
    "Create a wallet and application, then share links, pair a POS screen or call the API.": [
        "Create a wallet and application, then share links, pair a POS screen or call the API.",
        "أنشئ محفظة وتطبيقًا، ثم شارك الروابط أو اربط شاشة نقطة بيع أو استدعِ الواجهة البرمجية.",
    ],

    // FAQ
    "FAQ": ["FAQ", "الأسئلة الشائعة"],
    "Straight answers": ["Straight answers", "إجابات مباشرة"],
    "How is my commission set?": ["How is my commission set?", "كيف تُحدَّد عمولتي؟"],
    "Commission profiles are configured by the platform per merchant, application and rail. You choose per link whether you absorb the fee, the payer pays it, or you split it, and the checkout shows the payer the exact total.": [
        "Commission profiles are configured by the platform per merchant, application and rail. You choose per link whether you absorb the fee, the payer pays it, or you split it, and the checkout shows the payer the exact total.",
        "تضبط المنصة ملفات العمولة لكل تاجر وتطبيق وقناة دفع. وتختار أنت في كل رابط أن تتحمّل الرسوم أو يدفعها العميل أو تُقسَم بينكما، وتعرض صفحة الدفع للعميل المبلغ الإجمالي بدقة.",
    ],
    "Can I use my own gateway accounts?": ["Can I use my own gateway accounts?", "هل يمكنني استخدام حساباتي الخاصة لدى البوابات؟"],
    "Yes. In merchant-direct mode you register your own gateway credentials; money settles to your account and the platform records only its commission.": [
        "Yes. In merchant-direct mode you register your own gateway credentials; money settles to your account and the platform records only its commission.",
        "نعم. في وضع التسوية المباشرة للتاجر تسجّل بيانات اعتماد بوابتك الخاصة، فتصل الأموال إلى حسابك مباشرة ولا تسجّل المنصة إلا عمولتها.",
    ],
    "When is a payment safe to fulfil?": ["When is a payment safe to fulfil?", "متى يصبح تسليم الطلب آمنًا؟"],
    "When its status is SUCCEEDED. Pending, verifying or unknown attempts are not paid yet, and a browser return alone never proves payment.": [
        "When its status is SUCCEEDED. Pending, verifying or unknown attempts are not paid yet, and a browser return alone never proves payment.",
        "عندما تكون حالة العملية SUCCEEDED (ناجحة). العمليات المعلّقة أو قيد التحقق أو غير المعروفة لم تُدفع بعد، وعودة المتصفح وحدها لا تثبت الدفع أبدًا.",
    ],
    "What do my customers see?": ["What do my customers see?", "ماذا يرى عملائي؟"],
    "A focused hosted checkout in Arabic or English showing your name, the server-set amount, any service fee, and only the payment methods you enabled.": [
        "A focused hosted checkout in Arabic or English showing your name, the server-set amount, any service fee, and only the payment methods you enabled.",
        "صفحة دفع مستضافة مركّزة بالعربية أو الإنجليزية تعرض اسمك والمبلغ المحدد من الخادم وأي رسوم خدمة، وطرق الدفع التي فعّلتها فقط.",
    ],
    "Can I test before going live?": ["Can I test before going live?", "هل يمكنني التجربة قبل التشغيل الفعلي؟"],
    "You can sign up and prepare onboarding straight away. Live collection starts after KYB approval; ask the platform team about test credentials for your integration.": [
        "You can sign up and prepare onboarding straight away. Live collection starts after KYB approval; ask the platform team about test credentials for your integration.",
        "يمكنك التسجيل وتجهيز بيانات التهيئة فورًا. يبدأ التحصيل الفعلي بعد اعتماد التحقق التجاري، ويمكنك سؤال فريق المنصة عن بيانات اعتماد تجريبية لتكاملك.",
    ],

    // Ticker
    "Capabilities": ["Capabilities", "القدرات"],
    "Pause ticker": ["Pause ticker", "إيقاف الشريط مؤقتًا"],
    "Play ticker": ["Play ticker", "تشغيل الشريط"],

    // Final CTA
    "Start collecting with confidence.": ["Start collecting with confidence.", "ابدأ التحصيل بثقة."],
    "Create your account now and finish onboarding at your own pace.": [
        "Create your account now and finish onboarding at your own pace.",
        "أنشئ حسابك الآن وأكمل التهيئة بالوتيرة التي تناسبك.",
    ],
};
