export type GuideChapter = {
    id: string;
    book: number;
    titleEn: string;
    titleAr: string;
    tags: string[];
    bodyEn: string;
    bodyAr: string;
};

export type GlossaryEntry = {
    code: string;
    meaningEn: string;
    meaningAr: string;
};

export const GUIDE_CHAPTERS: GuideChapter[] = [
    {
        id: "architecture",
        book: 1,
        titleEn: "System architecture and the seven-service zero-trust model",
        titleAr: "هندسة النظام ونموذج الثقة الصفرية بين الخدمات السبع",
        tags: ["architecture", "core-back", "edge", "mtls", "zero-trust", "services", "security"],
        bodyEn: `The platform is deliberately split into seven cooperating services so that a compromise, outage, or bad release in one tier cannot silently corrupt money or customer data. The core-back service owns the database, the ledger, approvals, and the canonical attempt state machine. The edge tiers own protocol adaptation only: they translate an operator's HTTP, form, SOAP, or XML dialect into the platform's internal contract and translate the answer back. No edge service has a database connection, and no edge service is allowed to decide that a payment succeeded on its own.

Every internal call is mutually authenticated with mTLS. Workload identities are short-lived certificates issued by the platform's internal certificate authority, and a service accepts a request only when the certificate identity, the audience, and the operation scope all match. There is no shared "internal" network that is trusted by default. A request that reaches a service without a valid peer certificate is rejected before business logic runs, even if it originated inside the cluster.

The edge tier is intentionally disposable. It holds configuration, compiled gateway versions, credential material fetched from a secrets broker, and request-scoped state. If the edge loses its connection to the core, it must fail closed for money-moving calls and record enough evidence for a later inquiry. The core remains the source of truth for balances, attempts, and approvals. This is why a restart of an edge pod is an operational non-event: it cannot lose the ledger, because it never had the ledger.

The practical consequence for an admin is simple. When something looks wrong, first identify which tier is reporting it. A schema or UI validation message is a wizard concern. A transport error, timeout, or signature rejection is an edge concern. A duplicate posting, an unbalanced journal, or a stuck state is a core concern and must be handled with the ledger and attempt tools, not by editing gateway configuration.`,
        bodyAr: `المنصة مقسّمة عمداً إلى سبع خدمات متعاونة حتى لا يؤدي اختراق أو انقطاع أو إصدار سيئ في طبقة واحدة إلى إفساد الأموال أو بيانات العملاء بصمت. خدمة core-back تملك قاعدة البيانات والدفتر المحاسبي والموافقات وآلة حالات المحاولة المرجعية. أما طبقات الحافة فهي مسؤولة عن التكيّف مع البروتوكولات فقط: تحوّل HTTP أو النماذج أو SOAP أو XML إلى عقد المنصة الداخلي، ثم تعيد ترجمة الرد. لا تملك أي خدمة حافة اتصالاً بقاعدة البيانات، ولا يُسمح لها بأن تقرر بمفردها أن الدفع نجح.

كل استدعاء داخلي مُصادق عليه بشكل متبادل عبر mTLS. هويات الأحمال شهادات قصيرة العمر يصدرها مركز الشهادات الداخلي، والخدمة لا تقبل الطلب إلا إذا تطابقت هوية الشهادة والجمهور والنطاق التشغيلي. لا توجد شبكة داخلية موثوقة تلقائياً. أي طلب يصل دون شهادة نظير صالحة يُرفض قبل تنفيذ منطق العمل حتى لو جاء من داخل العنقود.

طبقة الحافة قابلة للاستبدال بطبيعتها. تحتفظ بالإعدادات وإصدارات البوابات المترجمة ومواد الاعتماد من وسيط الأسرار وحالة الطلب المؤقتة. إذا فقدت الحافة اتصالها بالنواة وجب عليها الفشل المغلق للعمليات المالية وتسجيل أدلة كافية للاستعلام لاحقاً. تبقى النواة المصدر الوحيد للحقيقة في الأرصدة والمحاولات والموافقات. لذلك فإن إعادة تشغيل حاوية الحافة حدث تشغيلي عادي، لأنها لم تكن تحتفظ بالدفتر أصلاً.

النتيجة العملية للمشرف بسيطة. عند وجود خلل، حدّد أولاً الطبقة التي أبلغت عنه. رسالة تحقق أو مخطط هي شأن معالج الإعداد. خطأ نقل أو مهلة أو رفض توقيع هو شأن الحافة. القيد المزدوج أو اختلال القيد أو الحالة المعلّقة شأن النواة ويجب معالجته بأدوات الدفتر والمحاولة، لا بتعديل إعدادات البوابة.`,
    },
    {
        id: "catalog",
        book: 2,
        titleEn: "The four-layer catalog and the visible-rails formula",
        titleAr: "الكتالوج الرباعي وصيغة السكك المرئية",
        tags: ["catalog", "gateway", "credential-set", "rail", "rail-route", "visible-rails", "routing"],
        bodyEn: `The catalog has four layers. A Gateway is the operator and commercial relationship. A CredentialSet is a scoped bundle of environment, authentication, and secrets for that gateway. A Rail is a payment instrument or scheme capability, such as a domestic card switch, a mobile wallet, or a bank transfer. A RailRoute joins a gateway, a credential set, and a rail into an executable path with its own priority, limits, currencies, and maintenance state.

The gateway is not the same thing as a rail. One gateway can expose several rails, and the same rail can be offered through several gateways. Credential sets exist so that production, sandbox, and a second acquiring relationship can be rotated independently without cloning the whole gateway definition. The route is the only object the routing engine actually executes.

The visible-rails formula is a set intersection, not a list copy. Start with all routes that support the requested currency, country, amount, and instrument capability. Intersect with routes whose credential set is active and verified, whose gateway is not suspended, whose route is not in maintenance, and whose merchant contract allows the rail. Remove routes that violate amount bounds, velocity limits, or scheme participation rules. The remaining set is ordered by priority, success-rate guard, and cost, and only then returned to the merchant.

Operators should treat an empty visible-rails response as a diagnosis, not an error. Check each intersection term in order: currency support, country, amount bounds, credential activation, gateway status, route maintenance, merchant entitlement, and finally the routing guard. The catalog screen in the gateway wizard shows the same layers, so a missing rail can usually be traced to one disabled or unverified layer rather than to the routing engine itself.`,
        bodyAr: `يتكوّن الكتالوج من أربع طبقات. البوابة هي المشغّل والعلاقة التجارية. مجموعة الاعتماد هي حزمة محددة النطاق من البيئة والمصادقة والأسرار لتلك البوابة. السكة هي قدرة أداة دفع أو مخطط، مثل شبكة بطاقات محلية أو محفظة هاتفية أو تحويل بنكي. مسار السكة يربط بوابة ومجموعة اعتماد وسكة في مسار قابل للتنفيذ له أولوية وحدود وعملات وحالة صيانة مستقلة.

البوابة ليست السكة. يمكن لبوابة واحدة أن تعرض عدة سكك، ويمكن للسكة نفسها أن تُعرض عبر عدة بوابات. مجموعات الاعتماد موجودة كي يُدار تدوير الإنتاج والاختبار وعلاقة استحواذ ثانية بشكل مستقل دون نسخ تعريف البوابة بالكامل. المسار هو الكائن الوحيد الذي ينفذه محرك التوجيه فعلياً.

صيغة السكك المرئية هي تقاطع مجموعات وليست نسخاً لقائمة. ابدأ بكل المسارات التي تدعم العملة والبلد والمبلغ وقدرة الأداة المطلوبة. ثم اقتصر على المسارات التي مجموعتها نشطة وموثقة، وبوابتها غير موقوفة، ومسارها خارج الصيانة، وعقد التاجر يسمح بالسكة. أزل المسارات التي تخالف حدود المبلغ أو حدود السرعة أو قواعد المشاركة في المخطط. المجموعة المتبقية تُرتّب حسب الأولوية وحارس معدل النجاح والتكلفة، ثم تُعاد للتاجر فقط.

على المشغّل أن يعتبر استجابة السكك المرئية الفارغة تشخيصاً لا خطأً. افحص كل حد من حدود التقاطع بالترتيب: دعم العملة، البلد، حدود المبلغ، تنشيط الاعتماد، حالة البوابة، صيانة المسار، استحقاق التاجر، وأخيراً حارس التوجيه. تعرض شاشة الكتالوج في معالج البوابة الطبقات نفسها، لذا غالباً ما يُعزى غياب السكة إلى طبقة معطلة أو غير موثقة لا إلى محرك التوجيه.`,
    },
    {
        id: "wizard",
        book: 3,
        titleEn: "The eight-step gateway wizard and the Smart AI spec importer",
        titleAr: "معالج البوابة ذو الخطوات الثماني ومستورد المواصفات الذكي",
        tags: ["wizard", "gateway", "ai-import", "spec", "flow-builder", "approval", "onboarding"],
        bodyEn: `The wizard is an eight-step contract, not a formality. Step one captures identity and basics. Step two defines environments and authentication. Step three builds the customer catalog: currencies, countries, payment methods, and rails. Step four defines crypto profiles and canonicalization. Step five builds the request and response flow. Step six defines client action and confirmation channels. Step seven configures status rules, error maps, and cost model. Step eight runs the simulator and submits for approval.

Each step produces a versioned artifact. Nothing becomes live because a field was saved. A gateway version moves through DRAFT, VALIDATED, PENDING_APPROVAL, ACTIVE, and RETIRED. The simulator is the gate where the operator proves that a known request produces the expected canonical string, the expected outbound call, and the expected internal status. Only after the simulator passes should the version be submitted to the four-eyes approval queue.

The Smart AI spec importer is an accelerator, not an authority. It accepts a provider specification, extracts endpoints, authentication, field mappings, status codes, and error semantics, and proposes a draft gateway version. It also generates verification vectors and a transcript so a human can see exactly what it inferred. The importer never publishes a version and never bypasses approval. Low-confidence extractions are flagged for manual review.

When the importer disagrees with the wizard, the wizard wins. The operator must confirm field mappings, amount pipelines, signature algorithms, and confirmation channels manually. A spec that mentions a return URL or a browser callback is evidence of a channel, not proof that the callback is trustworthy. Use the importer to remove typing work, then use the simulator and approval process to establish correctness.`,
        bodyAr: `المعالج عقد من ثماني خطوات وليس إجراءً شكلياً. الخطوة الأولى تلتقط الهوية والأساسيات. الثانية تحدد البيئات والمصادقة. الثالثة تبني كتالوج العميل: العملات والبلدان وطرق الدفع والسكك. الرابعة تعرّف ملفات التشفير وطريقة التوحيد القياسي. الخامسة تبني تدفق الطلب والاستجابة. السادسة تحدد إجراء العميل وقنوات التأكيد. السابعة تضبط قواعد الحالة وخرائط الأخطاء ونموذج التكلفة. الثامنة تشغّل المحاكي وتقدّم للموافقة.

كل خطوة تنتج أصلاً مُصدّراً بإصدار. لا شيء يصبح فعالاً بمجرد حفظ حقل. ينتقل إصدار البوابة بين DRAFT وVALIDATED وPENDING_APPROVAL وACTIVE وRETIRED. المحاكي هو البوابة التي يثبت فيها المشغّل أن طلباً معروفاً ينتج السلسلة القياسية المتوقعة والاستدعاء الخارجي المتوقع والحالة الداخلية المتوقعة. وبعد نجاح المحاكي فقط يُقدّم الإصدار إلى طابور الموافقة رباعي العيون.

مستورد المواصفات الذكي مسرّع وليس سلطة. يستقبل مواصفة المزوّد ويستخرج نقاط النهاية والمصادقة وربط الحقول وأكواد الحالة ودلالات الأخطاء، ثم يقترح مسودة إصدار بوابة. كما يولّد متجهات تحقق وسجلاً يرى فيه الإنسان ما استنتجه بالضبط. لا ينشر المستورد أي إصدار ولا يتجاوز الموافقة. الاستخراجات منخفضة الثقة تُعلَّم للمراجعة اليدوية.

عند تعارض المستورد مع المعالج، يحكم المعالج. على المشغّل تأكيد ربط الحقول وخطوط المبلغ وخوارزميات التوقيع وقنوات التأكيد يدوياً. ذكر المواصفة لعنوان عودة أو استدعاء متصفح هو دليل على وجود قناة، وليس دليلاً على أن الاستدعاء موثوق. استخدم المستورد لتقليل العمل اليدوي، ثم استخدم المحاكي والموافقة لإثبات الصحة.`,
    },
    {
        id: "collection",
        book: 4,
        titleEn: "Collection modes and confirmation channels",
        titleAr: "أنماط التحصيل وقنوات التأكيد",
        tags: ["collection", "confirmation", "callback", "return-url", "webhook", "polling", "channels"],
        bodyEn: `A collection mode describes how the customer is asked to pay. A confirmation channel describes how the platform learns the truth. They are related but not identical. A redirect collection can be confirmed by a signed webhook, by an active status inquiry, or by reconciliation; a browser return URL is never sufficient proof on its own.

Browser callbacks and return URLs are untrusted input. They are controlled by the customer's browser and can be replayed, forged, delayed, or simply never arrive. They are useful for user experience: they let the page show a spinner or a receipt. They are not useful for posting money. The rules are simple: never move a balance because a browser said so, never trust query parameters as a confirmation, and never treat a missing return as a failure.

Confirmation must come from a server-to-server signed callback, from an authenticated status inquiry whose response is bound to the original external reference, or from a formal reconciliation statement. The webhook inbox stores the raw payload, verifies the signature against the credential set, de-duplicates by provider event id, and only then hands the event to the core. Unknown event ids and signature mismatches go to the operator queue, not to the ledger.

Collection modes are chosen per rail and per merchant journey. Hosted redirect is common for cards and wallets, form post is used by older switches, QR is common for wallet and instant transfer, and direct API is used when the merchant's own checkout collects the instrument. Each mode carries a different timeout policy and a different fallback inquiry strategy. The gateway wizard records both the mode and the allowed confirmation channels so the operator can see why a given attempt is waiting, polling, or already terminal.`,
        bodyAr: `نمط التحصيل يصف كيف يُطلب من العميل الدفع. وقناة التأكيد تصف كيف تعرف المنصة الحقيقة. هما مرتبطان لكنهما ليسا الشيء نفسه. يمكن تأكيد تحصيل إعادة التوجيه عبر استدعاء خادم موقّع أو استعلام حالة نشط أو مطابقة كشف، أما عنوان العودة في المتصفح فليس دليلاً كافياً وحده أبداً.

استدعاءات المتصفح وعناوين العودة مدخلات غير موثوقة. يتحكم فيها متصفح العميل ويمكن إعادة تشغيلها أو تزويرها أو تأخيرها أو عدم وصولها أصلاً. هي مفيدة لتجربة المستخدم لعرض مؤشر أو إيصال، لكنها غير مفيدة لقيد الأموال. القواعد بسيطة: لا تحرّك رصيداً لأن المتصفح قال ذلك، ولا تثق بمعاملات الرابط كتأكيد، ولا تعتبر غياب العودة فشلاً.

يجب أن يأتي التأكيد من استدعاء خادم موقّع، أو استعلام حالة موثق مرتبط بالمرجع الخارجي الأصلي، أو كشف مطابقة رسمي. يخزّن صندوق الاستدعاءات الحمولة الخام ويتحقق من التوقيع مقابل مجموعة الاعتماد ويزيل التكرار بمعرّف حدث المزوّد، ثم يسلّم الحدث للنواة فقط. معرّفات الأحداث المجهولة وعدم تطابق التوقيع تذهب لطابور المشغّل لا للدفتر.

تُختار أنماط التحصيل لكل سكة ولكل رحلة تاجر. إعادة التوجيه المستضافة شائعة للبطاقات والمحافظ، ونشر النماذج تُستخدمه المقاسم الأقدم، ورمز QR شائع للمحافظ والتحويل الفوري، وواجهة API المباشرة تُستخدم عندما يجمع متجر التاجر الأداة بنفسه. لكل نمط مهلة وسياسة استعلام بديل مختلفة. يسجّل معالج البوابة النمط وقنوات التأكيد المسموحة حتى يرى المشغّل سبب انتظار محاولة أو استقصائها أو انتهائها.`,
    },
    {
        id: "lifecycle",
        book: 5,
        titleEn: "The thirteen-state lifecycle, slot reservation, and UNKNOWN",
        titleAr: "دورة الحياة ذات الحالات الثلاث عشرة وحجز الخانات ومعالجة UNKNOWN",
        tags: ["attempt", "lifecycle", "states", "unknown", "slot", "active-locked-count", "inquiry"],
        bodyEn: `An attempt moves through thirteen canonical states. CREATED exists before any external call. RESERVED means a capacity slot and a ledger promise exist. DISPATCHED means the edge has transmitted or is transmitting the request. PENDING_CUSTOMER means the customer must still act. AUTHORIZED means the provider approved but capture is not final. CAPTURED means funds are captured but not yet confirmed by the platform. CONFIRMED means the core accepted the money movement. SETTLED means the settlement leg has completed. FAILED, DECLINED, EXPIRED, and CANCELLED are terminal negative states. UNKNOWN is a deliberate state: the platform does not know, and it refuses to guess.

Slot reservation is how the platform prevents overbooking. Each route and currency can define a maximum number of in-flight attempts. On RESERVED, active_locked_count is incremented atomically. On every terminal state, and only on a terminal state, it is decremented. An UNKNOWN attempt keeps its slot because it may still be live at the provider. This is not a leak; it is the correct conservative behavior. Resolving UNKNOWN is how the slot is released.

UNKNOWN must be resolved by evidence, never by a blind retry. Use the inquiry action with the original external reference and the provider's idempotency key. If the inquiry returns a definitive success or failure, transition the attempt and release the slot. If the inquiry is inconclusive, wait for the signed callback or the statement, and escalate to an operator case before the configured deadline. Retrying an ambiguous charge creates a second real payment.

The attempt screen should be read together with the ledger entry and the reserved slot. A CONFIRMED attempt without a posted journal is a core incident. A terminal attempt with active_locked_count still above zero is a counter bug. An UNKNOWN older than its policy threshold is an operational breach. The dashboard exposes the UNKNOWN backlog and the oldest age precisely so these conditions are visible before reconciliation.`,
        bodyAr: `تمر المحاولة بثلاث عشرة حالة مرجعية. CREATED قبل أي استدعاء خارجي. RESERVED تعني وجود خانة سعة ووعد محاسبي. DISPATCHED تعني أن الحافة أرسلت الطلب أو ترسله. PENDING_CUSTOMER تعني أن العميل ما زال مطالباً بالتصرف. AUTHORIZED تعني موافقة المزوّد دون اكتمال الالتقاط. CAPTURED تعني التقاط الأموال دون تأكيد المنصة بعد. CONFIRMED تعني قبول النواة لحركة المال. SETTLED تعني اكتمال التسوية. FAILED وDECLINED وEXPIRED وCANCELLED حالات سلبية نهائية. أما UNKNOWN فهي حالة متعمدة: المنصة لا تعرف وترفظ التخمين.

حجز الخانات هو وسيلة منع تجاوز السعة. يمكن لكل مسار وعملة تحديد أقصى عدد محاولات قيد التنفيذ. عند RESERVED يزداد active_locked_count ذرياً. وعند كل حالة نهائية فقط يتراجع. المحاولة UNKNOWN تحتفظ بخانتها لأنها قد تكون حية عند المزوّد. هذا ليس تسريباً بل السلوك المحافظ الصحيح، وحل UNKNOWN هو ما يحرر الخانة.

يجب حل UNKNOWN بالدليل لا بإعادة محاولة عمياء. استخدم إجراء الاستعلام بالمرجع الخارجي الأصلي ومفتاح منع التكرار لدى المزوّد. إذا أعاد الاستعلام نجاحاً أو فشلاً قاطعاً فانتقل بالمحاولة وحرر الخانة. إذا كان غير حاسم فانتظر الاستدعاء الموقّع أو الكشف، وصعّد إلى حالة مشغّل قبل المهلة المحددة. إعادة محاولة تحصيل غامض تنشئ دفعة حقيقية ثانية.

تُقرأ شاشة المحاولة مع قيد الدفتر والخانة المحجوزة. محاولة CONFIRMED دون قيد محاسبي حادث نواة. محاولة نهائية مع active_locked_count أكبر من صفر خلل عدّاد. محاولة UNKNOWN أقدم من حد سياستها خرق تشغيلي. تعرض لوحة المعلومات تراكم UNKNOWN وأقدم عمر تحديداً لإظهار هذه الحالات قبل المطابقة.`,
    },
    {
        id: "ledger",
        book: 6,
        titleEn: "Ownership-aware double-entry accounting and reconciliation",
        titleAr: "المحاسبة المزدوجة الواعية بالملكية والمطابقة",
        tags: ["ledger", "double-entry", "clearing", "fee-bearer", "reconciliation", "settlement", "ownership"],
        bodyEn: `Every money movement is a balanced journal entry. There is no "update the merchant balance" shortcut. A customer payment creates a debit to a clearing or cash account and a credit to a merchant payable or receivable account. A fee creates a debit to whoever bears the fee and a credit to fee revenue. A settlement sweep moves the funds from clearing to the platform bank account. A refund reverses the original entry. If debits and credits do not match to the minor unit, the transaction is rejected.

Ownership-aware means each entry carries the merchant, gateway, route, currency, and environment that produced it. This lets finance answer questions that a single aggregate balance cannot: which gateway is short, which merchant is owed, which environment created the test posting. Clearing accounts are segregated by gateway, environment, and currency so that a statement can be matched against one clearing pool without mixing sandbox data into production.

A fee bearer defines who pays. CUSTOMER means the payer is charged a surcharge on top of the amount. MERCHANT means the fee is deducted from the merchant's receivable. PLATFORM means the platform absorbs the cost and recognizes it as an expense or a reduction of revenue. The bearer must be explicit on every commission rule; defaulting silently is how disputes start.

Reconciliation compares a provider statement line with the platform's attempt and ledger entry. The match uses the external reference, amount, currency, value date, and a configurable date window. A matched line closes the loop. A fee variance posts the difference to a variance account and keeps the principal matched. An unmatched platform entry becomes an exception; an unmatched statement line becomes a suspense item. Never force a match by editing the statement amount.`,
        bodyAr: `كل حركة مال قيد محاسبي متوازن. لا يوجد اختصار «حدّث رصيد التاجر». دفعة العميل تنشئ مديناً لحساب مقاصة أو نقد ومديناً دائناً لحساب مستحق أو مدين للتاجر. الرسم ينشئ مديناً على من يتحمل الرسم ودائناً لإيراد الرسوم. مسح التسوية ينقل الأموال من المقاصة إلى حساب بنك المنصة. الاسترداد يعكس القيد الأصلي. إذا لم يتطابق المدين والدائن حتى أصغر وحدة نقدية يُرفض القيد.

الوعي بالملكية يعني أن كل قيد يحمل التاجر والبوابة والمسار والعملة والبيئة التي أنتجته. هذا يتيح للمالية الإجابة على أسئلة لا يجيبها رصيد مجمّع واحد: أي بوابة ناقصة، أي تاجر مستحق، أي بيئة أنشأت قيد الاختبار. تُفصل حسابات المقاصة حسب البوابة والبيئة والعملة حتى يُطابق الكشف مع بركة مقاصة واحدة دون خلط بيانات الاختبار بالإنتاج.

متحمل الرسم يحدد من يدفع. CUSTOMER يعني تحصيل إضافة من الدافع فوق المبلغ. MERCHANT يعني خصم الرسم من مستحق التاجر. PLATFORM يعني أن المنصة تتحمل التكلفة وتعترف بها مصروفاً أو تخفيضاً للإيراد. يجب أن يكون المتحمل صريحاً في كل قاعدة عمولة؛ الصمت الافتراضي هو بداية النزاعات.

تقارن المطابقة سطر كشف المزوّد مع محاولة المنصة وقيدها. يستخدم المطابقة المرجع الخارجي والمبلغ والعملة وتاريخ القيمة ونافذة زمنية قابلة للضبط. السطر المطابق يغلق الحلقة. فرق الرسم يُقيّد في حساب فروق ويبقى الأصل مطابقاً. القيد غير المطابق يصبح استثناءً، وسطر الكشف غير المطابق يصبح بنداً معلقاً. لا تفرض المطابقة بتعديل مبلغ الكشف.`,
    },
    {
        id: "onboarding",
        book: 7,
        titleEn: "Merchant onboarding, KYB, duplicate detection, and four-eyes",
        titleAr: "تأهيل التجار والتحقق من النشاط وكشف التكرار ومبدأ العيون الأربع",
        tags: ["onboarding", "kyb", "merchant", "duplicate", "four-eyes", "compliance", "approval"],
        bodyEn: `Onboarding begins with a join request, not with a merchant record. The applicant supplies legal identity, ownership, bank details, expected volumes, and the commercial contact. KYB then verifies the legal entity, beneficial owners, licenses, and bank account ownership. A join request can be returned for information, rejected with a reason, or approved into a merchant. Nothing is approved silently.

Duplicate detection runs before approval. The platform normalizes names, commercial registration numbers, tax identifiers, bank accounts, phone numbers, and addresses, then compares them against existing merchants and open applications. An exact bank account or registration match is a hard stop. A fuzzy name match is a review flag, not an automatic rejection. The reviewer must record why the duplicate is or is not the same entity.

Four-eyes governance means the person who proposes a sensitive change cannot be the person who approves it. This applies to gateway activation, commission and fee-bearer changes, limit increases, bank detail changes, refunds above threshold, cash-out approvals, and manual ledger adjustments. The maker submits a payload and a reason; the checker sees the diff, the base version, and the reason, and approves or rejects independently.

The admin portal should be operated as if every approval is auditable. A rejected proposal is still evidence. A changed bank account requires fresh proof of ownership. A limit increase requires a risk rationale. If an approver is unavailable, escalate to another authorized approver; never share credentials and never approve your own proposal. The approval queue ageing metric exists to make stale four-eyes decisions visible.`,
        bodyAr: `يبدأ التأهيل بطلب انضمام لا بسجل تاجر. يقدّم مقدم الطلب الهوية القانونية والملكية وبيانات البنك والأحجام المتوقعة وجهة الاتصال التجارية. ثم يتحقق KYB من الكيان القانوني والمستفيدين الحقيقيين والتراخيص وملكية الحساب البنكي. يمكن إعادة طلب الانضمام لطلب معلومات أو رفضه بسبب أو تحويله إلى تاجر. لا تتم أي موافقة بصمت.

يعمل كشف التكرار قبل الموافقة. تطبّع المنصة الأسماء وأرقام السجل التجاري والمعرّفات الضريبية والحسابات البنكية وأرقام الهواتف والعناوين، ثم تقارنها بالتجار الحاليين والطلبات المفتوحة. تطابق الحساب البنكي أو السجل تطابقاً تاماً يوقف الإجراء. تشابه الاسم مؤشر مراجعة لا رفضاً تلقائياً. يجب أن يسجل المراجع سبب اعتبار التكرار نفس الكيان أو لا.

مبدأ العيون الأربع يعني أن من يقترح تغييراً حساساً لا يمكن أن يكون من يوافق عليه. ينطبق ذلك على تنشيط البوابة وتغيير العمولة ومتحمل الرسم ورفع الحدود وتغيير بيانات البنك والاستردادات فوق حد معين وموافقات السحب النقدي والتعديلات اليدوية للدفتر. يقدّم المنشئ الحمولة والسبب، ويرى المدقق الفرق والإصدار الأساسي والسبب ثم يوافق أو يرفض باستقلال.

يجب تشغيل بوابة الإدارة كما لو أن كل موافقة قابلة للتدقيق. الاقتراح المرفوض دليل أيضاً. تغيير الحساب البنكي يتطلب إثبات ملكية جديداً. رفع الحد يتطلب مبرراً مخاطرياً. إذا لم يتوفر موافق فصعّد إلى موافق مخوّل آخر؛ لا تشارك بيانات الدخول ولا توافق على اقتراحك. مؤشر عمر طابور الموافقات موجود لإظهار قرارات العيون الأربع المتأخرة.`,
    },
    {
        id: "aml",
        book: 8,
        titleEn: "The seven-layer AML program and reporting",
        titleAr: "برنامج مكافحة غسل الأموال ذو الطبقات السبع والإبلاغ",
        tags: ["aml", "screening", "sanctions", "pep", "velocity", "tipping-off", "cbl", "reporting"],
        bodyEn: `The AML program has seven layers. Layer one is customer due diligence and enhanced due diligence at onboarding. Layer two is sanctions, PEP, and adverse-media screening. Layer three is transaction monitoring against scenarios such as structuring, rapid pass-through, and unusual counterparties. Layer four is velocity and limit rules. Layer five is risk scoring and segmentation. Layer six is case management, investigation, and suspicious transaction reporting. Layer seven is governance, independent testing, and audit trails.

Screening produces candidates, not verdicts. Every candidate needs a disposition: TRUE_MATCH, FALSE_POSITIVE, ESCALATED, or PENDING. A TRUE_MATCH stops onboarding or blocks the relationship and is escalated. A FALSE_POSITIVE must record the discriminating evidence, such as date of birth, nationality, or document number. PENDING has a deadline. Dispositions are four-eyes controlled where the policy requires it, and the audit trail must preserve the original match, the reviewer, and the reason.

No-tipping-off is an absolute operating rule. If a case is under investigation or a report is being prepared, the customer must not be told that a suspicious activity report exists or that they are under suspicion. Support scripts must use neutral language. Do not send internal case notes, screening reasons, or SAR references in merchant-facing messages, emails, or call notes.

CBL reporting is the regulated output. The platform produces the report from the case file, preserves the submission reference, and records the reporting decision even when the decision is not to report. Reports are confidential and access is restricted to compliance and MLRO roles. A report must never be edited after submission; corrections are new, linked records. Aml reports, case ageing, and screening backlogs are visible on the dashboard so SLA breaches are caught before an examiner finds them.`,
        bodyAr: `يتكون برنامج مكافحة غسل الأموال من سبع طبقات. الأولى العناية الواجبة بالعميل والعناية المعززة عند التأهيل. الثانية فحص العقوبات والأشخاص السياسيين والإعلام السلبي. الثالثة مراقبة المعاملات مقابل سيناريوهات مثل التجزئة والمرور السريع والأطراف غير المعتادة. الرابعة قواعد السرعة والحدود. الخامسة تقييم المخاطر والتقسيم. السادسة إدارة الحالات والتحقيق والإبلاغ عن المعاملات المشبوهة. السابعة الحوكمة والاختبار المستقل ومسارات التدقيق.

ينتج الفحص مرشحين لا أحكاماً. كل مرشح يحتاج تصنيفاً: TRUE_MATCH أو FALSE_POSITIVE أو ESCALATED أو PENDING. التطابق الحقيقي يوقف التأهيل أو يحجب العلاقة ويُصعّد. التطابق الخاطئ يجب أن يسجل الدليل الفاصل مثل تاريخ الميلاد أو الجنسية أو رقم الوثيقة. المعلّق له مهلة. التصنيفات تخضع للعيون الأربع حيث تتطلب السياسة، ويجب أن يحفظ مسار التدقيق التطابق الأصلي والمراجع والسبب.

عدم الإفصاح مبدأ تشغيلي مطلق. إذا كانت الحالة قيد التحقيق أو يُعدّ تقرير فلا يجوز إخبار العميل بوجود تقرير نشاط مشبوه أو أنه موضع شك. يجب أن تستخدم نصوص الدعم لغة محايدة. لا ترسل ملاحظات الحالة الداخلية أو أسباب الفحص أو مراجع التقارير في رسائل التاجر أو البريد أو ملاحظات المكالمات.

إبلاغ المصرف المركزي هو المخرج التنظيمي. تنتج المنصة التقرير من ملف الحالة وتحفظ مرجع التقديم وتسجل قرار الإبلاغ حتى إذا كان القرار عدم الإبلاغ. التقارير سرية والوصول مقصور على الامتثال ومسؤول مكافحة غسل الأموال. لا يجوز تعديل تقرير بعد تقديمه؛ التصحيحات سجلات جديدة مرتبطة. تُعرض تقارير AML وعمر الحالات وتراكم الفحص على اللوحة لالتقاط خرق اتفاقيات الخدمة قبل أن يكتشفه المفتش.`,
    },
    {
        id: "disputes",
        book: 9,
        titleEn: "Disputes, chargebacks, refunds, and negative balance ceilings",
        titleAr: "النزاعات والاسترداد العكسي والاستردادات وسقف الرصيد السالب",
        tags: ["dispute", "chargeback", "refund", "reserve", "negative-balance-ceiling", "evidence", "cashout"],
        bodyEn: `A dispute is a time-boxed evidence process. When a customer raises a chargeback, the platform opens a dispute, links the original attempt and ledger entry, and computes the response deadline from the scheme calendar. Provisional credit may be posted immediately depending on the scheme. The merchant is notified with the reason code and the evidence checklist. Missing the deadline is a loss by default.

Automated chargeback drafting assembles the available evidence: the original authorization, the capture, the signed confirmation, device and IP metadata, the merchant descriptor, delivery or service proof, and the customer communication history. The draft is a proposal. An operator must review it, remove anything irrelevant or sensitive, add a written rebuttal, and submit. The system never submits a chargeback response without human approval.

Refunds can be full or partial. A full refund reverses the principal and, when policy allows, reverses the fee. A partial refund posts only the requested amount and leaves the attempt in a partially refunded state. Refunds are idempotent: repeating the same refund request must not create a second credit. Refunding an UNKNOWN or disputed attempt requires an operator case, because the underlying money may still move.

The negative_balance_ceiling protects the platform from paying out money the merchant does not have. If a chargeback, fee, or adjustment would push the merchant's available balance below the ceiling, the platform blocks new cash-outs, posts a receivable, and may draw from the chargeback reserve. When the reserve is exhausted, the loss is recognized on the platform. Operators may not override the ceiling; only a finance approval with a documented recovery plan can adjust the merchant's credit limit.`,
        bodyAr: `النزاع عملية أدلة محددة زمنياً. عندما يرفع العميل استرداداً عكسياً تفتح المنصة نزاعاً وتربط المحاولة الأصلية وقيد الدفتر وتحسب مهلة الرد من تقويم المخطط. قد يُقيّد رصيد مؤقت فوراً حسب المخطط. يُبلّغ التاجر برمز السبب وقائمة الأدلة. تفويت المهلة خسارة افتراضية.

يجمع الإعداد الآلي للاسترداد العكسي الأدلة المتاحة: التفويض الأصلي والالتقاط والتأكيد الموقّع وبيانات الجهاز وعنوان IP ووصف التاجر وإثبات التسليم أو الخدمة وسجل تواصل العميل. المسودة اقتراح. يجب أن يراجعها مشغّل ويحذف غير الضروري أو الحساس ويضيف رداً مكتوباً ثم يقدم. لا يقدّم النظام رداً دون موافقة بشرية.

يمكن أن يكون الاسترداد كاملاً أو جزئياً. الكامل يعكس الأصل ويعكس الرسم عندما تسمح السياسة. الجزئي يقيد المبلغ المطلوب فقط ويترك المحاولة مستردة جزئياً. الاستردادات مانعة للتكرار: تكرار الطلب نفسه يجب ألا ينشئ دائناً ثانياً. استرداد محاولة UNKNOWN أو متنازع عليها يتطلب حالة مشغّل لأن المال الأساسي قد يتحرك.

سقف الرصيد السالب يحمي المنصة من دفع أموال لا يملكها التاجر. إذا كان الاسترداد العكسي أو الرسم أو التعديل سيدفع الرصيد المتاح للتاجر تحت السقف، تحجب المنصة السحوبات الجديدة وتقيّد مستحقاً وقد تسحب من احتياطي الاسترداد العكسي. عند نفاد الاحتياطي يُعترف بالخسارة على المنصة. لا يجوز للمشغلين تجاوز السقف؛ فقط موافقة مالية مع خطة استرداد موثقة يمكنها تعديل حد ائتمان التاجر.`,
    },
    {
        id: "gates",
        book: 10,
        titleEn: "The 140 edge cases and the 12 go-live gates",
        titleAr: "الحالات الطرفية المئة والأربعون وبوابات الإطلاق الاثنتا عشرة",
        tags: ["edge-cases", "go-live", "gates", "checklist", "testing", "rollback", "runbook"],
        bodyEn: `The platform maintains a registry of one hundred and forty known edge cases. Each case has an identifier in the form EC-001 through EC-140, a category, a short scenario, the expected behavior, the owning service, and a test reference. The registry is not a suggestion list; it is the institutional memory of every ambiguous payment, duplicate callback, timezone boundary, currency rounding rule, and provider quirk the platform has encountered or deliberately designed for.

The twelve go-live gates are: security review; mTLS and certificate rotation; idempotency and replay protection; UNKNOWN handling and inquiry; reconciliation parity; ledger invariant and balanced journal; AML sign-off and screening; four-eyes enforcement; load and soak testing; rollback and version retirement; observability and alerting; and runbooks plus operator training. A gate is either passed with evidence or not passed. "Probably fine" is not a gate result.

To look up an edge case, search the guide by its identifier, its category, or the provider name. Read the expected behavior and the test reference together. If an incident matches a case, cite the case id in the operator case and in the post-incident review. If an incident does not match any case, add a new case after the incident closes; the registry grows from real evidence, not from imagination.

Go-live is a decision, not a date. The release owner must show every gate with its evidence, every open edge case with an accepted risk and an owner, and the rollback path. If a gate fails, the correct action is to delay, reduce scope, or roll back; never to waive a money-safety gate under delivery pressure.`,
        bodyAr: `تحتفظ المنصة بسجل للمئة والأربعين حالة طرفية معروفة. لكل حالة معرّف بصيغة EC-001 حتى EC-140 وفئة وسيناريو موجز وسلوك متوقع وخدمة مالكة ومرجع اختبار. السجل ليس قائمة اقتراحات بل الذاكرة المؤسسية لكل دفعة غامضة واستدعاء مكرر وحد زمني وقاعدة تقريب عملة وسلوك مزوّد صادفته المنصة أو صممت له عمداً.

بوابات الإطلاق الاثنتا عشرة هي: المراجعة الأمنية؛ mTLS وتدوير الشهادات؛ منع التكرار وإعادة التشغيل؛ معالجة UNKNOWN والاستعلام؛ تكافؤ المطابقة؛ ثبات الدفتر وتوازن القيود؛ موافقة مكافحة غسل الأموال والفحص؛ تطبيق العيون الأربع؛ اختبار الحمل والتحمل؛ التراجع وسحب الإصدار؛ الرصد والتنبيه؛ والأدلة التشغيلية وتدريب المشغلين. البوابة إما مجتازة بدليل أو غير مجتازة. عبارة «على الأرجح جيد» ليست نتيجة بوابة.

للبحث عن حالة طرفية ابحث في الدليل بمعرّفها أو فئتها أو اسم المزوّد. اقرأ السلوك المتوقع ومرجع الاختبار معاً. إذا طابق الحادث حالة فاذكر معرّفها في حالة المشغّل وفي مراجعة ما بعد الحادث. وإذا لم يطابق أي حالة فأضف حالة جديدة بعد إغلاق الحادث؛ ينمو السجل من الأدلة الحقيقية لا من الخيال.

الإطلاق قرار لا تاريخ. يجب أن يعرض مسؤول الإصدار كل بوابة بدليلها وكل حالة طرفية مفتوحة بمخاطرها المقبولة ومالكها ومسار التراجع. إذا فشلت بوابة فالإجراء الصحيح هو التأجيل أو تقليص النطاق أو التراجع؛ لا التنازل عن بوابة سلامة مالية تحت ضغط التسليم.`,
    },
];

