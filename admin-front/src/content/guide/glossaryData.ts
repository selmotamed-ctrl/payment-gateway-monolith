import type {
    CollectionModeDefinition,
    ConfirmationChannelDefinition,
    EdgeCaseDefinition,
    GlossaryEntry,
    GlossaryTerm,
    RunbookDefinition,
} from "./types";

export const GLOSSARY_TERMS: GlossaryTerm[] = [
    {
        "term": "Payment Gateway (Our Platform)",
        "category": "Basics",
        "definitionEn": "A secure software bridge that sits between a business (Merchant) that wants to get paid and the banks or mobile wallets where customers keep their money. Instead of a store having to sign 20 separate technical contracts with 20 banks, they connect to us once, and we handle all 20 payment methods for them.",
        "definitionAr": "جسر برمجي آمن يقف بين التاجر الذي يريد تحصيل أمواله والبنوك أو المحافظ التي يحتفظ فيها العملاء بأموالهم. بدلاً من أن توقّع المتاجر عشرين عقداً تقنياً مع عشرين بنكاً، تتصل بنا مرة واحدة ونتولى نحن كل طرق الدفع العشرين.",
        "analogyEn": "Think of us as an international airport terminal: passengers (customers) arrive once, and we route them onto 20 different airlines (banks and wallets) safely.",
        "analogyAr": "تخيّل أننا صالة مطار دولية: يصل المسافرون (العملاء) مرة واحدة، ونوزّعهم على عشرين شركة طيران (البنوك والمحافظ) بأمان.",
        "fatalErrorEn": "Never confuse **our platform** with the **upstream bank/switch**. We orchestrate the payment and keep the ledger, while the bank/wallet holds the customer's actual account.",
        "fatalErrorAr": "لا تخلط أبداً بين منصتنا والبنك أو المقسم الأعلى. نحن ننسّق الدفع ونحتفظ بالدفتر، بينما يحتفظ البنك أو المحفظة بحساب العميل الفعلي.",
        "tags": [
            "payment",
            "gateway",
            "platform",
            "basics",
            "secure",
            "software",
            "bridge",
            "sits",
            "between",
            "business",
            "merchant",
            "wants",
            "get",
            "paid"
        ]
    },
    {
        "term": "Merchant",
        "category": "Basics",
        "definitionEn": "Any business, store, clinic, university, or company that registers on our platform to collect money from its customers (using Payment Links, a website API, or an in-store POS machine).",
        "definitionAr": "أي نشاط تجاري أو متجر أو عيادة أو جامعة أو شركة تسجّل على منصتنا لتحصيل الأموال من عملائها عبر روابط الدفع أو واجهة الموقع أو جهاز نقاط البيع.",
        "analogyEn": "A shop owner renting a stall in our digital mall.",
        "analogyAr": "صاحب متجر يستأجر كشكاً في مولنا الرقمي.",
        "fatalErrorEn": "Never activate a `PENDING` merchant for live payments before their identity documents (KYB) and compliance checks (AML) are 100% verified.",
        "fatalErrorAr": "لا تفعّل تاجراً بحالة PENDING للمدفوعات الحقيقية قبل التحقق الكامل من وثائق هويته (KYB) وفحوص الامتثال (AML).",
        "tags": [
            "merchant",
            "basics",
            "any",
            "business",
            "store",
            "clinic",
            "university",
            "company",
            "registers",
            "platform",
            "collect",
            "money",
            "customers",
            "payment"
        ]
    },
    {
        "term": "Payer (End-Client)",
        "category": "Basics",
        "definitionEn": "The everyday customer who clicks a Merchant's Payment Link or stands at a store counter to pay for goods or services. Payers do not create accounts on our portal; they simply open the checkout link and pay.",
        "definitionAr": "العميل العادي الذي يفتح رابط دفع التاجر أو يقف عند الكاشير ليدفع ثمن سلعة أو خدمة. لا ينشئ الدافعون حسابات على بوابتنا، بل يفتحون رابط الدفع ويدفعون فقط.",
        "analogyEn": "A shopper standing at the cashier counter with their card or phone wallet.",
        "analogyAr": "متسوق واقف عند الكاشير ببطاقته أو محفظة هاتفه.",
        "fatalErrorEn": "Never ask a Payer for their card PIN or SMS OTP over phone/WhatsApp support. Support agents never need an OTP to check a payment!",
        "fatalErrorAr": "لا تطلب من الدافع أبداً رقمه السري للبطاقة أو رمز OTP عبر الهاتف أو واتساب. موظفو الدعم لا يحتاجون أي رمز OTP لفحص الدفع!",
        "tags": [
            "payer",
            "end-client",
            "basics",
            "everyday",
            "customer",
            "who",
            "clicks",
            "merchant",
            "payment",
            "link",
            "stands",
            "store",
            "counter",
            "pay"
        ]
    },
    {
        "term": "Rail (Payment Method)",
        "category": "Catalog",
        "definitionEn": "What the customer actually sees and clicks on the checkout page to pay—for example, **Edfali**, **Sadad**, **Moamalat Card**, **LYPay QR**, **MobiCash**, or **NeomPay**. A Rail owns the logo, the Arabic/English name, and the input fields the customer fills out (such as their phone number).",
        "definitionAr": "ما يراه العميل فعلياً على صفحة الدفع وينقر عليه للدفع، مثل إدفع لي أو سداد أو بطاقة معاملات أو LYPay QR أو MobiCash أو NeomPay. تملك السكة الشعار والاسم العربي والإنجليزي وحقول الإدخال التي يملؤها العميل مثل رقم الهاتف.",
        "analogyEn": "The menu item a customer orders at a restaurant (\"I want to pay with Sadad\").",
        "analogyAr": "عنصر القائمة الذي يطلبه العميل في مطعم: أريد الدفع بسداد.",
        "fatalErrorEn": "Never delete a Rail that has historical payments. If a Rail must be turned off, set `blocked = true` (Active -> Blocked) so historical records stay intact.",
        "fatalErrorAr": "لا تحذف سكة لها مدفوعات سابقة. إذا وجب إيقاف سكة فاجعل blocked = true (نشطة -> محجوبة) حتى تبقى السجلات التاريخية سليمة.",
        "tags": [
            "rail",
            "payment",
            "method",
            "catalog",
            "customer",
            "actually",
            "sees",
            "clicks",
            "checkout",
            "page",
            "pay—for",
            "example",
            "edfali",
            "sadad"
        ]
    },
    {
        "term": "Gateway (Upstream Provider)",
        "category": "Catalog",
        "definitionEn": "The external company, bank switch, or aggregator whose server our system talks to behind the scenes to process a Rail. Some Gateways provide just one Rail (e.g., Edfali Direct from BCD Bank), while **Aggregator Gateways** (like DPay, Plutu, or MyPay) provide access to many Rails through one technical connection.",
        "definitionAr": "الشركة أو مقسم البنك أو المجمّع الخارجي الذي يتصل به خادمنا خلف الكواليس لمعالجة السكة. بعض البوابات توفر سكة واحدة فقط مثل إدفالي المباشر من بنك التنمية، بينما توفر البوابات المجمّعة مثل DPay وPlutu وMyPay الوصول إلى سكك كثيرة عبر اتصال تقني واحد.",
        "analogyEn": "The kitchen supplier that delivers the ingredients for the menu item. You can buy Edfali directly from the farm (BCD Bank) or through a wholesale distributor (Plutu or DPay).",
        "analogyAr": "مورد المطبخ الذي يسلّم مكونات عنصر القائمة. يمكنك شراء إدفالي مباشرة من المزرعة (بنك التنمية) أو عبر موزّع جملة (Plutu أو DPay).",
        "fatalErrorEn": "Never assume \"Rail\" and \"Gateway\" are 1-to-1. One Rail (like `edfali`) can be connected to three different Gateways (`edfali-direct`, `plutu`, `dpay`) for automatic backup!",
        "fatalErrorAr": "لا تفترض أن السكة والبوابة علاقة واحد لواحد. السكة الواحدة مثل edfali يمكن ربطها بثلاث بوابات مختلفة (edfali-direct وplutu وdpay) لنسخ احتياطي تلقائي!",
        "tags": [
            "gateway",
            "upstream",
            "provider",
            "catalog",
            "external",
            "company",
            "bank",
            "switch",
            "aggregator",
            "whose",
            "server",
            "system",
            "talks",
            "behind"
        ]
    },
    {
        "term": "Credential Set",
        "category": "Catalog",
        "definitionEn": "The secret keys, usernames, passwords, Merchant IDs (`MID`), and Terminal IDs (`TID`) used to log into a Gateway. A Credential Set belongs either to **our Platform (`PLATFORM`)** or to **a specific Merchant (`MERCHANT`)**, and is strictly separated between testing (`SANDBOX`) and real money (`LIVE`).",
        "definitionAr": "المفاتيح السرية وأسماء المستخدمين وكلمات المرور ومعرّفات التاجر MID ومعرّفات الطرفية TID المستخدمة للدخول إلى بوابة. تنتمي مجموعة الاعتماد إما إلى منصتنا PLATFORM أو إلى تاجر محدد MERCHANT، وتُفصل بصرامة بين الاختبار SANDBOX والمال الحقيقي LIVE.",
        "analogyEn": "The keycard and PIN code used to unlock a specific bank vault door.",
        "analogyAr": "بطاقة الدخول ورمز PIN لفتح باب خزانة بنكية محددة.",
        "fatalErrorEn": "Never paste `LIVE` credentials into a `SANDBOX` environment, and never paste real secrets into an external AI chat. Once saved, secrets are write-only and encrypted.",
        "fatalErrorAr": "لا تلصق اعتمادات LIVE في بيئة SANDBOX، ولا تلصق أسراراً حقيقية في محادثة ذكاء اصطناعي خارجية. بعد الحفظ تصبح الأسرار للكتابة فقط ومشفرة.",
        "tags": [
            "credential",
            "set",
            "catalog",
            "secret",
            "keys",
            "usernames",
            "passwords",
            "merchant",
            "ids",
            "mid",
            "terminal",
            "tid",
            "log",
            "gateway"
        ]
    },
    {
        "term": "Route (RailRoute)",
        "category": "Catalog",
        "definitionEn": "The bridge that connects one **Rail** (e.g., Edfali) to one **Gateway** (e.g., Plutu) using one **Credential Set**, along with its cost, minimum/maximum LYD limits, daily cap, priority, and health status. If a Rail has two Routes and the primary Route goes down, our system automatically switches new payments to the backup Route.",
        "definitionAr": "الجسر الذي يربط سكة مثل إدفالي ببوابة مثل Plutu باستخدام مجموعة اعتماد، مع تكلفته وحدود LYD الدنيا والعليا والسقف اليومي والأولوية وحالة الصحة. إذا كانت للسكة مساران وتعطل المسار الأساسي، يحوّل نظامنا المدفوعات الجديدة تلقائياً إلى المسار الاحتياطي.",
        "analogyEn": "A specific highway between Tripoli and Misrata. If the coastal highway (Route 1) is closed for repairs, cars automatically take the southern highway (Route 2).",
        "analogyAr": "طريق سريع محدد بين طرابلس ومصراتة. إذا أُغلق الطريق الساحلي (المسار 1) للإصلاحات، تأخذ السيارات تلقائياً الطريق الجنوبي (المسار 2).",
        "fatalErrorEn": "Before retiring an active Route, always set it to **`DRAINING`** first (not `PAUSED` immediately) so customers who are currently typing their OTP can finish their payment without failing!",
        "fatalErrorAr": "قبل إيقاف مسار نشط، اجعله أولاً DRAINING وليس PAUSED فوراً، حتى يتمكن العملاء الذين يكتبون رمز OTP الآن من إكمال دفعهم دون فشل!",
        "tags": [
            "route",
            "railroute",
            "catalog",
            "bridge",
            "connects",
            "one",
            "rail",
            "edfali",
            "gateway",
            "plutu",
            "credential",
            "set",
            "along",
            "cost"
        ]
    },
    {
        "term": "Payment Link",
        "category": "Checkout",
        "definitionEn": "A unique web page (`https://pay.domain.ly/pay/<linkKey>`) created by a Merchant for a specific LYD amount (e.g., `150.000 LYD`). It can be **Single-Use** (`use_count = 1`, for one specific invoice) or **Multi-Use** (for a donation page or fixed-price product).",
        "definitionAr": "صفحة ويب فريدة ينشئها التاجر بمبلغ LYD محدد مثل 150.000 LYD. يمكن أن تكون أحادية الاستخدام (use_count = 1) لفاتورة محددة أو متعددة الاستخدام لصفحة تبرعات أو منتج بسعر ثابت.",
        "analogyEn": "A digital price tag and invoice that the customer opens on their phone to pay.",
        "analogyAr": "بطاقة سعر وفاتورة رقمية يفتحها العميل على هاتفه للدفع.",
        "fatalErrorEn": "Remember that the checkout browser **cannot** change the link's amount. The server always reads the price from the database record of the Payment Link.",
        "fatalErrorAr": "تذكّر أن متصفح الدفع لا يستطيع تغيير مبلغ الرابط. يقرأ الخادم السعر دائماً من سجل رابط الدفع في قاعدة البيانات.",
        "tags": [
            "payment",
            "link",
            "checkout",
            "unique",
            "web",
            "page",
            "https",
            "pay",
            "domain",
            "<linkkey",
            "created",
            "merchant",
            "specific",
            "lyd"
        ]
    },
    {
        "term": "Payment Attempt",
        "category": "Runtime",
        "definitionEn": "Every single try a customer makes to pay a Payment Link. If a customer opens a link, tries Sadad, cancels, and then pays with Moamalat Card, there is **1 Payment Link** and **2 Payment Attempts** grouped together in an **Attempt Group**.",
        "definitionAr": "كل محاولة يقوم بها العميل لدفع رابط الدفع. إذا فتح العميل رابطاً وجرّب سداد ثم ألغى ثم دفع ببطاقة معاملات، فهناك رابط دفع واحد ومحاولتا دفع اثنتان مجمّعتان في مجموعة محاولات.",
        "analogyEn": "Trying to swipe a card at a terminal. The first swipe might fail (Attempt 1), and the second swipe succeeds (Attempt 2), paying the single bill.",
        "analogyAr": "محاولة تمرير البطاقة عند طرفية. قد تفشل التمريرة الأولى (المحاولة 1) وتنجح الثانية (المحاولة 2) لدفع الفاتورة الواحدة.",
        "fatalErrorEn": "At most **one** Payment Attempt in an Attempt Group is allowed to succeed for a single-use link.",
        "fatalErrorAr": "يُسمح لمحاولة دفع واحدة فقط على الأكثر بالنجاح في مجموعة المحاولات لرابط أحادي الاستخدام.",
        "tags": [
            "payment",
            "attempt",
            "runtime",
            "single",
            "try",
            "customer",
            "makes",
            "pay",
            "link",
            "opens",
            "tries",
            "sadad",
            "cancels",
            "pays"
        ]
    },
    {
        "term": "Slot Reservation (active_locked_count)",
        "category": "Runtime",
        "definitionEn": "When a customer starts paying a Single-Use link, our system immediately \"locks\" the link's slot so that if the customer opens a second browser tab (or a second person opens the same link), the second tab is blocked with *\"Payment in progress\"* instead of charging the bill twice.",
        "definitionAr": "عندما يبدأ العميل دفع رابط أحادي الاستخدام، يقفل نظامنا خانة الرابط فوراً حتى إذا فتح العميل تبويباً ثانياً أو فتح شخص آخر الرابط نفسه، يُحجب التبويب الثاني برسالة الدفع قيد التنفيذ بدلاً من تحصيل الفاتورة مرتين.",
        "analogyEn": "Putting an \"Occupied\" lock on a fitting-room door while someone is inside. The lock only opens if they walk out empty-handed (`FAILED`/`CANCELLED`/`EXPIRED`).",
        "analogyAr": "وضع لافتة مشغول على باب غرفة القياس أثناء وجود شخص بداخلها. لا تُفتح اللافتة إلا إذا خرج فارغ اليدين (FAILED أو CANCELLED أو EXPIRED).",
        "fatalErrorEn": "If an attempt enters **`UNKNOWN`** state, the slot lock stays **LOCKED** on purpose! Never manually unlock or tell a customer to pay again while an attempt is `UNKNOWN`, or they may be charged twice.",
        "fatalErrorAr": "إذا دخلت محاولة حالة UNKNOWN يبقى قفل الخانة مقفلاً عمداً! لا تفتحه يدوياً ولا تخبر العميل بالدفع مجدداً أثناء حالة UNKNOWN وإلا قد يُحصّل مرتين.",
        "tags": [
            "slot",
            "reservation",
            "active",
            "locked",
            "count",
            "runtime",
            "customer",
            "starts",
            "paying",
            "single-use",
            "link",
            "system",
            "immediately",
            "locks"
        ]
    },
    {
        "term": "Collection Mode (Axis A)",
        "category": "Engine",
        "definitionEn": "**What the customer physically does** to authorize the payment. There are 9 modes: typing an SMS code (`OTP_PULL`), going to a bank webpage (`REDIRECT`), typing card details in a popup (`EMBEDDED`), approving a notification in their wallet app (`PUSH_APPROVAL`), scanning a barcode (`QR_DISPLAY`), texting a code (`PAY_CODE`), clicking an app button (`DEEP_LINK`), making a bank wire (`MANUAL`), or choosing among several (`HYBRID`).",
        "definitionAr": "ما يفعله العميل فعلياً لتخويل الدفع. هناك تسعة أنماط: كتابة رمز SMS (OTP_PULL)، والذهاب إلى صفحة بنك (REDIRECT)، وكتابة بيانات البطاقة في نافذة (EMBEDDED)، والموافقة على إشعار في تطبيق المحفظة (PUSH_APPROVAL)، ومسح باركود (QR_DISPLAY)، وإرسال رمز نصي (PAY_CODE)، والنقر على زر تطبيق (DEEP_LINK)، والتحويل البنكي (MANUAL)، أو الاختيار بين عدة أنماط (HYBRID).",
        "analogyEn": "How you hand over payment in real life: typing a PIN, scanning a barcode, or signing a slip.",
        "analogyAr": "كيف تسلّم الدفع في الحياة الواقعية: تكتب رمزاً أو تمسح باركود أو توقّع ورقة.",
        "fatalErrorEn": "Collection Mode only describes what the *customer* does—it is completely separate from how *our server* confirms the money arrived (Confirmation Channel).",
        "fatalErrorAr": "نمط التحصيل يصف فقط ما يفعله العميل، وهو منفصل تماماً عن كيفية تأكيد خادمنا وصول المال (قناة التأكيد).",
        "tags": [
            "collection",
            "mode",
            "axis",
            "engine",
            "customer",
            "physically",
            "does",
            "authorize",
            "payment",
            "there",
            "modes",
            "typing",
            "sms",
            "code"
        ]
    },
    {
        "term": "Confirmation Channel (Axis B)",
        "category": "Engine",
        "definitionEn": "**How our backend server learns the truth** about whether the payment succeeded. Channels include: the direct reply to our confirm call (`SYNC_RESPONSE`), a signed server-to-server notification from the bank (`WEBHOOK`), our server asking the bank's status API (`INQUIRY / POLL`), a daily bank spreadsheet (`STATEMENT`), or two admins verifying a receipt (`OPERATOR_CONFIRMATION`).",
        "definitionAr": "كيف يعرف خادمنا الخلفي الحقيقة بشأن نجاح الدفع. القنوات تشمل الرد المباشر على نداء التأكيد (SYNC_RESPONSE)، والإشعار الموقّع من الخادم إلى الخادم من البنك (WEBHOOK)، وسؤال خادمنا لواجهة حالة البنك (INQUIRY / POLL)، وجدول البنك اليومي (STATEMENT)، أو تحقق مسؤولين من إيصال (OPERATOR_CONFIRMATION).",
        "analogyEn": "Waiting for the bank's official stamped receipt, rather than just trusting a customer who says \"I promise I paid!\"",
        "analogyAr": "انتظار الإيصال الرسمي المختوم من البنك بدلاً من تصديق عميل يقول: أعدك أنني دفعت!",
        "fatalErrorEn": "**Golden Rule of Security:** `RETURN_URL` (the customer's browser coming back from a bank page) and `BROWSER_CALLBACK` (JavaScript in the browser saying \"Complete!\") have **ZERO trust**. They are only \"doorbells\" that tell our server to ask the bank directly.",
        "fatalErrorAr": "القاعدة الذهبية للأمان: RETURN_URL (عودة متصفح العميل من صفحة البنك) وBROWSER_CALLBACK (جافاسكربت المتصفح الذي يقول اكتمل!) بلا أي ثقة. هما مجرد جرس باب يخبر خادمنا أن يسأل البنك مباشرة.",
        "tags": [
            "confirmation",
            "channel",
            "axis",
            "engine",
            "backend",
            "server",
            "learns",
            "truth",
            "about",
            "whether",
            "payment",
            "succeeded",
            "channels",
            "include"
        ]
    },
    {
        "term": "Point of No Return (point_of_no_return)",
        "category": "Engine",
        "definitionEn": "The exact step in a payment flow where money may actually be taken from the customer's account (for example, submitting the SMS OTP to the bank). Before this point, if a gateway fails, we can safely switch to another route. After this point, we are strictly bound to this gateway.",
        "definitionAr": "الخطوة الدقيقة في تدفق الدفع التي قد يُسحب فيها المال فعلاً من حساب العميل، مثل إرسال رمز OTP إلى البنك. قبل هذه النقطة، إذا فشلت بوابة يمكننا التحويل بأمان إلى مسار آخر. بعدها نكون مرتبطين بهذه البوابة حصراً.",
        "analogyEn": "The moment an airplane passes takeoff decision speed (`V1`). Before `V1`, you can abort on the runway; after `V1`, you cannot slam the brakes.",
        "analogyAr": "اللحظة التي تتجاوز فيها الطائرة سرعة قرار الإقلاع V1. قبل V1 يمكنك الإلغاء على المدرج، وبعد V1 لا يمكنك الضغط على الفرامل.",
        "fatalErrorEn": "Never configure a `MOVES_MONEY` step with automatic retries (`retry_policy` must be `NEVER`, unless the gateway proves cryptographic idempotency). Retrying a timed-out money call can charge the customer twice!",
        "fatalErrorAr": "لا تضبط خطوة MOVES_MONEY على إعادة المحاولة التلقائية (يجب أن تكون retry_policy = NEVER) إلا إذا أثبتت البوابة منع التكرار تشفيرياً. إعادة محاولة نداء مالي انتهت مهلته قد تحصّل العميل مرتين!",
        "tags": [
            "point",
            "return",
            "engine",
            "exact",
            "step",
            "payment",
            "flow",
            "where",
            "money",
            "may",
            "actually",
            "taken",
            "customer",
            "account"
        ]
    },
    {
        "term": "UNKNOWN Status",
        "category": "Operations",
        "definitionEn": "The safety state a Payment Attempt enters when our server sent a money-moving request (like confirming an OTP), and the bank's server timed out, disconnected, or returned a 500 error. We **do not know yet** whether the bank took the customer's money or not.",
        "definitionAr": "حالة الأمان التي تدخلها محاولة الدفع عندما يرسل خادمنا طلباً ينقل المال مثل تأكيد OTP، فينتهي وقت خادم البنك أو ينقطع الاتصال أو يعيد خطأ 500. لا نعرف بعد هل أخذ البنك مال العميل أم لا.",
        "analogyEn": "Calling someone to wire money and the phone line cuts out right as they say \"Okay, I clicked—\". You must check your bank statement or call them back before sending the money again!",
        "analogyAr": "الاتصال بشخص لتحويل مال وينقطع الخط بينما يقول حسناً لقد نقرت. يجب فحص كشف حسابك أو معاودة الاتصال قبل إرسال المال مرة أخرى!",
        "fatalErrorEn": "**NEVER** mark an `UNKNOWN` attempt as `FAILED` without checking with the gateway first (via the **Inquire** button or the next day's **Statement Reconciliation**). Marking a settled `UNKNOWN` payment as `FAILED` releases the link slot and causes double charges or lost money.",
        "fatalErrorAr": "لا تحوّل أبداً محاولة UNKNOWN إلى FAILED دون التحقق مع البوابة أولاً عبر زر الاستعلام أو مطابقة كشف الغد. تحويل دفعة UNKNOWN مسوّاة إلى FAILED يحرر خانة الرابط ويسبب تحصيلاً مزدوجاً أو خسارة مال.",
        "tags": [
            "unknown",
            "status",
            "operations",
            "safety",
            "state",
            "payment",
            "attempt",
            "enters",
            "server",
            "sent",
            "money-moving",
            "request",
            "like",
            "confirming"
        ]
    },
    {
        "term": "Double-Entry Ledger",
        "category": "Finance",
        "definitionEn": "Our accounting book inside the database (`gl_accounts`, `journal_entries`, `journal_lines`). Every time money moves, we never just \"edit a number\" in a wallet. Instead, we write an unchangeable Journal Entry where total **Debits (`DEBIT`)** equal total **Credits (`CREDIT`)** to four decimal places (`0.0000 LYD`).",
        "definitionAr": "دفتر المحاسبة داخل قاعدة البيانات (gl_accounts وjournal_entries وjournal_lines). كل مرة يتحرك فيها المال لا نعدّل رقماً في محفظة، بل نكتب قيداً محاسبيًا غير قابل للتغيير يتساوى فيه إجمالي المدين DEBIT وإجمالي الدائن CREDIT حتى أربع خانات عشرية (0.0000 LYD).",
        "analogyEn": "A physics conservation law for money: money cannot appear out of thin air or vanish into thin air; every dinar credited to a Merchant Wallet must come from a specific Clearing or Treasury account.",
        "analogyAr": "قانون حفظ المال في الفيزياء: لا يظهر المال من الهواء ولا يختفي؛ كل دينار يُضاف إلى محفظة تاجر يجب أن يأتي من حساب مقاصة أو خزينة محدد.",
        "fatalErrorEn": "If the **Ledger Invariant Check** ever shows a drift other than `0.0000 LYD`, all automated merchant cash-outs halt immediately (`Runbook RB-04`) until Finance resolves the discrepancy.",
        "fatalErrorAr": "إذا أظهر فحص ثبات الدفتر انحرافاً غير 0.0000 LYD، تتوقف كل عمليات السحب الآلية للتجار فوراً (Runbook RB-04) حتى تحل المالية الفرق.",
        "tags": [
            "double-entry",
            "ledger",
            "finance",
            "accounting",
            "book",
            "inside",
            "database",
            "accounts",
            "journal",
            "entries",
            "lines",
            "time",
            "money",
            "moves"
        ]
    },
    {
        "term": "GATEWAY_CLEARING vs. TREASURY",
        "category": "Finance",
        "definitionEn": "When a customer pays `100 LYD` through an external gateway (like Moamalat or Sadad), the cash is not physically in our company bank account yet—the gateway owes it to us and will wire it in 1 to 3 days (`T+N`). So at the moment of payment, we debit **`GATEWAY_CLEARING`** (money the gateway owes us). Days later, when the bank statement confirms the wire arrived, we move it from `GATEWAY_CLEARING` into **`TREASURY`** (actual cash in our bank).",
        "definitionAr": "عندما يدفع العميل 100 LYD عبر بوابة خارجية مثل معاملات أو سداد، لا يكون النقد في حساب شركتنا البنكي بعد؛ البوابة مدينة لنا وستحوّله خلال 1 إلى 3 أيام (T+N). لذا عند الدفع نقيّد GATEWAY_CLEARING مديناً (مال تدين به البوابة لنا). وبعد أيام عندما يؤكد كشف البنك وصول التحويل، ننقله من GATEWAY_CLEARING إلى TREASURY (نقد فعلي في بنكنا).",
        "analogyEn": "`GATEWAY_CLEARING` is an official IOU slip from the delivery courier; `TREASURY` is the actual cash locked inside your company safe once the courier hands it over.",
        "analogyAr": "GATEWAY_CLEARING هو إيصال IOU رسمي من شركة التوصيل، وTREASURY هو النقد الفعلي المقفل في خزانة الشركة بعد أن يسلّمه المندوب.",
        "fatalErrorEn": "Never confuse `GATEWAY_CLEARING` with available cash for payouts. Check the **Liquidity & Clearing Ageing** dashboard to ensure `TREASURY` has enough settled cash before processing large merchant cash-outs.",
        "fatalErrorAr": "لا تخلط أبداً بين GATEWAY_CLEARING والنقد المتاح للمدفوعات. راقب لوحة السيولة وعمر المقاصة للتأكد من كفاية TREASURY قبل معالجة سحوبات كبيرة.",
        "tags": [
            "gateway",
            "clearing",
            "treasury",
            "finance",
            "customer",
            "pays",
            "100",
            "lyd",
            "through",
            "external",
            "like",
            "moamalat",
            "sadad",
            "cash"
        ]
    },
    {
        "term": "Fee Bearer (MERCHANT_ABSORBS, PAYER_SURCHARGE, SPLIT)",
        "category": "Finance",
        "definitionEn": "Determines who pays our platform commission on a Payment Link. For a `100 LYD` link with `3%` (`3 LYD`) commission:\n• `MERCHANT_ABSORBS`: Customer pays `100 LYD`, Merchant gets `97 LYD`.\n• `PAYER_SURCHARGE`: Customer pays `103 LYD`, Merchant gets `100 LYD`.\n• `SPLIT` (e.g., 50/50): Customer pays `101.50 LYD`, Merchant gets `98.50 LYD`.",
        "definitionAr": "يحدد من يدفع عمولة منصتنا على رابط الدفع. لرابط 100 LYD بعمولة 3% أي 3 LYD: MERCHANT_ABSORBS يدفع العميل 100 LYD ويستلم التاجر 97 LYD. PAYER_SURCHARGE يدفع العميل 103 LYD ويستلم التاجر 100 LYD. SPLIT بنسبة 50/50 يدفع العميل 101.50 LYD ويستلم التاجر 98.50 LYD.",
        "analogyEn": "Whether a store includes delivery in the item price, charges the customer extra for delivery, or splits the delivery fee 50/50.",
        "analogyAr": "هل يضم المتجر التوصيل إلى سعر السلعة أم يحمّل العميل رسماً إضافياً أم يقسم رسم التوصيل مناصفة.",
        "fatalErrorEn": "When reviewing a refund or dispute, check the attempt's `fee_bearer` and `reverse_commission` policy so you understand why the customer's total charged amount may include a surcharge.",
        "fatalErrorAr": "عند مراجعة استرداد أو نزاع، افحص fee_bearer وسياسة reverse_commission للمحاولة لتفهم لماذا قد يتضمن المبلغ المحصّل من العميل رسماً إضافياً.",
        "tags": [
            "fee",
            "bearer",
            "merchant",
            "absorbs",
            "payer",
            "surcharge",
            "split",
            "finance",
            "determines",
            "who",
            "pays",
            "platform",
            "commission",
            "payment"
        ]
    },
    {
        "term": "Settlement Target (PLATFORM_CLEARING vs. MERCHANT_DIRECT)",
        "category": "Finance",
        "definitionEn": "• `PLATFORM_CLEARING`: The payment lands in *our* gateway account, we credit the Merchant's Wallet, and we pay the Merchant later via Cash-Out.\n• `MERCHANT_DIRECT`: The Merchant plugged in their *own* gateway credentials (e.g., their own DPay account), so the gateway sends the `100 LYD` directly to the Merchant's bank! Our ledger does **not** credit their wallet; instead, we book `3 LYD` into **`COMMISSION_RECEIVABLE`** (money the Merchant owes us for using our software).",
        "definitionAr": "PLATFORM_CLEARING: يصل الدفع إلى حساب بوابتنا، ونضيف المال إلى محفظة التاجر، ثم ندفع للتاجر لاحقاً عبر السحب. MERCHANT_DIRECT: أدخل التاجر بيانات بوابته الخاصة مثل حساب DPay الخاص به، فترسل البوابة 100 LYD مباشرة إلى بنك التاجر! لا يضيف دفترنا المال إلى محفظته، بل يقيّد 3 LYD في COMMISSION_RECEIVABLE أي مال يدين به التاجر لنا مقابل استخدام برمجيتنا.",
        "analogyEn": "`PLATFORM_CLEARING` is when Uber collects the fare on card and pays the driver weekly; `MERCHANT_DIRECT` is when the passenger pays the driver cash, so the driver now owes Uber its 3% service fee.",
        "analogyAr": "PLATFORM_CLEARING مثل أن تجمع أوبر الأجرة بالبطاقة وتدفع للسائق أسبوعياً؛ وMERCHANT_DIRECT مثل أن يدفع الراكب للسائق نقداً فيدين السائق لأوبر برسوم الخدمة 3%.",
        "fatalErrorEn": "For `MERCHANT_DIRECT` payments, our company **never holds the principal cash**. Therefore, you cannot refund a `MERCHANT_DIRECT` payment from our Treasury, and an AML alert on a `MERCHANT_DIRECT` payment creates an investigation case (`CASE_ONLY`) rather than an escrow hold.",
        "fatalErrorAr": "في مدفوعات MERCHANT_DIRECT لا تحتفظ شركتنا أبداً بالنقد الأصلي. لذلك لا يمكن استرداد دفعة MERCHANT_DIRECT من خزينتنا، وتنبيه AML على دفعة MERCHANT_DIRECT ينشئ حالة تحقيق CASE_ONLY بدلاً من حجز الضمان.",
        "tags": [
            "settlement",
            "target",
            "platform",
            "clearing",
            "merchant",
            "direct",
            "finance",
            "payment",
            "lands",
            "gateway",
            "account",
            "credit",
            "wallet",
            "pay"
        ]
    },
    {
        "term": "Maker-Checker (Four-Eyes Rule)",
        "category": "Governance",
        "definitionEn": "Our golden security rule: **no single employee can make a sensitive change or move money alone.** One authorized user (**the Maker**) proposes the action (creating a draft in `approval_requests`), and a **second, different authorized user (`checker_user_id != maker_user_id`)** must inspect the diff and click Approve before it executes.",
        "definitionAr": "قاعدتنا الأمنية الذهبية: لا يمكن لموظف واحد إجراء تغيير حساس أو تحريك مال بمفرده. يقترح مستخدم مخوّل الإجراء (المنشئ) بإنشاء مسودة في approval_requests، ويجب على مستخدم ثانٍ مختلف ومخوّل (المدقق) فحص الفرق والنقر على موافقة قبل التنفيذ.",
        "analogyEn": "A bank vault that requires two separate physical keys held by two different managers turned at the same time.",
        "analogyAr": "خزانة بنك تتطلب مفتاحين ماديين منفصلين يحملهما مديران مختلفان ويُداران في الوقت نفسه.",
        "fatalErrorEn": "Never share your admin login with a colleague to \"quickly approve\" your own Maker request. The database trigger, middleware, and audit log track every Maker and Checker, and sharing credentials is a critical security violation.",
        "fatalErrorAr": "لا تشارك تسجيل دخولك الإداري مع زميل ليوافق بسرعة على طلبك. تتبع قاعدة البيانات والوسيط وسجل التدقيق كل منشئ ومدقق، ومشاركة بيانات الدخول مخالفة أمنية خطيرة.",
        "tags": [
            "maker-checker",
            "four-eyes",
            "rule",
            "governance",
            "golden",
            "security",
            "single",
            "employee",
            "make",
            "sensitive",
            "change",
            "move",
            "money",
            "alone"
        ]
    },
    {
        "term": "KYB (Know Your Business) & Beneficial Owner",
        "category": "Compliance",
        "definitionEn": "**KYB** is the process of verifying a Merchant's legal documents (Commercial Registry, Tax Certificate, Articles of Association, Bank Letter) before activating their account. A **Beneficial Owner** is any real human being who ultimately owns **25% or more** of the company (or controls it as a director/signatory).",
        "definitionAr": "KYB هو التحقق من الوثائق القانونية للتاجر (السجل التجاري وشهادة الضريبة وعقد التأسيس وخطاب البنك) قبل تفعيل حسابه. المالك المستفيد هو أي شخص طبيعي يملك 25% أو أكثر من الشركة أو يسيطر عليها كمدير أو موقّع.",
        "analogyEn": "Checking both a company's business license and the passports of the actual people who own the company behind the scenes.",
        "analogyAr": "فحص رخصة نشاط الشركة وجوازات سفر الأشخاص الفعليين الذين يملكون الشركة خلف الكواليس.",
        "fatalErrorEn": "Watch out for **Duplicate Document Flags (`SHA-256` match)**: if Company B uploads the exact same PDF file hash that Company A uploaded last month, pause and investigate for shell-company fraud (Edge Case 120).",
        "fatalErrorAr": "انتبه لأعلام تكرار الوثائق (تطابق SHA-256): إذا رفع التاجر B نفس ملف PDF الذي رفعه التاجر A الشهر الماضي، توقف وحقّق في احتيال الشركات الوهمية (الحالة الطرفية 120).",
        "tags": [
            "kyb",
            "know",
            "business",
            "beneficial",
            "owner",
            "compliance",
            "process",
            "verifying",
            "merchant",
            "legal",
            "documents",
            "commercial",
            "registry",
            "tax"
        ]
    },
    {
        "term": "AML, Sanctions, PEP & \"No Tipping-Off\"",
        "category": "Compliance",
        "definitionEn": "• **AML (Anti-Money Laundering):** Rules and checks that stop criminals from washing illegal money through our gateway.\n• **Sanctions List:** Official international/CBL blacklists of banned individuals or entities.\n• **PEP (Politically Exposed Person):** A high-ranking government official, judge, military officer, or their close family/associates (requires higher scrutiny).\n• **No Tipping-Off:** The strict legal prohibition against telling a Merchant or Customer that they are under AML investigation or that a Suspicious Activity Report (`STR`) was filed.",
        "definitionAr": "مكافحة غسل الأموال AML: قواعد وفحوص تمنع المجرمين من غسل أموال غير قانونية عبر بوابتنا. قائمة العقوبات: قوائم الحظر الدولية أو الرسمية الصادرة عن مصرف ليبيا المركزي. الشخص السياسي PEP: مسؤول حكومي رفيع أو قاضٍ أو ضابط عسكري أو أفراد أسرته المقربون ويحتاج تدقيقاً أعلى. عدم الإفصاح: الحظر القانوني الصارم على إخبار التاجر أو العميل بأنه تحت تحقيق AML أو أن تقرير نشاط مشبوه STR قُدّم.",
        "analogyEn": "Airport customs security: if a passenger triggers a watchlist alert, officers politely ask them to wait for a \"routine check\"—they never announce \"You matched our criminal watchlist!\"",
        "analogyAr": "أمن الجمارك في المطار: إذا أثار مسافر تنبيه قائمة مراقبة، يطلب منه الضباط بأدب انتظار فحص روتيني ولا يقولون أبداً لقد طابقت قائمة المجرمين!",
        "fatalErrorEn": "**NEVER** mention AML, Sanctions, PEP, or Watchlists in an email, SMS, Info Request, or support chat to a merchant or payer. Always use the neutral `POLICY` reason code.",
        "fatalErrorAr": "لا تذكر أبداً AML أو العقوبات أو PEP أو قوائم المراقبة في بريد أو رسالة أو طلب معلومات أو محادثة دعم مع تاجر أو دافع. استخدم دائماً رمز السبب المحايد POLICY.",
        "tags": [
            "aml",
            "sanctions",
            "pep",
            "tipping-off",
            "compliance",
            "anti-money",
            "laundering",
            "rules",
            "checks",
            "stop",
            "criminals",
            "washing",
            "illegal",
            "money"
        ]
    },
    {"term": "KYB Document SHA-256 & DUPLICATE_DOCUMENT", "category": "Compliance", "definitionEn": "Every KYB file is fingerprinted with SHA-256. The same hash under two unrelated merchants raises **DUPLICATE_DOCUMENT**; it is not the same as a repeated file name and does not block automatically. Acceptance requires written justification and repeated reuse can open an AML case.", "definitionAr": "كل ملف KYB يحصل على بصمة SHA-256. ظهور نفس البصمة لدى تاجرين غير مرتبطين يطلق DUPLICATE_DOCUMENT، وهو ليس مجرد تكرار اسم الملف ولا يمنع القبول تلقائياً. يتطلب القبول تبريراً مكتوباً وقد يفتح التكرار المتعدد حالة AML.", "analogyEn": "Two different companies submitting the exact same passport photocopy: the names may differ, but the physical document is the same.", "analogyAr": "شركتان مختلفتان تقدمان نفس نسخة جواز السفر: قد تختلف الأسماء لكن الوثيقة المادية نفسها.", "fatalErrorEn": "NEVER accept a duplicate document without a written justification and NEVER ignore repeated reuse across merchants.", "fatalErrorAr": "لا تقبل وثيقة مكررة دون تبرير مكتوب ولا تتجاهل التكرار المتعدد بين التجار.", "tags": ["kyb", "sha256", "duplicate", "document", "compliance", "hash"]},
    {"term": "KYB Antivirus Status (AV)", "category": "Compliance", "definitionEn": "`av_status` is the malware gate of a KYB file: `PENDING` is quarantine, `CLEAN` allows secure preview and review, and `INFECTED` blocks access permanently. A file is never opened before it is clean.", "definitionAr": "av_status هو بوابة مكافحة البرمجيات الخبيثة لوثيقة KYB: PENDING يعني الحجر، وCLEAN يسمح بالمعاينة والمراجعة، وINFECTED يمنع الوصول نهائياً. لا يفتح الملف قبل أن يصبح نظيفاً.", "analogyEn": "Airport security X-ray: the bag cannot enter the secure area until the scanner clears it.", "analogyAr": "أشعة أمن المطار: لا تدخل الحقيبة المنطقة الآمنة حتى يسمح الماسح بذلك.", "fatalErrorEn": "NEVER preview or accept a KYB document whose av_status is PENDING or INFECTED.", "fatalErrorAr": "لا تعاين أو تقبل وثيقة KYB حالتها PENDING أو INFECTED.", "tags": ["kyb", "antivirus", "av", "status", "malware", "preview"]},
    {"term": "KYB Expiry & Re-verification", "category": "Compliance", "definitionEn": "KYB documents carry `expires_on`. The platform sends notices before expiry, marks the row EXPIRED, asks for a replacement, and can suspend a merchant whose required evidence stays expired beyond the grace period. Re-verification cadence is HIGH yearly, STANDARD every 2 years and LOW every 3 years by default.", "definitionAr": "وثائق KYB تحمل expires_on. ترسل المنصة تنبيهات قبل الانتهاء وتحدد الصف EXPIRED وتطلب بديلاً وقد تعلّق التاجر إذا بقيت الوثائق المطلوبة منتهية بعد فترة السماح. دورة إعادة التحقق افتراضياً: HIGH سنوياً، STANDARD كل سنتين، LOW كل 3 سنوات.", "analogyEn": "A driving licence renewal: reminders arrive before expiry, the licence becomes invalid on the date, and driving is suspended if it is not renewed.", "analogyAr": "تجديد رخصة القيادة: تصل التذكيرات قبل الانتهاء وتصبح الرخصة غير صالحة في التاريخ وتُعلق القيادة إن لم تُجدد.", "fatalErrorEn": "NEVER accept an expired document as current evidence; request a replacement or active-merchant re-verification.", "fatalErrorAr": "لا تقبل وثيقة منتهية كدليل حالي؛ اطلب بديلاً أو إعادة تحقق للتاجر النشط.", "tags": ["kyb", "expiry", "revalidation", "reverification", "suspension", "documents"]}
];