export const ERROR_CODE_GLOSSARY: GlossaryEntry[] = [
    {
        code: "RETRYABLE_OTP",
        meaningEn: "The one-time password was wrong or expired, but the attempt is still live and the customer may retry within the allowed window.",
        meaningAr: "رمز لمرة واحدة خاطئ أو منتهٍ، لكن المحاولة ما زالت حية ويمكن للعميل إعادة المحاولة ضمن النافذة المسموحة.",
    },
    {
        code: "LIMIT_EXCEEDED",
        meaningEn: "A configured amount, velocity, or count limit blocked the operation. Do not retry until the limit or the period changes.",
        meaningAr: "حد مبلغ أو سرعة أو عدد محدد في الإعداد منع العملية. لا تعد المحاولة حتى يتغير الحد أو الفترة.",
    },
    {
        code: "AMBIGUOUS",
        meaningEn: "The provider response cannot be interpreted safely. Treat as UNKNOWN and resolve by inquiry, signed callback, or statement.",
        meaningAr: "استجابة المزوّد لا يمكن تفسيرها بأمان. تعامل معها كـ UNKNOWN وحلها بالاستعلام أو الاستدعاء الموقّع أو الكشف.",
    },
    {
        code: "TERMINAL_DECLINE",
        meaningEn: "A definitive decline that must not be retried automatically. The customer needs a different instrument or a new journey.",
        meaningAr: "رفض قاطع لا يجوز إعادة محاولته تلقائياً. يحتاج العميل أداة مختلفة أو رحلة جديدة.",
    },
    {
        code: "GATEWAY_FAULT",
        meaningEn: "The edge or the provider failed before a business outcome was established. The attempt may be UNKNOWN; investigate before retrying.",
        meaningAr: "فشل الحافة أو المزوّد قبل إثبات نتيجة عمل. قد تكون المحاولة UNKNOWN؛ تحقق قبل إعادة المحاولة.",
    },
];

export const GL_ACCOUNT_TYPES: GlossaryEntry[] = [
    {
        code: "ASSET",
        meaningEn: "What the platform owns or is owed: cash, bank, clearing, merchant receivable. Normal balance is debit.",
        meaningAr: "ما تملكه المنصة أو يُستحق لها: النقد والبنك والمقاصة ومستحق التاجر. الرصيد الطبيعي مدين.",
    },
    {
        code: "LIABILITY",
        meaningEn: "What the platform owes: merchant payable, AML hold, chargeback reserve. Normal balance is credit.",
        meaningAr: "ما تدين به المنصة: مستحق التاجر وحجز مكافحة غسل الأموال واحتياطي الاسترداد العكسي. الرصيد الطبيعي دائن.",
    },
    {
        code: "EQUITY",
        meaningEn: "Owner or retained earnings. Normal balance is credit. Used for capital and period close, not for daily payments.",
        meaningAr: "حقوق الملكية أو الأرباح المحتجزة. الرصيد الطبيعي دائن. تُستخدم لرأس المال وإقفال الفترة لا للمدفوعات اليومية.",
    },
    {
        code: "REVENUE",
        meaningEn: "Fee and commission income. Normal balance is credit. Debited when a fee is reversed or refunded.",
        meaningAr: "إيراد الرسوم والعمولات. الرصيد الطبيعي دائن. يُقيد مديناً عند عكس الرسم أو استرداده.",
    },
    {
        code: "EXPENSE",
        meaningEn: "Platform-borne cost or loss, including gateway cost and unrecovered chargebacks. Normal balance is debit.",
        meaningAr: "تكلفة أو خسارة تتحملها المنصة، بما فيها تكلفة البوابة والاستردادات غير المستردة. الرصيد الطبيعي مدين.",
    },
];