export const GL_ACCOUNT_DEFINITIONS: (GlossaryEntry & { normalBalance: string })[] = [
    {
        "code": "TREASURY",
        "normalBalance": "Debit (Asset)",
        "meaningEn": "Real Cash in Our Company Bank Account (plus instant first-party NeomPay settlements). This is the actual money available to wire out when merchants request a Cash-Out.",
        "meaningAr": "النقد الفعلي في حساب شركة المنصة البنكي (إضافة إلى تسويات NeomPay الفورية من الطرف الأول). هذا هو المال الفعلي المتاح للتحويل عندما يطلب التجار سحباً.",
        "tags": [
            "treasury",
            "real",
            "cash",
            "company",
            "bank",
            "account",
            "plus",
            "instant",
            "first-party",
            "neompay",
            "settlements",
            "actual",
            "money",
            "available"
        ]
    },
    {
        "code": "GATEWAY_CLEARING",
        "normalBalance": "Debit (Asset / Receivable)",
        "meaningEn": "Money a Gateway Owes Us (T+N Pending Settlement). Each gateway + environment + credential set has its own GATEWAY_CLEARING account so we know exactly how much each partner owes us.",
        "meaningAr": "مال تدين به بوابة لنا (تسوية معلقة T+N). لكل بوابة وبيئة ومجموعة اعتماد حساب GATEWAY_CLEARING خاص حتى نعرف بدقة كم يدين لنا كل شريك.",
        "tags": [
            "gateway",
            "clearing",
            "money",
            "owes",
            "t+n",
            "pending",
            "settlement",
            "each",
            "environment",
            "credential",
            "set",
            "own",
            "account",
            "know"
        ]
    },
    {
        "code": "COMMISSION_RECEIVABLE",
        "normalBalance": "Debit (Asset / Receivable)",
        "meaningEn": "Commission a MERCHANT_DIRECT Merchant Owes Us. When a merchant uses their own gateway credentials, the principal goes straight to the merchant's bank, so the merchant owes us our software commission.",
        "meaningAr": "عمولة يدين بها تاجر MERCHANT_DIRECT لنا. عندما يستخدم التاجر بيانات بوابته الخاصة يذهب الأصل مباشرة إلى بنك التاجر فيدين لنا بعمولة البرمجيات.",
        "tags": [
            "commission",
            "receivable",
            "merchant",
            "direct",
            "owes",
            "uses",
            "own",
            "gateway",
            "credentials",
            "principal",
            "goes",
            "straight",
            "bank",
            "software"
        ]
    },
    {
        "code": "PROVIDER_FEE_EXPENSE / GATEWAY_FEE_EXPENSE",
        "normalBalance": "Debit (Expense)",
        "meaningEn": "What the Upstream Bank/Gateway Charged Us to process the transaction.",
        "meaningAr": "ما يفرضه البنك أو البوابة الأعلى علينا لمعالجة المعاملة.",
        "tags": [
            "provider",
            "fee",
            "expense",
            "gateway",
            "upstream",
            "bank",
            "charged",
            "process",
            "transaction"
        ]
    },
    {
        "code": "MERCHANT_WALLET",
        "normalBalance": "Credit (Liability)",
        "meaningEn": "Money We Owe to a Specific Merchant. Every merchant wallet on the portal is backed 1-to-1 by a MERCHANT_WALLET GL account; its balance is computed directly from the ledger lines.",
        "meaningAr": "مال ندين به لتاجر محدد. كل محفظة تاجر في البوابة مدعومة 1-to-1 بحساب MERCHANT_WALLET ويُحسب رصيدها مباشرة من سطور الدفتر.",
        "tags": [
            "merchant",
            "wallet",
            "money",
            "owe",
            "specific",
            "portal",
            "backed",
            "1-to-1",
            "account",
            "balance",
            "computed",
            "directly",
            "ledger",
            "lines"
        ]
    },
    {
        "code": "PLATFORM_INCOME",
        "normalBalance": "Credit (Revenue)",
        "meaningEn": "Our Company's Gross Commission Revenue earned on confirmed payments.",
        "meaningAr": "إيراد عمولة المنصة الإجمالي المكتسب من المدفوعات المؤكدة.",
        "tags": [
            "platform",
            "income",
            "company",
            "gross",
            "commission",
            "revenue",
            "earned",
            "confirmed",
            "payments"
        ]
    },
    {
        "code": "GATEWAY_FEE_ACCRUAL",
        "normalBalance": "Credit (Liability)",
        "meaningEn": "Estimated Gateway Fees Waiting for the Bank Statement. We hold the estimated fee until the statement arrives and clears it.",
        "meaningAr": "رسوم بوابة تقديرية بانتظار كشف البنك. نحتفظ بالرسم التقديري حتى يصل الكشف ويُصفّى.",
        "tags": [
            "gateway",
            "fee",
            "accrual",
            "estimated",
            "fees",
            "waiting",
            "bank",
            "statement",
            "hold",
            "until",
            "arrives",
            "clears"
        ]
    },
    {
        "code": "AML_HOLD",
        "normalBalance": "Credit (Escrow Liability)",
        "meaningEn": "Frozen Money Under Compliance Investigation. The money is not credited to the Merchant Wallet and not counted as Platform Income yet; it sits frozen until the MLRO approves Release or Void.",
        "meaningAr": "مال مجمّد تحت تحقيق امتثال. لا يُضاف إلى محفظة التاجر ولا يُحتسب إيراداً للمنصة بعد؛ يبقى مجمّداً حتى يوافق مسؤول مكافحة غسل الأموال على الإفراج أو الإبطال.",
        "tags": [
            "aml",
            "hold",
            "frozen",
            "money",
            "under",
            "compliance",
            "investigation",
            "credited",
            "merchant",
            "wallet",
            "counted",
            "platform",
            "income",
            "yet"
        ]
    },
    {
        "code": "CHARGEBACK_RESERVE",
        "normalBalance": "Credit (Escrow Liability)",
        "meaningEn": "Disputed Money Escrowed During a Chargeback. We pull the merchant share and platform commission into CHARGEBACK_RESERVE until the dispute is Won or Lost.",
        "meaningAr": "مال متنازع عليه محجوز أثناء الاسترداد العكسي. نسحب حصة التاجر وعمولة المنصة إلى CHARGEBACK_RESERVE حتى يفوز النزاع أو يُخسر.",
        "tags": [
            "chargeback",
            "reserve",
            "disputed",
            "money",
            "escrowed",
            "during",
            "pull",
            "merchant",
            "share",
            "platform",
            "commission",
            "until",
            "dispute",
            "won"
        ]
    },
    {
        "code": "SUSPENSE",
        "normalBalance": "Credit (Holding Liability)",
        "meaningEn": "Unmatched or Duplicate Money Awaiting Operator Resolution. A second payment on a single-use link lands in SUSPENSE so it never double-credits the merchant and can be cleanly refunded.",
        "meaningAr": "مال غير مطابق أو مكرر بانتظار معالجة المشغّل. الدفعة الثانية على رابط أحادي الاستخدام تقع في SUSPENSE حتى لا تُضاعف رصيد التاجر ويمكن استردادها بنظافة.",
        "tags": [
            "suspense",
            "unmatched",
            "duplicate",
            "money",
            "awaiting",
            "operator",
            "resolution",
            "second",
            "payment",
            "single-use",
            "link",
            "lands",
            "never",
            "double-credits"
        ]
    }
];

export const ATTEMPT_STATUS_DEFINITIONS: (GlossaryEntry & { category: string; slotLocked: string; operatorAction: string })[] = [
    {
        "code": "CREATED",
        "category": "In-Flight",
        "meaningEn": "The customer just clicked Pay and the attempt row exists before any external call.",
        "meaningAr": "المحاولة موجودة قبل أي نداء خارجي.",
        "slotLocked": "YES (Locked)",
        "operatorAction": "Wait a few seconds; this transitions automatically.",
        "tags": [
            "created",
            "in-flight",
            "customer",
            "just",
            "clicked",
            "pay",
            "attempt",
            "row",
            "exists",
            "before",
            "any",
            "external",
            "call"
        ]
    },
    {
        "code": "INITIATING",
        "category": "In-Flight",
        "meaningEn": "Our server is talking to the gateway to start the session.",
        "meaningAr": "خادمنا يتحدث إلى البوابة لبدء الجلسة.",
        "slotLocked": "YES (Locked)",
        "operatorAction": "Wait a few seconds; this transitions automatically to AWAITING_CUSTOMER or FAILED.",
        "tags": [
            "initiating",
            "in-flight",
            "server",
            "talking",
            "gateway",
            "start",
            "session"
        ]
    },
    {
        "code": "AWAITING_CUSTOMER",
        "category": "In-Flight",
        "meaningEn": "The customer is looking at the OTP box, bank redirect page, Moamalat popup, QR code, or wallet app.",
        "meaningAr": "العميل ينظر إلى مربع OTP أو صفحة البنك أو نافذة معاملات أو رمز QR أو تطبيق المحفظة.",
        "slotLocked": "YES (Locked)",
        "operatorAction": "Tell the customer to complete the screen before the countdown expires. Do not cancel while they are entering their OTP.",
        "tags": [
            "awaiting",
            "customer",
            "in-flight",
            "looking",
            "otp",
            "box",
            "bank",
            "redirect",
            "page",
            "moamalat",
            "popup",
            "code",
            "wallet",
            "app"
        ]
    },
    {
        "code": "AUTHORIZING",
        "category": "In-Flight (Past PNR!)",
        "meaningEn": "The customer submitted their OTP/confirmation and our MOVES_MONEY request is in flight to the bank.",
        "meaningAr": "أرسل العميل رمز OTP أو تأكيده وطلب MOVES_MONEY في طريقه إلى البنك.",
        "slotLocked": "YES (Locked)",
        "operatorAction": "Hands off! Money is moving right now. Never cancel or retry.",
        "tags": [
            "authorizing",
            "in-flight",
            "past",
            "pnr",
            "customer",
            "submitted",
            "otp",
            "confirmation",
            "moves",
            "money",
            "request",
            "flight",
            "bank"
        ]
    },
    {
        "code": "VERIFYING",
        "category": "In-Flight",
        "meaningEn": "A browser hint, redirect return, or must_inquire webhook arrived and our server is querying the bank; or the payment is paused under AML_HOLD.",
        "meaningAr": "وصل تلميح متصفح أو عودة توجيه أو webhook يجب استعلامه وخادمنا يسأل البنك؛ أو الدفع موقوف تحت AML_HOLD.",
        "slotLocked": "YES (Locked)",
        "operatorAction": "Check substatus: if AML_HOLD, refer to Compliance. Otherwise PollWorker is actively checking.",
        "tags": [
            "verifying",
            "in-flight",
            "browser",
            "hint",
            "redirect",
            "return",
            "inquire",
            "webhook",
            "arrived",
            "server",
            "querying",
            "bank",
            "payment",
            "paused"
        ]
    },
    {
        "code": "UNKNOWN",
        "category": "Exception (Requires Action!)",
        "meaningEn": "Our server sent a money-moving call and the bank timed out, reset the connection, returned HTTP 500/502, or returned an unreadable response; or a webhook and inquiry contradicted each other (CONFLICT).",
        "meaningAr": "أرسل خادمنا نداءً ينقل المال فانتهت مهلة البنك أو أعاد خطأ أو رداً غير مفهوم؛ أو تعارض webhook واستعلام (CONFLICT).",
        "slotLocked": "YES (Strictly Held!)",
        "operatorAction": "Follow Runbook RB-03. Click Inquire Now. If there is no inquiry API, wait for Statement Reconciliation or verify with partner support before Maker-Checker resolution.",
        "tags": [
            "unknown",
            "exception",
            "requires",
            "action",
            "server",
            "sent",
            "money-moving",
            "call",
            "bank",
            "timed",
            "out",
            "reset",
            "connection",
            "returned"
        ]
    },
    {
        "code": "SUCCEEDED",
        "category": "Terminal (Paid)",
        "meaningEn": "All five Trusted Success Facts passed, the Double-Entry Ledger posted in the same transaction, and the Merchant Wallet (or Commission Receivable) was updated.",
        "meaningAr": "نجحت حقائق الثقة الخمس وقُيّد الدفتر المزدوج في المعاملة نفسها وتم تحديث محفظة التاجر أو العمولة المستحقة.",
        "slotLocked": "Slot Committed (confirmed_count + 1)",
        "operatorAction": "Payment is complete. If the customer needs a refund later, use a Maker-Checker Refund Adjustment.",
        "tags": [
            "succeeded",
            "terminal",
            "paid",
            "five",
            "trusted",
            "success",
            "facts",
            "passed",
            "double-entry",
            "ledger",
            "posted",
            "same",
            "transaction",
            "merchant"
        ]
    },
    {
        "code": "FAILED",
        "category": "Terminal (Unpaid)",
        "meaningEn": "The payment definitely failed without taking money (wrong OTP three times, insufficient funds, customer limit exceeded, or gateway down before point-of-no-return).",
        "meaningAr": "فشل الدفع قطعاً دون سحب مال (OTP خاطئ ثلاث مرات أو رصيد غير كافٍ أو تجاوز حد العميل أو تعطل البوابة قبل نقطة اللاعودة).",
        "slotLocked": "NO (Released)",
        "operatorAction": "The customer was not charged and the link slot is free; they can safely try again or pick another rail.",
        "tags": [
            "failed",
            "terminal",
            "unpaid",
            "payment",
            "definitely",
            "without",
            "taking",
            "money",
            "wrong",
            "otp",
            "three",
            "times",
            "insufficient",
            "funds"
        ]
    },
    {
        "code": "EXPIRED",
        "category": "Terminal (Timed Out)",
        "meaningEn": "The countdown timer ran out, our sweeper ran one final inquire() check, and the customer had not paid. The webhook inbox stays open during grace_expires_at.",
        "meaningAr": "انتهى العد التنازلي وشغّل الفاحص استعلاماً أخيراً ولم يكن العميل قد دفع. يبقى صندوق webhook مفتوحاً خلال grace_expires_at.",
        "slotLocked": "NO (Released)",
        "operatorAction": "If a verified payment notification arrives late during the grace window, the system automatically recovers EXPIRED -> SUCCEEDED or SUSPENSE.",
        "tags": [
            "expired",
            "terminal",
            "timed",
            "out",
            "countdown",
            "timer",
            "ran",
            "sweeper",
            "one",
            "final",
            "inquire",
            "check",
            "customer",
            "had"
        ]
    },
    {
        "code": "CANCELLED",
        "category": "Terminal (Aborted)",
        "meaningEn": "The customer or POS cashier clicked Cancel before the point of no return.",
        "meaningAr": "نقر العميل أو كاشير نقطة البيع على إلغاء قبل نقطة اللاعودة.",
        "slotLocked": "NO (Released)",
        "operatorAction": "Link slot is free for a new attempt.",
        "tags": [
            "cancelled",
            "terminal",
            "aborted",
            "customer",
            "pos",
            "cashier",
            "clicked",
            "cancel",
            "before",
            "point",
            "return"
        ]
    },
    {
        "code": "BLOCKED",
        "category": "Terminal (Risk Guard)",
        "meaningEn": "Blocked before calling the bank by a Velocity Rule, a Hot-Path AML Watchlist Hit, or Self-Payment Prevention.",
        "meaningAr": "حُجبت قبل نداء البنك بواسطة قاعدة سرعة أو إصابة قائمة مراقبة AML أو منع الدفع الذاتي.",
        "slotLocked": "NO (Never Reserved)",
        "operatorAction": "Do not reveal internal AML reasons. If blocked by Velocity, check /velocity-rules; if AML, escalate to COMPLIANCE.",
        "tags": [
            "blocked",
            "terminal",
            "risk",
            "guard",
            "before",
            "calling",
            "bank",
            "velocity",
            "rule",
            "hot-path",
            "aml",
            "watchlist",
            "hit",
            "self-payment"
        ]
    },
    {
        "code": "PARTIALLY_REFUNDED",
        "category": "Post-Settlement",
        "meaningEn": "One or more Maker-Checker Refund Adjustments were approved and executed back to the customer.",
        "meaningAr": "تمت الموافقة على تعديل استرداد واحد أو أكثر وتنفيذه للعميل.",
        "slotLocked": "Committed",
        "operatorAction": "Check /adjustments for the exact refunded amount and provider_refund_ref.",
        "tags": [
            "partially",
            "refunded",
            "post-settlement",
            "one",
            "more",
            "maker-checker",
            "refund",
            "adjustments",
            "were",
            "approved",
            "executed",
            "back",
            "customer"
        ]
    },
    {
        "code": "REFUNDED",
        "category": "Post-Settlement",
        "meaningEn": "The full settled amount was returned to the customer through approved refund adjustments.",
        "meaningAr": "أُعيد كامل المبلغ المسوّى إلى العميل عبر تعديلات استرداد معتمدة.",
        "slotLocked": "Committed",
        "operatorAction": "Check /adjustments for the refund reference and ledger entries.",
        "tags": [
            "refunded",
            "post-settlement",
            "full",
            "settled",
            "amount",
            "was",
            "returned",
            "customer",
            "through",
            "approved",
            "refund",
            "adjustments"
        ]
    },
    {
        "code": "DISPUTED",
        "category": "Post-Settlement",
        "meaningEn": "The bank or card switch reported a Chargeback / Dispute (disputes).",
        "meaningAr": "أبلغ البنك أو مقسم البطاقات عن استرداد عكسي أو نزاع (disputes).",
        "slotLocked": "Committed",
        "operatorAction": "Check /disputes and upload merchant evidence before evidence_due_at.",
        "tags": [
            "disputed",
            "post-settlement",
            "bank",
            "card",
            "switch",
            "reported",
            "chargeback",
            "dispute",
            "disputes"
        ]
    }
];