export const ATTEMPT_STATUS_GLOSSARY: GlossaryEntry[] = [
    { code: "CREATED", meaningEn: "Attempt exists; nothing has been reserved or sent.", meaningAr: "المحاولة موجودة؛ لم يُحجز أو يُرسل شيء." },
    { code: "RESERVED", meaningEn: "Slot and ledger promise reserved atomically.", meaningAr: "حُجزت الخانة والوعد المحاسبي ذرياً." },
    { code: "DISPATCHED", meaningEn: "Request handed to the edge or transmitted to the provider.", meaningAr: "سُلّم الطلب للحافة أو أُرسل للمزوّد." },
    { code: "PENDING_CUSTOMER", meaningEn: "Customer action is still required (OTP, redirect, QR scan).", meaningAr: "ما زال مطلوباً إجراء من العميل (رمز، إعادة توجيه، مسح QR)." },
    { code: "AUTHORIZED", meaningEn: "Provider approved; capture is not final.", meaningAr: "وافق المزوّد؛ الالتقاط غير نهائي." },
    { code: "CAPTURED", meaningEn: "Funds captured at the provider; platform confirmation pending.", meaningAr: "التُقطت الأموال عند المزوّد؛ تأكيد المنصة معلّق." },
    { code: "CONFIRMED", meaningEn: "Core accepted the money movement and posted the journal.", meaningAr: "قبلت النواة حركة المال وقيدت القيد المحاسبي." },
    { code: "SETTLED", meaningEn: "Settlement leg completed and matched.", meaningAr: "اكتمل شق التسوية وطُوبق." },
    { code: "FAILED", meaningEn: "Terminal technical failure with no money moved.", meaningAr: "فشل تقني نهائي دون حركة أموال." },
    { code: "DECLINED", meaningEn: "Terminal business decline by the provider or risk.", meaningAr: "رفض تجاري نهائي من المزوّد أو المخاطر." },
    { code: "EXPIRED", meaningEn: "The allowed customer or provider window elapsed.", meaningAr: "انتهت نافذة العميل أو المزوّد المسموحة." },
    { code: "CANCELLED", meaningEn: "Cancelled before money moved, by operator or policy.", meaningAr: "أُلغيت قبل حركة الأموال بواسطة مشغّل أو سياسة." },
    { code: "UNKNOWN", meaningEn: "Outcome not established; slot stays locked until evidence resolves it.", meaningAr: "النتيجة غير مثبتة؛ تبقى الخانة محجوزة حتى يحلها الدليل." },
];