export const COLLECTION_MODE_DEFINITIONS: CollectionModeDefinition[] = [
    {
        "code": "OTP_PULL",
        "titleEn": "Two-Step SMS Code",
        "titleAr": "رمز SMS بخطوتين",
        "meaningEn": "The customer types their phone number, our server asks the gateway to send an SMS code, then the customer types the 4-to-6 digit code to move money.",
        "meaningAr": "يكتب العميل رقم هاتفه ويطلب خادمنا من البوابة إرسال رمز SMS ثم يكتب العميل رمزاً من 4 إلى 6 أرقام لتحريك المال.",
        "customerActionEn": "Type phone, receive SMS, type OTP",
        "customerActionAr": "كتابة الهاتف واستلام SMS وكتابة الرمز",
        "tags": [
            "otp",
            "pull",
            "two-step",
            "sms",
            "code",
            "customer",
            "types",
            "phone",
            "number",
            "server",
            "asks",
            "gateway",
            "send",
            "4-to-6"
        ]
    },
    {
        "code": "REDIRECT",
        "titleEn": "Hosted Checkout Page",
        "titleAr": "صفحة دفع مستضافة",
        "meaningEn": "Our server creates a session with the gateway, receives a redirect_url, and sends the customer's browser to the gateway's website to pay.",
        "meaningAr": "ينشئ خادمنا جلسة مع البوابة ويستلم redirect_url ويرسل متصفح العميل إلى موقع البوابة للدفع.",
        "customerActionEn": "Leave the checkout and pay on the bank page",
        "customerActionAr": "مغادرة صفحة الدفع والدفع في صفحة البنك",
        "tags": [
            "redirect",
            "hosted",
            "checkout",
            "page",
            "server",
            "creates",
            "session",
            "gateway",
            "receives",
            "url",
            "sends",
            "customer",
            "browser",
            "website"
        ]
    },
    {
        "code": "EMBEDDED",
        "titleEn": "In-Page Popup/Iframe",
        "titleAr": "نافذة أو إطار داخل الصفحة",
        "meaningEn": "Our server computes a signature over the amount, reference, and timestamp and hands signed parameters to the gateway's in-page script; the customer types card details inside the popup.",
        "meaningAr": "يحسب خادمنا توقيعاً على المبلغ والمرجع والوقت ويسلّم معاملات موقعة إلى سكربت البوابة داخل الصفحة؛ يكتب العميل بيانات البطاقة داخل النافذة.",
        "customerActionEn": "Type card details inside the bank popup",
        "customerActionAr": "كتابة بيانات البطاقة داخل نافذة البنك",
        "tags": [
            "embedded",
            "in-page",
            "popup",
            "iframe",
            "server",
            "computes",
            "signature",
            "over",
            "amount",
            "reference",
            "timestamp",
            "hands",
            "signed",
            "parameters"
        ]
    },
    {
        "code": "PUSH_APPROVAL",
        "titleEn": "Wallet App Notification",
        "titleAr": "إشعار تطبيق المحفظة",
        "meaningEn": "The customer enters a wallet phone/ID, our server sends a push request, and the customer approves or rejects it in their wallet app.",
        "meaningAr": "يدخل العميل هاتف أو معرّف المحفظة ويرسل خادمنا طلب دفع وينقر العميل موافقة أو رفضاً في تطبيق محفظته.",
        "customerActionEn": "Approve a push notification in the wallet app",
        "customerActionAr": "الموافقة على إشعار دفع في تطبيق المحفظة",
        "tags": [
            "push",
            "approval",
            "wallet",
            "app",
            "notification",
            "customer",
            "enters",
            "phone",
            "server",
            "sends",
            "request",
            "approves",
            "rejects"
        ]
    },
    {
        "code": "QR_DISPLAY",
        "titleEn": "Dynamic Barcode Scan",
        "titleAr": "مسح باركود ديناميكي",
        "meaningEn": "Our server generates a dynamic single-attempt QR code bound to the attempt reference and amount; the customer scans it with a banking app.",
        "meaningAr": "ينشئ خادمنا رمز QR ديناميكياً لمحاولة واحدة مرتبطاً بمرجع المحاولة والمبلغ؛ يمسحه العميل بتطبيق بنكي.",
        "customerActionEn": "Scan the QR code with a banking app",
        "customerActionAr": "مسح رمز QR بتطبيق بنكي",
        "tags": [
            "display",
            "dynamic",
            "barcode",
            "scan",
            "server",
            "generates",
            "single-attempt",
            "code",
            "bound",
            "attempt",
            "reference",
            "amount",
            "customer",
            "scans"
        ]
    },
    {
        "code": "PAY_CODE",
        "titleEn": "SMS / USSD Purchase Code",
        "titleAr": "رمز شراء عبر SMS أو USSD",
        "meaningEn": "Our screen displays a unique reference code and bilingual instructions telling the customer which short-code number to text or dial.",
        "meaningAr": "تعرض شاشتنا رمزاً مرجعياً فريداً وتعليمات ثنائية اللغة تخبر العميل بأي رقم قصير يرسل إليه أو يتصل به.",
        "customerActionEn": "Text or dial the displayed short code",
        "customerActionAr": "إرسال الرمز القصير أو الاتصال به",
        "tags": [
            "pay",
            "code",
            "sms",
            "ussd",
            "purchase",
            "screen",
            "displays",
            "unique",
            "reference",
            "bilingual",
            "instructions",
            "telling",
            "customer",
            "which"
        ]
    },
    {
        "code": "DEEP_LINK",
        "titleEn": "Mobile App Switch",
        "titleAr": "الانتقال إلى تطبيق الجوال",
        "meaningEn": "Tapping Open in Wallet App launches the installed wallet app with the payment pre-filled, falling back to a QR code if the app is not installed.",
        "meaningAr": "النقر على فتح تطبيق المحفظة يشغّل التطبيق المثبت مع تعبئة الدفع مسبقاً، ويعود إلى رمز QR إذا لم يكن التطبيق مثبتاً.",
        "customerActionEn": "Tap a button that opens the wallet app",
        "customerActionAr": "النقر على زر يفتح تطبيق المحفظة",
        "tags": [
            "deep",
            "link",
            "mobile",
            "app",
            "switch",
            "tapping",
            "open",
            "wallet",
            "launches",
            "installed",
            "payment",
            "pre-filled",
            "falling",
            "back"
        ]
    },
    {
        "code": "MANUAL",
        "titleEn": "Bank Wire or Cash Agent Deposit",
        "titleAr": "تحويل بنكي أو إيداع لدى وكيل نقدي",
        "meaningEn": "Displays transfer instructions and a unique reference code. Money is confirmed only by statement matching or two operators under Maker-Checker.",
        "meaningAr": "يعرض تعليمات التحويل ورمزاً مرجعياً فريداً. لا يُؤكد المال إلا بمطابقة الكشف أو موافقة مسؤولين وفق قاعدة العيون الأربع.",
        "customerActionEn": "Make a bank transfer or agent deposit",
        "customerActionAr": "إجراء تحويل بنكي أو إيداع لدى وكيل",
        "tags": [
            "manual",
            "bank",
            "wire",
            "cash",
            "agent",
            "deposit",
            "displays",
            "transfer",
            "instructions",
            "unique",
            "reference",
            "code",
            "money",
            "confirmed"
        ]
    },
    {
        "code": "HYBRID",
        "titleEn": "Customer Picks Sub-Mode",
        "titleAr": "اختيار العميل لنمط فرعي",
        "meaningEn": "A single Rail offers multiple sub-modes as tabs on the checkout card so the customer can choose whether to scan a QR or type an OTP.",
        "meaningAr": "تعرض سكة واحدة أنماطاً فرعية متعددة كعلامات تبويب في بطاقة الدفع ليختار العميل مسح QR أو كتابة OTP.",
        "customerActionEn": "Choose among QR, OTP, or another tab",
        "customerActionAr": "الاختيار بين QR أو OTP أو تبويب آخر",
        "tags": [
            "hybrid",
            "customer",
            "picks",
            "sub-mode",
            "single",
            "rail",
            "offers",
            "multiple",
            "sub-modes",
            "tabs",
            "checkout",
            "card",
            "choose",
            "whether"
        ]
    }
];

export const CONFIRMATION_CHANNEL_DEFINITIONS: ConfirmationChannelDefinition[] = [
    {
        "code": "SYNC_RESPONSE",
        "titleEn": "Direct reply to our confirm call",
        "titleAr": "الرد المباشر على نداء التأكيد",
        "trustLevel": "SERVER_TRUSTED",
        "meaningEn": "The gateway replies synchronously to our money-moving request with a definitive status.",
        "meaningAr": "ترد البوابة بشكل متزامن على طلبنا المالي بحالة قاطعة.",
        "tags": [
            "sync",
            "response",
            "direct",
            "reply",
            "confirm",
            "call",
            "gateway",
            "replies",
            "synchronously",
            "money-moving",
            "request",
            "definitive",
            "status"
        ]
    },
    {
        "code": "WEBHOOK",
        "titleEn": "Signed server-to-server notification",
        "titleAr": "إشعار موقّع من خادم إلى خادم",
        "trustLevel": "SERVER_TRUSTED",
        "meaningEn": "The bank sends a cryptographically signed notification to our webhook endpoint.",
        "meaningAr": "يرسل البنك إشعاراً موقّعاً تشفيرياً إلى نقطة webhook لدينا.",
        "tags": [
            "webhook",
            "signed",
            "server-to-server",
            "notification",
            "bank",
            "sends",
            "cryptographically",
            "endpoint"
        ]
    },
    {
        "code": "INQUIRY / POLL",
        "titleEn": "Server status inquiry",
        "titleAr": "استعلام حالة من الخادم",
        "trustLevel": "SERVER_TRUSTED",
        "meaningEn": "Our server asks the bank's status API using the original reference.",
        "meaningAr": "يسأل خادمنا واجهة حالة البنك باستخدام المرجع الأصلي.",
        "tags": [
            "inquiry",
            "poll",
            "server",
            "status",
            "asks",
            "bank",
            "api",
            "original",
            "reference"
        ]
    },
    {
        "code": "STATEMENT",
        "titleEn": "Daily bank statement",
        "titleAr": "كشف بنكي يومي",
        "trustLevel": "SERVER_TRUSTED",
        "meaningEn": "A daily CSV/XLSX/JSON settlement file proves what actually settled.",
        "meaningAr": "ملف تسوية يومي CSV أو XLSX أو JSON يثبت ما تمت تسويته فعلاً.",
        "tags": [
            "statement",
            "daily",
            "bank",
            "csv",
            "xlsx",
            "json",
            "settlement",
            "file",
            "proves",
            "actually",
            "settled"
        ]
    },
    {
        "code": "OPERATOR_CONFIRMATION",
        "titleEn": "Two-admin receipt verification",
        "titleAr": "تحقق مسؤولين من إيصال",
        "trustLevel": "SERVER_TRUSTED",
        "meaningEn": "Two authorized humans verify a receipt under Maker-Checker.",
        "meaningAr": "يتحقق مسؤولان مخوّلان من إيصال وفق قاعدة العيون الأربع.",
        "tags": [
            "operator",
            "confirmation",
            "two-admin",
            "receipt",
            "verification",
            "two",
            "authorized",
            "humans",
            "verify",
            "under",
            "maker-checker"
        ]
    },
    {
        "code": "RETURN_URL",
        "titleEn": "Customer browser return",
        "titleAr": "عودة متصفح العميل",
        "trustLevel": "ZERO_TRUST",
        "meaningEn": "The customer's browser returns from a bank page. It is only a doorbell and must trigger an inquiry.",
        "meaningAr": "يعود متصفح العميل من صفحة البنك. هو مجرد جرس باب ويجب أن يطلق استعلاماً.",
        "tags": [
            "return",
            "url",
            "customer",
            "browser",
            "returns",
            "bank",
            "page",
            "doorbell",
            "trigger",
            "inquiry"
        ]
    },
    {
        "code": "BROWSER_CALLBACK",
        "titleEn": "JavaScript browser callback",
        "titleAr": "استدعاء جافاسكربت من المتصفح",
        "trustLevel": "ZERO_TRUST",
        "meaningEn": "JavaScript in the browser says Complete. It can be forged with F12 and must trigger an inquiry.",
        "meaningAr": "جافاسكربت في المتصفح يقول اكتمل. يمكن تزويره بـ F12 ويجب أن يطلق استعلاماً.",
        "tags": [
            "browser",
            "callback",
            "javascript",
            "says",
            "complete",
            "forged",
            "f12",
            "trigger",
            "inquiry"
        ]
    }
];

export const RUNBOOK_DEFINITIONS: RunbookDefinition[] = [
    {
        "id": "RB-01",
        "titleEn": "Route circuit breaker or gateway outage",
        "titleAr": "قاطع دائرة المسار أو انقطاع البوابة",
        "triggerEn": "A route opens its circuit breaker or a gateway stops responding, hiding the rail at checkout.",
        "triggerAr": "يفتح مسار قاطعه أو يتوقف gateway عن الاستجابة فتختفي السكة من صفحة الدفع.",
        "stepsEn": [
            "Confirm the route state and health in Catalog -> Routes.",
            "Check whether other routes for the same rail remain ACTIVE and HEALTHY.",
            "Do not send real customer money calls to test recovery; wait for half-open read-only probes.",
            "If the outage is confirmed, communicate the affected rail internally and monitor the breaker.",
            "When probes succeed, let the breaker close and drain the backlog in a controlled order."
        ],
        "stepsAr": [
            "أكّد حالة المسار وصحته في الكتالوج -> المسارات.",
            "تحقق مما إذا كانت مسارات أخرى للسكة نفسها لا تزال ACTIVE وHEALTHY.",
            "لا ترسل نداءات أموال حقيقية لاختبار التعافي؛ انتظر فحوص نصف مفتوحة للقراءة فقط.",
            "إذا تأكد الانقطاع، أبلغ داخلياً عن السكة المتأثرة وراقب القاطع.",
            "عند نجاح الفحوص، اترك القاطع يُغلق وصرّف التراكم بترتيب مضبوط."
        ]
    },
    {
        "id": "RB-02",
        "titleEn": "Webhook from an unlisted IP",
        "titleAr": "webhook من عنوان IP غير مدرج",
        "triggerEn": "A webhook arrives with a valid HMAC signature but from an IP outside inbound_ip_allowlist.",
        "triggerAr": "يصل webhook بتوقيع HMAC صالح لكن من عنوان IP خارج inbound_ip_allowlist.",
        "stepsEn": [
            "Store the event in inbound_events with verified = false.",
            "Fire the unlisted-IP security alert.",
            "Contact the partner through a known channel and confirm the new IP.",
            "Update the allowlist through Maker-Checker.",
            "Replay the stored event losslessly from the inbox."
        ],
        "stepsAr": [
            "خزّن الحدث في inbound_events مع verified = false.",
            "أطلق تنبيه أمان IP غير مدرج.",
            "تواصل مع الشريك عبر قناة معروفة وأكّد عنوان IP الجديد.",
            "حدّث قائمة السماح وفق قاعدة العيون الأربع.",
            "أعد تشغيل الحدث المخزن بلا فقدان من صندوق الوارد."
        ]
    },
    {
        "id": "RB-03",
        "titleEn": "UNKNOWN payment resolution",
        "titleAr": "حل دفعة UNKNOWN",
        "triggerEn": "A money-moving call timed out or returned an unreadable response, so the outcome is unknown.",
        "triggerAr": "انتهت مهلة نداء ينقل المال أو أعاد رداً غير مفهوم فتصبح النتيجة مجهولة.",
        "stepsEn": [
            "Open /operator-cases and inspect attempt_step_logs: HTTP status, timeout, raw response.",
            "If supports_status_check = true, click Inquire Gateway Now.",
            "If there is no inquiry API, upload the daily settlement statement or obtain written provider_reference confirmation.",
            "Propose Resolve to SUCCEEDED with provider_reference or Resolve to FAILED under Maker-Checker.",
            "Never force FAILED without evidence while the bank may have taken the money."
        ],
        "stepsAr": [
            "افتح /operator-cases وافحص attempt_step_logs: حالة HTTP والمهلة والرد الخام.",
            "إذا كانت supports_status_check = true فانقر Inquire Gateway Now.",
            "إذا لم توجد واجهة استعلام، ارفع كشف التسوية اليومي أو احصل على تأكيد كتابي لـ provider_reference.",
            "اقترح الحل إلى SUCCEEDED مع provider_reference أو إلى FAILED وفق قاعدة العيون الأربع.",
            "لا تفرض FAILED دون دليل بينما قد يكون البنك قد أخذ المال."
        ]
    },
    {
        "id": "RB-04",
        "titleEn": "Ledger invariant drift",
        "titleAr": "انحراف ثبات الدفتر",
        "triggerEn": "The Ledger Invariant Monitor shows any drift other than 0.0000 LYD.",
        "triggerAr": "يعرض مراقب ثبات الدفتر أي انحراف غير 0.0000 LYD.",
        "stepsEn": [
            "Halt automated merchant cash-out payouts immediately.",
            "Freeze the affected accounts and preserve all evidence.",
            "Recompute journal entries and identify the unbalanced line.",
            "Escalate to Finance and Security; do not edit historical ledger lines.",
            "Resume payouts only after Finance reconciles the drift to 0.0000 LYD."
        ],
        "stepsAr": [
            "أوقف مدفوعات السحب الآلية للتجار فوراً.",
            "جمّد الحسابات المتأثرة واحفظ كل الأدلة.",
            "أعد حساب القيود وحدد السطر غير المتوازن.",
            "صعّد إلى المالية والأمان؛ لا تعدّل سطور الدفتر التاريخية.",
            "استأنف السحوبات فقط بعد أن تطابق المالية الانحراف إلى 0.0000 LYD."
        ]
    },
    {
        "id": "RB-05",
        "titleEn": "CONFLICT or AML_HOLD lock",
        "titleAr": "تعارض CONFLICT أو قفل AML_HOLD",
        "triggerEn": "A webhook and inquiry contradict each other, or an AML_HOLD freezes the attempt.",
        "triggerAr": "يتعارض webhook واستعلام، أو يجمّد AML_HOLD المحاولة.",
        "stepsEn": [
            "Inspect inbound_events and attempt_step_logs; neither signal is trusted automatically.",
            "Verify against the official settlement statement.",
            "For AML_HOLD, route to COMPLIANCE/MLRO; Support must never see the confidential reason.",
            "Propose a Maker-Checker resolution; never release the slot or refund by guesswork.",
            "Record the runbook id in the operator case and the post-incident review."
        ],
        "stepsAr": [
            "افحص inbound_events وattempt_step_logs؛ لا تُوثق بأي إشارة تلقائياً.",
            "تحقق مقابل كشف التسوية الرسمي.",
            "في AML_HOLD وجّه إلى الامتثال ومسؤول مكافحة غسل الأموال؛ لا يجوز للدعم رؤية السبب السري.",
            "اقترح حلاً وفق قاعدة العيون الأربع؛ لا تحرر الخانة ولا تسترد بالتخمين.",
            "سجّل معرّف الدليل التشغيلي في حالة المشغّل ومراجعة ما بعد الحادث."
        ]
    }
];

export const EDGE_CASE_DEFINITIONS: EdgeCaseDefinition[] = [
    {
        "id": "EC-001",
        "titleEn": "Expiry race with final inquiry",
        "titleAr": "سباق الانتهاء مع الاستعلام الأخير",
        "descriptionEn": "ExpirySweeperWorker must run one final inquire() before marking AWAITING_CUSTOMER or VERIFYING as EXPIRED.",
        "descriptionAr": "يجب أن يشغّل ExpirySweeperWorker استعلاماً أخيراً قبل تحويل AWAITING_CUSTOMER أو VERIFYING إلى EXPIRED.",
        "tags": [
            "ec-001",
            "expiry",
            "race",
            "final",
            "inquiry"
        ]
    },
    {
        "id": "EC-002",
        "titleEn": "Canonical edge case EC-002",
        "titleAr": "الحالة الطرفية القياسية EC-002",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-002 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-002 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-002",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-003",
        "titleEn": "Canonical edge case EC-003",
        "titleAr": "الحالة الطرفية القياسية EC-003",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-003 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-003 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-003",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-004",
        "titleEn": "Canonical edge case EC-004",
        "titleAr": "الحالة الطرفية القياسية EC-004",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-004 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-004 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-004",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-005",
        "titleEn": "Canonical edge case EC-005",
        "titleAr": "الحالة الطرفية القياسية EC-005",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-005 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-005 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-005",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-006",
        "titleEn": "Canonical edge case EC-006",
        "titleAr": "الحالة الطرفية القياسية EC-006",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-006 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-006 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-006",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-007",
        "titleEn": "Canonical edge case EC-007",
        "titleAr": "الحالة الطرفية القياسية EC-007",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-007 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-007 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-007",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-008",
        "titleEn": "Canonical edge case EC-008",
        "titleAr": "الحالة الطرفية القياسية EC-008",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-008 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-008 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-008",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-009",
        "titleEn": "Canonical edge case EC-009",
        "titleAr": "الحالة الطرفية القياسية EC-009",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-009 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-009 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-009",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-010",
        "titleEn": "Canonical edge case EC-010",
        "titleAr": "الحالة الطرفية القياسية EC-010",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-010 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-010 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-010",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-011",
        "titleEn": "Canonical edge case EC-011",
        "titleAr": "الحالة الطرفية القياسية EC-011",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-011 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-011 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-011",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-012",
        "titleEn": "Canonical edge case EC-012",
        "titleAr": "الحالة الطرفية القياسية EC-012",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-012 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-012 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-012",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-013",
        "titleEn": "Canonical edge case EC-013",
        "titleAr": "الحالة الطرفية القياسية EC-013",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-013 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-013 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-013",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-014",
        "titleEn": "POS idle session expiry",
        "titleAr": "انتهاء جلسة نقطة البيع الخاملة",
        "descriptionEn": "A POS screen idles after 15 minutes without cashier activity; in-flight payments continue and the screen resyncs on reconnect.",
        "descriptionAr": "تشغر شاشة نقطة البيع بعد 15 دقيقة دون نشاط الكاشير؛ تستمر المدفوعات الجارية وتتزامن الشاشة عند إعادة الاتصال.",
        "tags": [
            "ec-014",
            "pos",
            "idle",
            "session",
            "expiry"
        ]
    },
    {
        "id": "EC-015",
        "titleEn": "Canonical edge case EC-015",
        "titleAr": "الحالة الطرفية القياسية EC-015",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-015 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-015 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-015",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-016",
        "titleEn": "Canonical edge case EC-016",
        "titleAr": "الحالة الطرفية القياسية EC-016",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-016 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-016 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-016",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-017",
        "titleEn": "Canonical edge case EC-017",
        "titleAr": "الحالة الطرفية القياسية EC-017",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-017 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-017 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-017",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-018",
        "titleEn": "Canonical edge case EC-018",
        "titleAr": "الحالة الطرفية القياسية EC-018",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-018 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-018 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-018",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-019",
        "titleEn": "Canonical edge case EC-019",
        "titleAr": "الحالة الطرفية القياسية EC-019",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-019 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-019 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-019",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-020",
        "titleEn": "Canonical edge case EC-020",
        "titleAr": "الحالة الطرفية القياسية EC-020",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-020 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-020 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-020",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-021",
        "titleEn": "Canonical edge case EC-021",
        "titleAr": "الحالة الطرفية القياسية EC-021",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-021 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-021 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-021",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-022",
        "titleEn": "Canonical edge case EC-022",
        "titleAr": "الحالة الطرفية القياسية EC-022",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-022 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-022 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-022",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-023",
        "titleEn": "Canonical edge case EC-023",
        "titleAr": "الحالة الطرفية القياسية EC-023",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-023 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-023 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-023",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-024",
        "titleEn": "Canonical edge case EC-024",
        "titleAr": "الحالة الطرفية القياسية EC-024",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-024 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-024 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-024",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-025",
        "titleEn": "Canonical edge case EC-025",
        "titleAr": "الحالة الطرفية القياسية EC-025",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-025 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-025 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-025",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-026",
        "titleEn": "Canonical edge case EC-026",
        "titleAr": "الحالة الطرفية القياسية EC-026",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-026 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-026 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-026",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-027",
        "titleEn": "Canonical edge case EC-027",
        "titleAr": "الحالة الطرفية القياسية EC-027",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-027 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-027 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-027",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-028",
        "titleEn": "Canonical edge case EC-028",
        "titleAr": "الحالة الطرفية القياسية EC-028",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-028 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-028 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-028",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-029",
        "titleEn": "Canonical edge case EC-029",
        "titleAr": "الحالة الطرفية القياسية EC-029",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-029 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-029 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-029",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-030",
        "titleEn": "Canonical edge case EC-030",
        "titleAr": "الحالة الطرفية القياسية EC-030",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-030 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-030 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-030",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-031",
        "titleEn": "Canonical edge case EC-031",
        "titleAr": "الحالة الطرفية القياسية EC-031",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-031 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-031 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-031",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-032",
        "titleEn": "Canonical edge case EC-032",
        "titleAr": "الحالة الطرفية القياسية EC-032",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-032 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-032 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-032",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-033",
        "titleEn": "Canonical edge case EC-033",
        "titleAr": "الحالة الطرفية القياسية EC-033",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-033 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-033 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-033",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-034",
        "titleEn": "Canonical edge case EC-034",
        "titleAr": "الحالة الطرفية القياسية EC-034",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-034 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-034 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-034",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-035",
        "titleEn": "Canonical edge case EC-035",
        "titleAr": "الحالة الطرفية القياسية EC-035",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-035 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-035 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-035",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-036",
        "titleEn": "Canonical edge case EC-036",
        "titleAr": "الحالة الطرفية القياسية EC-036",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-036 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-036 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-036",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-037",
        "titleEn": "Canonical edge case EC-037",
        "titleAr": "الحالة الطرفية القياسية EC-037",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-037 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-037 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-037",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-038",
        "titleEn": "Canonical edge case EC-038",
        "titleAr": "الحالة الطرفية القياسية EC-038",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-038 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-038 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-038",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-039",
        "titleEn": "Canonical edge case EC-039",
        "titleAr": "الحالة الطرفية القياسية EC-039",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-039 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-039 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-039",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-040",
        "titleEn": "Canonical edge case EC-040",
        "titleAr": "الحالة الطرفية القياسية EC-040",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-040 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-040 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-040",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-041",
        "titleEn": "Canonical edge case EC-041",
        "titleAr": "الحالة الطرفية القياسية EC-041",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-041 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-041 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-041",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-042",
        "titleEn": "Canonical edge case EC-042",
        "titleAr": "الحالة الطرفية القياسية EC-042",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-042 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-042 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-042",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-043",
        "titleEn": "Canonical edge case EC-043",
        "titleAr": "الحالة الطرفية القياسية EC-043",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-043 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-043 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-043",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-044",
        "titleEn": "Canonical edge case EC-044",
        "titleAr": "الحالة الطرفية القياسية EC-044",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-044 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-044 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-044",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-045",
        "titleEn": "Canonical edge case EC-045",
        "titleAr": "الحالة الطرفية القياسية EC-045",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-045 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-045 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-045",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-046",
        "titleEn": "Canonical edge case EC-046",
        "titleAr": "الحالة الطرفية القياسية EC-046",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-046 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-046 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-046",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-047",
        "titleEn": "Canonical edge case EC-047",
        "titleAr": "الحالة الطرفية القياسية EC-047",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-047 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-047 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-047",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-048",
        "titleEn": "Commission receivable ceiling",
        "titleAr": "سقف العمولة المستحقة",
        "descriptionEn": "A MERCHANT_DIRECT receivable above commission_receivable_ceiling pauses direct routes with CEILING_EXCEEDED_PAUSE and nets against wallet balance.",
        "descriptionAr": "العمولة المستحقة لتاجر MERCHANT_DIRECT فوق commission_receivable_ceiling توقف المسارات المباشرة بـ CEILING_EXCEEDED_PAUSE وتُقاص مقابل رصيد المحفظة.",
        "tags": [
            "ec-048",
            "commission",
            "receivable",
            "ceiling"
        ]
    },
    {
        "id": "EC-049",
        "titleEn": "Canonical edge case EC-049",
        "titleAr": "الحالة الطرفية القياسية EC-049",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-049 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-049 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-049",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-050",
        "titleEn": "Canonical edge case EC-050",
        "titleAr": "الحالة الطرفية القياسية EC-050",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-050 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-050 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-050",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-051",
        "titleEn": "Canonical edge case EC-051",
        "titleAr": "الحالة الطرفية القياسية EC-051",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-051 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-051 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-051",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-052",
        "titleEn": "Canonical edge case EC-052",
        "titleAr": "الحالة الطرفية القياسية EC-052",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-052 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-052 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-052",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-053",
        "titleEn": "Only rail circuit breaker opens",
        "titleAr": "فتح قاطع السكة الوحيدة",
        "descriptionEn": "Only that rail is hidden from checkout; all other healthy rails keep working and an alert fires.",
        "descriptionAr": "تُخفى تلك السكة فقط من صفحة الدفع؛ تستمر كل السكك السليمة الأخرى ويُطلق تنبيه.",
        "tags": [
            "ec-053",
            "rail",
            "circuit",
            "breaker",
            "opens"
        ]
    },
    {
        "id": "EC-054",
        "titleEn": "Canonical edge case EC-054",
        "titleAr": "الحالة الطرفية القياسية EC-054",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-054 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-054 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-054",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-055",
        "titleEn": "Canonical edge case EC-055",
        "titleAr": "الحالة الطرفية القياسية EC-055",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-055 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-055 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-055",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-056",
        "titleEn": "Canonical edge case EC-056",
        "titleAr": "الحالة الطرفية القياسية EC-056",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-056 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-056 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-056",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-057",
        "titleEn": "Provider renamed a response field",
        "titleAr": "غيّر المزوّد اسم حقل الاستجابة",
        "descriptionEn": "A 200 OK with a missing PROVIDER_REF selector enters UNKNOWN and preserves the raw response in attempt_step_logs.",
        "descriptionAr": "رد 200 OK مع غياب محدد PROVIDER_REF يدخل UNKNOWN ويحفظ الرد الخام في attempt_step_logs.",
        "tags": [
            "ec-057",
            "provider",
            "renamed",
            "response",
            "field"
        ]
    },
    {
        "id": "EC-058",
        "titleEn": "Canonical edge case EC-058",
        "titleAr": "الحالة الطرفية القياسية EC-058",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-058 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-058 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-058",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-059",
        "titleEn": "Canonical edge case EC-059",
        "titleAr": "الحالة الطرفية القياسية EC-059",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-059 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-059 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-059",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-060",
        "titleEn": "Canonical edge case EC-060",
        "titleAr": "الحالة الطرفية القياسية EC-060",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-060 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-060 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-060",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-061",
        "titleEn": "Canonical edge case EC-061",
        "titleAr": "الحالة الطرفية القياسية EC-061",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-061 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-061 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-061",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-062",
        "titleEn": "Canonical edge case EC-062",
        "titleAr": "الحالة الطرفية القياسية EC-062",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-062 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-062 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-062",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-063",
        "titleEn": "Canonical edge case EC-063",
        "titleAr": "الحالة الطرفية القياسية EC-063",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-063 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-063 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-063",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-064",
        "titleEn": "Canonical edge case EC-064",
        "titleAr": "الحالة الطرفية القياسية EC-064",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-064 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-064 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-064",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-065",
        "titleEn": "Canonical edge case EC-065",
        "titleAr": "الحالة الطرفية القياسية EC-065",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-065 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-065 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-065",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-066",
        "titleEn": "Canonical edge case EC-066",
        "titleAr": "الحالة الطرفية القياسية EC-066",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-066 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-066 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-066",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-067",
        "titleEn": "AML on MERCHANT_DIRECT",
        "titleAr": "AML على MERCHANT_DIRECT",
        "descriptionEn": "Because the platform never held the principal, AML executes CASE_ONLY without posting a fake AML_HOLD journal entry.",
        "descriptionAr": "لأن المنصة لم تحتفظ بالأصل ينفذ AML حالة CASE_ONLY دون قيد AML_HOLD وهمي.",
        "tags": [
            "ec-067",
            "aml",
            "merchant",
            "direct"
        ]
    },
    {
        "id": "EC-068",
        "titleEn": "Gateway edited during live traffic",
        "titleAr": "تعديل البوابة أثناء حركة حقيقية",
        "descriptionEn": "Each payment_attempts row pins gateway_version_id, so in-flight attempts finish on the version they started with.",
        "descriptionAr": "كل صف payment_attempts يثبّت gateway_version_id فتنتهي المحاولات الجارية على الإصدار الذي بدأت به.",
        "tags": [
            "ec-068",
            "gateway",
            "edited",
            "during",
            "live",
            "traffic"
        ]
    },
    {
        "id": "EC-069",
        "titleEn": "Canonical edge case EC-069",
        "titleAr": "الحالة الطرفية القياسية EC-069",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-069 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-069 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-069",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-070",
        "titleEn": "Canonical edge case EC-070",
        "titleAr": "الحالة الطرفية القياسية EC-070",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-070 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-070 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-070",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-071",
        "titleEn": "Canonical edge case EC-071",
        "titleAr": "الحالة الطرفية القياسية EC-071",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-071 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-071 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-071",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-072",
        "titleEn": "Canonical edge case EC-072",
        "titleAr": "الحالة الطرفية القياسية EC-072",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-072 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-072 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-072",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-073",
        "titleEn": "Canonical edge case EC-073",
        "titleAr": "الحالة الطرفية القياسية EC-073",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-073 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-073 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-073",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-074",
        "titleEn": "Canonical edge case EC-074",
        "titleAr": "الحالة الطرفية القياسية EC-074",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-074 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-074 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-074",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-075",
        "titleEn": "Canonical edge case EC-075",
        "titleAr": "الحالة الطرفية القياسية EC-075",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-075 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-075 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-075",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-076",
        "titleEn": "Canonical edge case EC-076",
        "titleAr": "الحالة الطرفية القياسية EC-076",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-076 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-076 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-076",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-077",
        "titleEn": "Canonical edge case EC-077",
        "titleAr": "الحالة الطرفية القياسية EC-077",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-077 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-077 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-077",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-078",
        "titleEn": "Canonical edge case EC-078",
        "titleAr": "الحالة الطرفية القياسية EC-078",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-078 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-078 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-078",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-079",
        "titleEn": "Canonical edge case EC-079",
        "titleAr": "الحالة الطرفية القياسية EC-079",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-079 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-079 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-079",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-080",
        "titleEn": "Amount injected by the browser",
        "titleAr": "مبلغ محقون من المتصفح",
        "descriptionEn": "Checkout and core never accept amount or currency from the browser; the server reads payment_links.amount.",
        "descriptionAr": "صفحة الدفع والنواة لا تقبلان المبلغ أو العملة من المتصفح؛ يقرأ الخادم payment_links.amount.",
        "tags": [
            "ec-080",
            "amount",
            "injected",
            "browser"
        ]
    },
    {
        "id": "EC-081",
        "titleEn": "Canonical edge case EC-081",
        "titleAr": "الحالة الطرفية القياسية EC-081",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-081 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-081 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-081",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-082",
        "titleEn": "Canonical edge case EC-082",
        "titleAr": "الحالة الطرفية القياسية EC-082",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-082 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-082 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-082",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-083",
        "titleEn": "Canonical edge case EC-083",
        "titleAr": "الحالة الطرفية القياسية EC-083",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-083 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-083 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-083",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-084",
        "titleEn": "Canonical edge case EC-084",
        "titleAr": "الحالة الطرفية القياسية EC-084",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-084 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-084 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-084",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-085",
        "titleEn": "Canonical edge case EC-085",
        "titleAr": "الحالة الطرفية القياسية EC-085",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-085 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-085 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-085",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-086",
        "titleEn": "Canonical edge case EC-086",
        "titleAr": "الحالة الطرفية القياسية EC-086",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-086 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-086 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-086",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-087",
        "titleEn": "Canonical edge case EC-087",
        "titleAr": "الحالة الطرفية القياسية EC-087",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-087 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-087 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-087",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-088",
        "titleEn": "Canonical edge case EC-088",
        "titleAr": "الحالة الطرفية القياسية EC-088",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-088 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-088 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-088",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-089",
        "titleEn": "Canonical edge case EC-089",
        "titleAr": "الحالة الطرفية القياسية EC-089",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-089 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-089 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-089",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-090",
        "titleEn": "Canonical edge case EC-090",
        "titleAr": "الحالة الطرفية القياسية EC-090",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-090 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-090 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-090",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-091",
        "titleEn": "Canonical edge case EC-091",
        "titleAr": "الحالة الطرفية القياسية EC-091",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-091 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-091 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-091",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-092",
        "titleEn": "Canonical edge case EC-092",
        "titleAr": "الحالة الطرفية القياسية EC-092",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-092 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-092 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-092",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-093",
        "titleEn": "Canonical edge case EC-093",
        "titleAr": "الحالة الطرفية القياسية EC-093",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-093 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-093 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-093",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-094",
        "titleEn": "Canonical edge case EC-094",
        "titleAr": "الحالة الطرفية القياسية EC-094",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-094 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-094 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-094",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-095",
        "titleEn": "POS Wi-Fi drops during QR scan",
        "titleAr": "انقطاع واي فاي نقطة البيع أثناء مسح QR",
        "descriptionEn": "The server keeps watching the payment and credits the wallet when the bank confirms, even if the tablet disconnects.",
        "descriptionAr": "يستمر الخادم في مراقبة الدفع ويضيف المال للمحفظة عند تأكيد البنك حتى لو انقطع الجهاز اللوحي.",
        "tags": [
            "ec-095",
            "pos",
            "wi-fi",
            "drops",
            "during",
            "scan"
        ]
    },
    {
        "id": "EC-096",
        "titleEn": "Canonical edge case EC-096",
        "titleAr": "الحالة الطرفية القياسية EC-096",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-096 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-096 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-096",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-097",
        "titleEn": "Canonical edge case EC-097",
        "titleAr": "الحالة الطرفية القياسية EC-097",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-097 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-097 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-097",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-098",
        "titleEn": "Canonical edge case EC-098",
        "titleAr": "الحالة الطرفية القياسية EC-098",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-098 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-098 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-098",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-099",
        "titleEn": "Canonical edge case EC-099",
        "titleAr": "الحالة الطرفية القياسية EC-099",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-099 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-099 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-099",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-100",
        "titleEn": "Canonical edge case EC-100",
        "titleAr": "الحالة الطرفية القياسية EC-100",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-100 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-100 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-100",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-101",
        "titleEn": "Canonical edge case EC-101",
        "titleAr": "الحالة الطرفية القياسية EC-101",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-101 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-101 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-101",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-102",
        "titleEn": "Canonical edge case EC-102",
        "titleAr": "الحالة الطرفية القياسية EC-102",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-102 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-102 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-102",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-103",
        "titleEn": "Canonical edge case EC-103",
        "titleAr": "الحالة الطرفية القياسية EC-103",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-103 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-103 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-103",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-104",
        "titleEn": "Canonical edge case EC-104",
        "titleAr": "الحالة الطرفية القياسية EC-104",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-104 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-104 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-104",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-105",
        "titleEn": "Canonical edge case EC-105",
        "titleAr": "الحالة الطرفية القياسية EC-105",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-105 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-105 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-105",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-106",
        "titleEn": "Canonical edge case EC-106",
        "titleAr": "الحالة الطرفية القياسية EC-106",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-106 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-106 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-106",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-107",
        "titleEn": "Canonical edge case EC-107",
        "titleAr": "الحالة الطرفية القياسية EC-107",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-107 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-107 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-107",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-108",
        "titleEn": "Canonical edge case EC-108",
        "titleAr": "الحالة الطرفية القياسية EC-108",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-108 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-108 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-108",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-109",
        "titleEn": "Canonical edge case EC-109",
        "titleAr": "الحالة الطرفية القياسية EC-109",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-109 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-109 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-109",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-110",
        "titleEn": "Canonical edge case EC-110",
        "titleAr": "الحالة الطرفية القياسية EC-110",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-110 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-110 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-110",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-111",
        "titleEn": "Cash-out bank snapshot",
        "titleAr": "لقطة بنك السحب",
        "descriptionEn": "cashout_requests snapshots destination_bank_json at creation; new bank details apply only to future cash-outs.",
        "descriptionAr": "تلتقط cashout_requests نسخة destination_bank_json عند الإنشاء؛ بيانات البنك الجديدة تطبق على السحوبات المستقبلية فقط.",
        "tags": [
            "ec-111",
            "cash-out",
            "bank",
            "snapshot"
        ]
    },
    {
        "id": "EC-112",
        "titleEn": "Canonical edge case EC-112",
        "titleAr": "الحالة الطرفية القياسية EC-112",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-112 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-112 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-112",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-113",
        "titleEn": "Canonical edge case EC-113",
        "titleAr": "الحالة الطرفية القياسية EC-113",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-113 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-113 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-113",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-114",
        "titleEn": "Canonical edge case EC-114",
        "titleAr": "الحالة الطرفية القياسية EC-114",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-114 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-114 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-114",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-115",
        "titleEn": "Canonical edge case EC-115",
        "titleAr": "الحالة الطرفية القياسية EC-115",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-115 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-115 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-115",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-116",
        "titleEn": "Canonical edge case EC-116",
        "titleAr": "الحالة الطرفية القياسية EC-116",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-116 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-116 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-116",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-117",
        "titleEn": "Canonical edge case EC-117",
        "titleAr": "الحالة الطرفية القياسية EC-117",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-117 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-117 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-117",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-118",
        "titleEn": "Canonical edge case EC-118",
        "titleAr": "الحالة الطرفية القياسية EC-118",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-118 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-118 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-118",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-119",
        "titleEn": "ADMIN_ASSISTED maker barred",
        "titleAr": "منع منشئ ADMIN_ASSISTED",
        "descriptionEn": "An operator who prepared an ADMIN_ASSISTED join request cannot be its reviewer or checker.",
        "descriptionAr": "المشغّل الذي أعد طلب انضمام ADMIN_ASSISTED لا يمكن أن يكون مراجعه أو مدققه.",
        "tags": [
            "ec-119",
            "admin",
            "assisted",
            "maker",
            "barred"
        ]
    },
    {
        "id": "EC-120",
        "titleEn": "Duplicate document SHA-256",
        "titleAr": "تكرار وثيقة SHA-256",
        "descriptionEn": "Two unrelated merchants uploading the exact same sha256 file hash raise DUPLICATE_DOCUMENT.",
        "descriptionAr": "تاجران غير مرتبطان يرفعان نفس بصمة sha256 يطلقان DUPLICATE_DOCUMENT.",
        "tags": [
            "ec-120",
            "duplicate",
            "document",
            "sha-256"
        ]
    },
    {
        "id": "EC-121",
        "titleEn": "Beneficial owner edited after submit",
        "titleAr": "تعديل المالك المستفيد بعد الإرسال",
        "descriptionEn": "Adding or editing a beneficial owner after submission triggers new screening, invalidates pending approval, and returns to IN_REVIEW.",
        "descriptionAr": "إضافة أو تعديل مالك مستفيد بعد الإرسال يطلق فحصاً جديداً ويبطل الموافقة المعلقة ويعيد إلى IN_REVIEW.",
        "tags": [
            "ec-121",
            "beneficial",
            "owner",
            "edited",
            "after",
            "submit"
        ]
    },
    {
        "id": "EC-122",
        "titleEn": "Canonical edge case EC-122",
        "titleAr": "الحالة الطرفية القياسية EC-122",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-122 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-122 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-122",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-123",
        "titleEn": "Canonical edge case EC-123",
        "titleAr": "الحالة الطرفية القياسية EC-123",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-123 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-123 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-123",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-124",
        "titleEn": "Screening provider outage",
        "titleAr": "انقطاع مزوّد الفحص",
        "descriptionEn": "An ERROR screening result fails closed with 503 SCREENING_UNAVAILABLE, keeps IN_REVIEW, pauses SLA with PROVIDER_OUTAGE, and retries with backoff.",
        "descriptionAr": "نتيجة فحص ERROR تفشل مغلقة بـ 503 SCREENING_UNAVAILABLE وتبقي IN_REVIEW وتوقف SLA بـ PROVIDER_OUTAGE وتعيد المحاولة بتراجع.",
        "tags": [
            "ec-124",
            "screening",
            "provider",
            "outage"
        ]
    },
    {
        "id": "EC-125",
        "titleEn": "Structuring across links and apps",
        "titleAr": "التجزئة عبر الروابط والتطبيقات",
        "descriptionEn": "AmlRuleEngine aggregates volume by subject across all links, applications, and rails within the rolling window.",
        "descriptionAr": "يجمع AmlRuleEngine الحجم حسب الموضوع عبر كل الروابط والتطبيقات والسكك ضمن النافذة المتدحرجة.",
        "tags": [
            "ec-125",
            "structuring",
            "across",
            "links",
            "apps"
        ]
    },
    {
        "id": "EC-126",
        "titleEn": "Chargeback after partial refund",
        "titleAr": "استرداد عكسي بعد استرداد جزئي",
        "descriptionEn": "The chargeback draft is capped to settled_amount minus executed refunds.",
        "descriptionAr": "تُحدد مسودة الاسترداد العكسي بسقف settled_amount ناقص الاستردادات المنفذة.",
        "tags": [
            "ec-126",
            "chargeback",
            "after",
            "partial",
            "refund"
        ]
    },
    {
        "id": "EC-127",
        "titleEn": "Emergency ratification timeout",
        "titleAr": "انتهاء مهلة التصديق الطارئ",
        "descriptionEn": "An unratified emergency suspension raises a P2 alert and the merchant stays SUSPENDED (fail-safe).",
        "descriptionAr": "التعليق الطارئ غير المصدق يطلق تنبيه P2 ويبقى التاجر SUSPENDED (فشل آمن).",
        "tags": [
            "ec-127",
            "emergency",
            "ratification",
            "timeout"
        ]
    },
    {
        "id": "EC-128",
        "titleEn": "Canonical edge case EC-128",
        "titleAr": "الحالة الطرفية القياسية EC-128",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-128 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-128 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-128",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-129",
        "titleEn": "Canonical edge case EC-129",
        "titleAr": "الحالة الطرفية القياسية EC-129",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-129 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-129 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-129",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-130",
        "titleEn": "Canonical edge case EC-130",
        "titleAr": "الحالة الطرفية القياسية EC-130",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-130 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-130 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-130",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-131",
        "titleEn": "Canonical edge case EC-131",
        "titleAr": "الحالة الطرفية القياسية EC-131",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-131 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-131 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-131",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-132",
        "titleEn": "Canonical edge case EC-132",
        "titleAr": "الحالة الطرفية القياسية EC-132",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-132 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-132 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-132",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-133",
        "titleEn": "Canonical edge case EC-133",
        "titleAr": "الحالة الطرفية القياسية EC-133",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-133 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-133 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-133",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-134",
        "titleEn": "Self-payment on NeomPay",
        "titleAr": "الدفع الذاتي على NeomPay",
        "descriptionEn": "SELF_PAYMENT_POLICY = BLOCK rejects a payer wallet belonging to the same legal entity as the merchant with SELF_PAYMENT_NOT_ALLOWED.",
        "descriptionAr": "SELF_PAYMENT_POLICY = BLOCK يرفض محفظة دافع تتبع نفس الكيان القانوني للتاجر بـ SELF_PAYMENT_NOT_ALLOWED.",
        "tags": [
            "ec-134",
            "self-payment",
            "neompay"
        ]
    },
    {
        "id": "EC-135",
        "titleEn": "Canonical edge case EC-135",
        "titleAr": "الحالة الطرفية القياسية EC-135",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-135 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-135 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-135",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-136",
        "titleEn": "Canonical edge case EC-136",
        "titleAr": "الحالة الطرفية القياسية EC-136",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-136 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-136 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-136",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-137",
        "titleEn": "Canonical edge case EC-137",
        "titleAr": "الحالة الطرفية القياسية EC-137",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-137 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-137 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-137",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-138",
        "titleEn": "Canonical edge case EC-138",
        "titleAr": "الحالة الطرفية القياسية EC-138",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-138 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-138 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-138",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-139",
        "titleEn": "Canonical edge case EC-139",
        "titleAr": "الحالة الطرفية القياسية EC-139",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-139 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-139 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-139",
            "edge",
            "case"
        ]
    },
    {
        "id": "EC-140",
        "titleEn": "Canonical edge case EC-140",
        "titleAr": "الحالة الطرفية القياسية EC-140",
        "descriptionEn": "Documented in the platform's canonical 140-case registry. Search by EC-140 during incident review and cite the id in the operator case.",
        "descriptionAr": "موثقة في سجل الحالات الطرفية القياسي ذي 140 حالة. ابحث بـ EC-140 أثناء مراجعة الحادث واذكر المعرّف في حالة المشغّل.",
        "tags": [
            "ec-140",
            "edge",
            "case"
        ]
    }
];

export const ERROR_CODE_GLOSSARY: GlossaryEntry[] = [
    {
        "code": "RETRYABLE_OTP",
        "meaningEn": "The one-time password was wrong or expired, but the attempt is still live and the customer may retry within the allowed window.",
        "meaningAr": "رمز لمرة واحدة خاطئ أو منتهٍ، لكن المحاولة ما زالت حية ويمكن للعميل إعادة المحاولة ضمن النافذة المسموحة."
    },
    {
        "code": "LIMIT_EXCEEDED",
        "meaningEn": "A configured amount, velocity, or count limit blocked the operation. Do not retry until the limit or the period changes.",
        "meaningAr": "حد مبلغ أو سرعة أو عدد محدد في الإعداد منع العملية. لا تعد المحاولة حتى يتغير الحد أو الفترة."
    },
    {
        "code": "GATEWAY_FAULT",
        "meaningEn": "The edge or the provider failed before a business outcome was established. The attempt may be UNKNOWN; investigate before retrying.",
        "meaningAr": "فشل الحافة أو المزوّد قبل إثبات نتيجة عمل. قد تكون المحاولة UNKNOWN؛ تحقق قبل إعادة المحاولة."
    },
    {
        "code": "AMBIGUOUS",
        "meaningEn": "The provider response cannot be interpreted safely. Treat as UNKNOWN and resolve by inquiry, signed callback, or statement.",
        "meaningAr": "استجابة المزوّد لا يمكن تفسيرها بأمان. تعامل معها كـ UNKNOWN وحلها بالاستعلام أو الاستدعاء الموقّع أو الكشف."
    },
    {
        "code": "TERMINAL_DECLINE",
        "meaningEn": "A definitive decline that must not be retried automatically. The customer needs a different instrument or a new journey.",
        "meaningAr": "رفض قاطع لا يجوز إعادة محاولته تلقائياً. يحتاج العميل أداة مختلفة أو رحلة جديدة."
    }
];
