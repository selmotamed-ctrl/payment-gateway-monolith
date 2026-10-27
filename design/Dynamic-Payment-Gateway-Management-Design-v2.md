Dynamic Payment Gateway Management: Design v2 

# Dynamic Payment Gateway Management: Design v2 

Draft v2 · 22 October 2026 · Supersedes Draft v1. Extends the Payment Gateway Platform proposal (rails, double-entry ledger, maker-checker) and reuses the patterns of the Voucher Provider Management System. 

## 1. Summary 

An operator adds a gateway from the dashboard by describing how to authenticate, what the customer must enter, which HTTP calls start and finish a payment, how the result arrives (OTP response, redirect return, webhook, browser widget callback, polling, statement), how the gateway's status and error codes map to ours, and how the money settles. No release is needed per gateway, exactly as with voucher providers. Where configuration cannot express a gateway, a native adapter plugs into the same registry. 

A payment gateway is not a voucher provider with a different URL. The customer is in the loop, results arrive late or twice, some gateways run inside the customer's browser, and money may settle days later. The design therefore adds a flow engine, an attempt state machine, a trusted confirmation layer and safer money handling on top of the voucher pattern. 

### Headline decisions 

1. Four layers instead of one: Gateway (an integration), Credential Set (whose account and secrets, per environment), Rail (what the customer sees, such as Edfali) and Route (which gateway serves which rail, with priority, cost, limits and scope). One gateway serves many rails (aggregators) and one rail can have several routes (Edfali direct, or through an aggregator). 

2. Collection mode and confirmation channel are separate axes. What the customer does (OTP, redirect, embedded widget, push approval, QR, pay code, deep link, manual transfer) is independent of how we learn the result (sync response, webhook, return URL, browser callback, polling, statement). Any mode combines with any channel. 

3. A declarative flow engine (phases made of steps, with a closed library of transforms) covers the common cases. A native adapter escape hatch covers what configuration cannot express. 

4. A browser or return-URL success is never trusted. Money is posted only after a serververified confirmation (signed webhook, inquiry call, synchronous confirm response, or statement match). 

Page 1 of 44 

Dynamic Payment Gateway Management: Design v2 

5. Immutable, versioned gateway configuration with a sandbox-to-live lifecycle gated by maker-checker. In-flight attempts stay pinned to the version they started with. 

6. Uncertain outcomes become UNKNOWN, are never retried blindly, and are resolved by inquiry, polling or reconciliation. 

7. An ownership-aware ledger: per-gateway Clearing Accounts for platform-held funds, and a commission-only posting path for merchant-owned gateway accounts that settle directly to the merchant. 

8. Nothing goes live untested: contract tests, a scenario suite per rail, and a built-in mock gateway. 

### What changed since Draft v1 

|Area|Draft v1|Draft v2|
|---|---|---|
|Account<br>ownership|Assumed every gateway<br>account belongs to the platform<br>and settles toward the Treasury<br>Account|Credential Set with an owner<br>(PLATFORM or MERCHANT) and a<br>settlement target. Merchant-<br>owned accounts settle directly to<br>the merchant and the ledger books<br>only our commission (section 3.2,<br>10.4)|
|Collection modes|Six|Eight: adds PAY_CODE (customer<br>pays by SMS, USSD or app using a<br>code we display), DEEP_LINK and<br>MANUAL (bank transfer or cash<br>agent confirmed by an operator).<br>Redirects support GET and auto-<br>submitted POST forms|
|Body formats|JSON|JSON, form-urlencoded, multipart,<br>XML or SOAP (XXE-safe parser),<br>and non-JSON callbacks|
|Outbound<br>idempotency|Only on our own endpoints|Per-step idempotency key source<br>and a gateway capability flag,<br>because at least one aggregator<br>accepts idempotency keys on<br>session creation|



Page 2 of 44 

Dynamic Payment Gateway Management: Design v2 

|Area|Draft v1|Draft v2|
|---|---|---|
|Amount rounding|Stated that DPay rounds to<br>whole dinars|The latest public DPay SDK<br>example shows a 3-decimal total<br>charged as a 2-decimal amount<br>(76.255 becomes 76.26). Scale,<br>precision and rounding mode are<br>per-gateway settings that must be<br>proven by a contract test, not<br>assumed|
|Statements|Mentioned|Defined: StatementSource plus a<br>column-mapping parser, so<br>reconciliation is also configuration,<br>not code|
|Fees|Booked at settlement|Option to accrue the expected<br>gateway fee at confirmation and<br>true it up at settlement|
|Identity|One name per gateway|Operator, country, canonical code<br>and aliases, because names collide<br>(Sadad in Libya versus other<br>countries; EVO Pay wallet versus<br>EVO Payments the acquirer; Edfali,<br>Edfaa Li and Adfali are one<br>product)|
|Template safety|Mentioned SSRF only|Rules for injection into URLs,<br>headers, XML and logs (section<br>5.5)|
|POS|Not covered|POS screens receive realtime<br>attempt status; QR and pay-code<br>rails are first-class on POS|
|Edge cases|48|About 90, grouped (section 13)|



## 2. What the research found 

### 2.1 Sources and confidence 

Official merchant documentation for most Libyan gateways sits behind merchant onboarding. The findings come from public SDKs and plugins (Moamalat packages for Node, Laravel and Odoo; the DPay, Plutu, MyPay and T-LYNC SDKs and plugins), bank and 

Page 3 of 44 

Dynamic Payment Gateway Management: Design v2 

central-bank pages, and app-store listings. Evidence levels used in this document: 

- PUBLIC-SDK: the shape was seen in open-source code for that gateway or aggregator. 

- VENDOR-PAGE: stated on a bank, operator or regulator page, with no API detail. 

- UNVERIFIED: modeled from the closest evidence; shown with a badge in the catalog until a partner supplies documents and sandbox credentials. 

Treat every row as a hypothesis to verify against contract documents and the sandbox 

before building the profile. 

### 2.2 What the public SDKs show 

- Moamalat Lightbox: the page calls Lightbox.Checkout.configure with MID, TID, AmountTrxn, MerchantReference, TrxDateTime and a SecureHash, plus complete, cancel and error callbacks. The hash is generated on the server from a hex secret, so the secret never reaches the browser. Transactions can be looked up by network reference and merchant reference. Moamalat also posts a server notification, and the community packages tell merchants to ask Moamalat for the sender IPs and allow-list them. Stored fields in the Odoo module include SystemReference, NetworkReference, PayerName, Account and TxnDate. The Node SDK sends amounts in thousandths of a dinar. 

- DPay (aggregator, operated by DITS): its official SDK offers hosted checkout sessions for every method and a per-method session API (Edfali, Sadad, MobiCash, bank wallets, Moamalat, Mastercard) with open, verify (OTP) and get calls. Open calls take an idempotency key derived from order, attempt and method. Webhooks are signed and there are six event types, with a payment.paid event that keeps the original requested amount. Settlement can differ from the request (a 76.255 total was charged as 76.26). The SDK talks only HTTPS to DPay hosts, never follows redirects and always verifies TLS. Minimum and maximum amounts are per gateway and merchant. A sandbox exists. Its app listing says funds go directly to the merchant's bank account and gateway credentials stay with the merchant. 

- Plutu (aggregator): Edfali is verify (mobile number, amount, returns a process id) then confirm (process id, code, amount, invoice number). Sadad adds the birth year on verify. Credentials are an API key and access token, plus a secret key for the card-type services (local bank cards, T-LYNC, MPGS), which finish through a callback carrying a hash that the SDK verifies. 

- MyPay (aggregator): a token endpoint with client id and secret, a create-payment call that takes return, cancel and webhook URLs and a method alias, a hosted checkout, a webhook signed in an X-MyPay-Signature header, and a separate sandbox base path. 

Page 4 of 44 

Dynamic Payment Gateway Management: Design v2 

Aliases include moamalat (shown as banking card), edfali, sadad, mobicash, yasr-pay, sahary-pay, masrafi-pay and an optional prepaid card. Each method must be enabled per merchant. 

T-LYNC (Tadawul Digital Solutions Provider): hosted checkout; API key and secret; separate test and live base URLs; a callback that the merchant can restrict by source IP; a customer return redirect. 

### 2.3 Gateway matrix 

|Gateway|What the<br>customer<br>does|Collection mode|How the result<br>reaches us|Evidence|
|---|---|---|---|---|
|Moamalat card<br>(national<br>switch,<br>Lightbox)|Enters the<br>card inside a<br>Moamalat<br>popup|EMBEDDED (also<br>via aggregator<br>hosted pages)|Browser<br>callbacks (hint<br>only), server<br>notification<br>from Moamalat<br>IPs, transaction<br>inquiry|PUBLIC-SDK|
|Numo Pay<br>(Moamalat<br>Financial<br>Services)|Wallet app<br>that stores<br>bank cards;<br>pays at<br>NUMO POS<br>or Business<br>app|PUSH_APPROVAL<br>or QR_DISPLAY<br>(online API<br>unknown)|Unknown;<br>assume<br>webhook or<br>polling|VENDOR-<br>PAGE,<br>UNVERIFIED|
|Sadad (Almadar<br>Aljadid)|Phone, birth<br>year, then<br>SMS OTP|OTP_PULL|Synchronous<br>confirm; status<br>check reported<br>through<br>aggregators|PUBLIC-SDK|
|Libyana<br>payment<br>system|Carrier billing:<br>SMS with a<br>confirmation<br>code|OTP_PULL|Operator<br>response; no<br>general<br>merchant API<br>found|VENDOR-<br>PAGE,<br>UNVERIFIED|



Page 5 of 44 

Dynamic Payment Gateway Management: Design v2 

|Gateway|What the<br>customer<br>does|Collection mode|How the result<br>reaches us|Evidence|
|---|---|---|---|---|
|Tadawul / T-<br>LYNC|Hosted<br>checkout;<br>schemes<br>include<br>Tadawul<br>cards,<br>MobiCash,<br>Sadad, Edfali|REDIRECT|Callback (IP-<br>restrictable)<br>plus return<br>redirect;<br>inquiry if<br>offered|PUBLIC-SDK|
|Edfali / Edfaa Li<br>(BCD)|Phone<br>number, then<br>OTP|OTP_PULL|Synchronous<br>confirm; no<br>status check<br>reported|PUBLIC-SDK|
|OnePay (CBL<br>instant<br>payment)|QR or NFC at<br>POS, or SMS<br>payment with<br>a verification<br>code; cross-<br>bank|PAY_CODE or<br>QR_DISPLAY|Bank-side<br>confirmation;<br>online access<br>mainly through<br>aggregators|VENDOR-<br>PAGE|
|Visa /<br>Mastercard|Card on a<br>hosted page<br>or hosted<br>fields, 3-D<br>Secure|REDIRECT or<br>EMBEDDED|Return redirect<br>plus signed<br>callback or<br>inquiry|PUBLIC-SDK<br>(MPGS,<br>Mastercard<br>via<br>aggregators)|
|MobiCash<br>(Masarat)|Transaction<br>card number,<br>then OTP;<br>also QR, SMS,<br>NFC in shops|OTP_PULL|Synchronous<br>confirm|PUBLIC-SDK|
|GPay (Libya<br>Guide)|Wallet linked<br>to bank<br>accounts;<br>pays by QR or<br>gateway<br>number; can<br>accept or<br>reject a<br>request|PUSH_APPROVAL<br>or QR_DISPLAY|Asynchronous|VENDOR-<br>PAGE,<br>UNVERIFIED|



Page 6 of 44 

Dynamic Payment Gateway Management: Design v2 

|Gateway|What the<br>customer<br>does|Collection mode|How the result<br>reaches us|Evidence|
|---|---|---|---|---|
|Yussor Pay<br>(NCB)|Purchase<br>code by SMS,<br>QR in the<br>Mobi Mal app,<br>or the online<br>flow|HYBRID|Synchronous<br>confirm; status<br>check via<br>aggregators|PUBLIC-SDK|
|Hawelli (zaho.ly,<br>link to the<br>wallet<br>unconfirmed)|QR, NFC or<br>mobile<br>number; deep<br>link|PUSH_APPROVAL,<br>QR_DISPLAY or<br>DEEP_LINK|Unknown|UNVERIFIED|
|Sahara Pay<br>(Sahara Bank)|QR or SMS<br>payment, OTP|HYBRID|Synchronous<br>confirm; status<br>check via<br>aggregators|PUBLIC-SDK|
|EVO Pay Libya<br>(evowallet.net)|Wallet-to-<br>wallet; KYC<br>wallet|PUSH_APPROVAL<br>or QR_DISPLAY<br>(merchant API<br>unknown)|Unknown|UNVERIFIED;<br>not the same<br>as EVO<br>Payments the<br>international<br>acquirer|
|DPay, Plutu,<br>MyPay, T-LYNC<br>(aggregators)|Hosted<br>checkout or<br>per-method<br>API|REDIRECT,<br>OTP_PULL,<br>EMBEDDED|Signed<br>webhook,<br>inquiry, polling|PUBLIC-SDK|



### 2.4 Findings that shape the design 

1. Every real flow fits one of eight collection modes, and most need more than one HTTP call (send OTP then confirm; create session, redirect, then verify). 

2. The customer's input differs per rail: phone, birth year, card or transaction-card number, OTP, nothing. Forms must be configurable per rail with validation (for example Edfali phones follow a 09xxxxxxxx pattern; MobiCash asks for a card number). 

3. Amount handling is not uniform: thousandths for Moamalat, whole or 2-decimal rounding on aggregators, per-gateway and per-merchant limits. Scale, rounding, precision and min/max are gateway settings, and the settled amount is stored apart from the requested amount. 

Page 7 of 44 

Dynamic Payment Gateway Management: Design v2 

4. Browser-side success exists and must not be trusted. The Lightbox reports completion to the page; the trustworthy signals are the server notification and the inquiry API. 

5. Signatures take many shapes: a hash built from a hex secret (Moamalat), a signature header (MyPay), a callback hash (Plutu card services), IP restriction (T-LYNC, Moamalat). The engine needs a closed transform library and several verification methods. 

6. Sessions expire on the gateway's clock (10 to 15 minutes on several rails per Draft v1 research), so our expiry is min(gateway TTL, platform TTL), not a flat 20 minutes. 

7. Some rails have no status endpoint, so a timeout on confirm may leave no way to ask. They need stricter UNKNOWN handling and statement reconciliation. 

8. The same rail is reachable through different routes with different behavior (Edfali direct as OTP, Edfali through an aggregator as hosted checkout or OTP), and a gateway account can belong to the platform or to the merchant. 

9. Limits and ownership change over time (central bank ceilings, the planned move of the national switch). Ceilings cannot be hard-coded, and a rail must be re-routable without touching links. 

10. Names collide and spell differently, so identity needs operator, country and aliases. 

### 2.5 What could not be confirmed 

The official Moamalat documentation site, the DPay, Plutu and T-LYNC API specifications, and any merchant API for Numo Pay, GPay, Hawelli, EVO Pay and Libyana's general payments were not reachable or not public. Searches for the EVO wallet merchant API returned only the unrelated international acquirer. Those profiles are marked UNVERIFIED until a partner supplies documents and sandbox credentials. 

## 3. Core concepts 

### 3.1 Gateway, Credential Set, Rail, Route 

- Gateway: one integration with an external system. It holds environments (sandbox, live), base URLs, authentication scheme, flow definitions, confirmation channels, status and error mapping, and settings (amount scale, TTL, limits). Examples: Moamalat, DPay, T-LYNC, Plutu, Edfali direct. Identity fields: code, name, operator, country, aliases. 

- Credential Set: the secrets and identifiers used to talk to a gateway in one environment (merchant id, terminal id, API keys, hex secrets, webhook secrets). It has an owner (PLATFORM or MERCHANT), a settlement target (section 3.2) and its own status. Secrets can be replaced, never revealed. 

Page 8 of 44 

Dynamic Payment Gateway Management: Design v2 

- Rail: what the customer chooses, such as Edfali, Sadad or Visa/Mastercard. It owns the customer form, bilingual names, logo, currency, limits and capabilities (refund, partial refund, void, capture). 

- Route: the link between a rail and a gateway through a Credential Set, with priority, cost model, limits, health and scope. A rail with no active route is hidden. A rail with several routes is ranked like voucher providers (lowest effective cost, then priority) subject to health. 

The proposal's rule for visible rails gains one term: 

visible rails = Application rails ∩ Link rails ∩ rails with a live Commission Profile ∩ rails with at least one healthy, active route within limits and in scope for this merchant, amount and currency. 

### 3.2 Who owns the gateway account 

|Model|Credentials|Money path|Ledger effect|
|---|---|---|---|
|PLATFORM_ACCOUNT,<br>platform-held settlement|Platform|Gateway pays the<br>platform; the<br>platform pays<br>merchants by<br>cash-out|Gateway Clearing<br>then Treasury;<br>merchant wallet<br>credited at<br>confirmation<br>(section 10)|
|MERCHANT_ACCOUNT,<br>direct settlement|Merchant<br>supplies and<br>keeps them|Gateway pays the<br>merchant directly|The platform books<br>only its commission<br>as a receivable<br>from the merchant<br>(or collects it by<br>invoice); no<br>merchant wallet<br>credit, no Treasury<br>movement|
|PROVIDER_HELD<br>(aggregator holds funds)|Platform|Aggregator holds<br>funds and pays<br>out on a schedule|Same as platform-<br>held, with the<br>aggregator as the<br>clearing<br>counterparty|



The model is a property of the Credential Set, so the same Gateway can serve both kinds of merchant. A route can require a merchant credential (MERCHANT_REQUIRED), allow either (MERCHANT_OR_PLATFORM) or use only the platform's (PLATFORM). Merchant- 

Page 9 of 44 

Dynamic Payment Gateway Management: Design v2 

supplied secrets follow the same encryption, rotation and maker-checker rules as platform ones, and a merchant can never read back a secret, only replace it. 

### 3.3 Two independent axes 

Axis A is what the customer does (collection mode). Axis B is how we learn the result (confirmation channel). A route declares one mode and one or more channels ordered by trust. 

|Confirmation channel|Trust|Typical use|
|---|---|---|
|SYNC_RESPONSE (answer to the<br>confirm call)|High|OTP rails (Edfali, Sadad,<br>MobiCash)|
|WEBHOOK (signed or IP-restricted<br>server call)|High if verified|Hosted checkout,<br>Moamalat notification,<br>MyPay, DPay|
|INQUIRY or POLL (we ask the<br>gateway)|High|Gateways with a status<br>endpoint; resolves<br>UNKNOWN|
|RETURN_URL (customer redirected<br>back)|Low: a hint that<br>triggers an inquiry|Redirect flows|
|BROWSER_CALLBACK (widget<br>JavaScript event)|None: only triggers<br>server verification|Moamalat Lightbox|
|STATEMENT (daily file or API)|Authoritative, slow|Reconciliation; rails with no<br>status endpoint|
|OPERATOR_CONFIRMATION<br>(maker-checker)|Authoritative, manual|MANUAL rails, disputed or<br>held attempts|



### 3.4 Collection modes 

|Mode|What happens|Examples|
|---|---|---|
|OTP_PULL|We ask the gateway to send the<br>customer a code; the customer|Edfali, Sadad, MobiCash, Yussor<br>Pay, Sahara Pay, Libyana carrier|
||types it; we confirm (two or more|billing|
||calls, state carried between them)||



Page 10 of 44 

Dynamic Payment Gateway Management: Design v2 

|Mode|What happens|Examples|
|---|---|---|
|REDIRECT|We create a session and send the<br>browser to a hosted page (GET<br>redirect or auto-submitted POST<br>form), then handle the return|T-LYNC, MyPay, DPay hosted<br>checkout, hosted card pages, 3-D<br>Secure|
|EMBEDDED|We render the gateway's script,<br>iframe or SDK in our page with<br>server-prepared parameters|Moamalat Lightbox, hosted card<br>fields|
|PUSH_APPROVAL|We send a payment request to the<br>customer's wallet app; the<br>customer approves or rejects later|GPay requests, wallet-by-phone-<br>number flows|
|QR_DISPLAY|We show a QR; the customer<br>scans it in a bank or wallet app|OnePay, wallet QR|
|PAY_CODE|We show a code or instructions;<br>the customer pays by SMS, USSD,<br>app or agent using that code|Yussor Pay purchase code,<br>OnePay SMS payment|
|DEEP_LINK|We show a button that opens the<br>wallet app on the customer's<br>phone with the payment prepared|Wallet apps with deep links|
|MANUAL|The customer pays by bank<br>transfer or at an agent; an<br>operator (or a statement match)<br>confirms|Bank transfer, cash agent,<br>gateways with no usable API|
|HYBRID|A rail offers several of the above<br>and the customer picks|Sahara Pay, Yussor Pay, Hawelli|



### 3.5 Native adapter escape hatch 

The engine is declarative and deliberately has no scripting language. A gateway that needs something it cannot express (proprietary encryption, a binary protocol, a multi-leg 3-D Secure exchange) is implemented as a native adapter in code and registered in the Rail Registry with the same contract as a configured gateway. The admin UI treats both identically. A native adapter supplies only its own flow runner and a typed settings form, and still passes through the same attempt state machine, inbox, verifier and Ledger Poster, so it cannot post money by itself. 

Page 11 of 44 

Dynamic Payment Gateway Management: Design v2 

## 4. Data model 

All tables carry id, created_at and updated_at. Money is DECIMAL(18,4): the dinar has three decimal places, so never use floats, and amounts travel as decimal strings. Secret columns are encrypted at rest (AES-256-GCM, key id stored per value) and redacted in every log.

The database engine is MySQL 8.0+ / MariaDB 10.6+ (the platform was originally designed for PostgreSQL and has since been migrated). The Prisma datasource is `provider = "mysql"`, reached through `@prisma/adapter-mariadb` on top of the `mariadb` driver package; `String` maps to `VARCHAR(191)` with free-form content declared `@db.Text`, `Bytes` maps to `BLOB` (the inbound webhook body is `@db.LongBlob`), `Json` maps to `JSON`, and Prisma enums become native `ENUM` columns.

### 4.1 Gateway definition (versioned) 

- Gateway: code (unique), name, operator, country, aliases, kind (DIRECT, AGGREGATOR, NATIVE_ADAPTER), status (DRAFT, SANDBOX_VERIFIED, PENDING_APPROVAL, LIVE, SUSPENDED, RETIRED), active_version_id, 

- verification_state (VERIFIED or UNVERIFIED, shown as a badge), risk_class (NORMAL, or HIGH_RISK when the gateway offers neither a signature nor an inquiry). 

- GatewayVersion: immutable snapshot of everything in 4.1 to 4.5 (JSON plus content hash), state, created_by, approval_request_id, change_note, rollback_version_id. An edit creates a new DRAFT; only an approved version can go LIVE. 

- GatewayEnvironment: env (SANDBOX or LIVE), base_urls (map: api, checkout, inquiry), inbound_ip_allowlist (CIDRs the gateway calls us from), outbound_egress_ips (the fixed IPs we give gateways that allow-list us), enabled. Sandbox and live never share credentials, webhook secrets or ledger effect. 

- GatewayAuth (per environment): method = NONE, API_KEY, PERMANENT_TOKEN, TOKEN_ENDPOINT (client id and secret exchanged for an access token), REFRESH_TOKEN, USERNAME_PASSWORD, BASIC, REQUEST_SIGNATURE (api key, access token and secret key signing each request), OAUTH2_CLIENT_CREDENTIALS, MUTUAL_TLS. auth_apply says where credentials go (header, query, body), default a Bearer header. Refresh settings mirror the voucher design: period, retry once on 401 or 403, single-flight refresh, persistence of rotated refresh tokens. 

- Gateway-wide settings: amount_scale (1, 100, 1000), amount_precision (decimal places), amount_rounding (NONE, NEAREST, UP, DOWN), amount_format (STRING_DECIMAL, INTEGER_MINOR_UNITS, NUMBER), reference_format (charset, max length, numeric or alphanumeric, generator), session_ttl_seconds, otp_ttl_seconds, otp_resend_cooldown_seconds, supports_status_check, supports_idempotency_key, supports_cancel, status_check_min_age_seconds, rate_limit_per_second, concurrency_cap, timeout_ms, max_response_bytes, gateway_timezone. 

Page 12 of 44 

Dynamic Payment Gateway Management: Design v2 

### 4.2 Credential sets 

CredentialSet: gateway_id, env, owner_type (PLATFORM or MERCHANT), owner_merchant_id, settlement_target (PLATFORM_CLEARING, MERCHANT_DIRECT, PROVIDER_HELD), entries (key, type, value, is_secret, secret_version), status (UNTESTED, VERIFIED, FAILING, REVOKED), last_verified_at, expires_at (tokens and certificates). A Credential Check flow (a read-only call defined per gateway) validates a set when it is saved and on a schedule, so a wrong or expired merchant credential is found before a customer hits it. 

### 4.3 Customer-facing catalog 

- Rail: code, name_ar, name_en, logo_asset_id, collection_mode (OTP_PULL, REDIRECT, EMBEDDED, PUSH_APPROVAL, QR_DISPLAY, PAY_CODE, DEEP_LINK, MANUAL, HYBRID), currency, min_amount, max_amount, display_order, blocked, capabilities (refund, partial_refund, void, capture, recurring), refund_window_days, instructions_ar and instructions_en. 

- RailField (customer form): key, type (phone, number, string, otp, birth_year, card_number, pan, from-list), label_ar and label_en, placeholder, regex, length, required, order, sensitivity (NORMAL, SENSITIVE, PAN), normalizer (Arabic-Indic digits, +218 and 09 phone forms). PAN fields are held only in memory for the single call and never written to state, logs or analytics. 

- RailRoute: rail_id, gateway_id, credential_policy (PLATFORM, MERCHANT_REQUIRED, MERCHANT_OR_PLATFORM), priority, cost_model (flat, percent, tiered; who bears it), min_amount, max_amount, daily_cap_amount, status (ACTIVE, PAUSED, DRAINING), health_state (HEALTHY, DEGRADED, OPEN_BREAKER), maintenance_windows, optional scope (merchant_ids, application_ids, risk_tiers, channels such as WEB, API, POS). Unique on (rail_id, gateway_id, credential_policy). 

### 4.4 Flow definition and mapping 

- Flow: gateway_version_id, rail_id (null for gateway-wide flows), phase = CREDENTIAL_CHECK, INITIATE, SUBMIT (OTP or approval submission), VERIFY (inquiry), CANCEL, REFUND, VOID, CAPTURE, SETTLEMENT_FETCH. 

- FlowStep: flow_id, order_index, type (HTTP, COMPUTE, RENDER, WAIT, ASSERT, BRANCH), method, url template, content_type, body_format, timeout_ms, success_check, side_effect (READ_ONLY, SENDS_NOTIFICATION, MOVES_MONEY), retry_policy (SAFE, SAFE_WITH_COOLDOWN, NEVER), idempotency (NONE, HEADER, BODY_FIELD, with the source of the key), point_of_no_return (bool). 

Page 13 of 44 

Dynamic Payment Gateway Management: Design v2 

   - StepParameter: place (HEADERS, QUERY, PATH, BODY, FORM, MULTIPART), key (recursive-set path), source, selector, constant_value, transforms (ordered list from the whitelist in 5.2). 

   - StepOutput: name, selector, store_as (STATE or PUBLIC), required. PUBLIC outputs go to the browser (redirect URL, QR payload, widget configuration); everything else stays in encrypted state. 

   - StatusRule: ordered rules {selector, op (equals, in, exists, matches), value, canonical_status, canonical_error}, first match wins; no match on a money-moving step means UNKNOWN, not failure. 

   - ErrorMap: gateway_code to canonical_error, retryable, counts_toward_lockout, customer_message_ar and customer_message_en, operator_hint. 

- 4.5 Confirmation, widgets, statements, manual instructions 

   - ConfirmationChannel: route_or_gateway, type (WEBHOOK, RETURN_URL, BROWSER_CALLBACK, POLL, STATEMENT, OPERATOR), path_token (random, per environment), verification (method = HMAC, RSA, SHARED_TOKEN, SORTED_VALUES_HASH, IP_ONLY, NONE_PLUS_INQUIRY; header or body location; algorithm; canonicalization template; secret_ref with overlapping versions; timestamp location and tolerance; ip_allowlist), body_format (JSON, FORM, XML), correlation (selector yielding our attempt reference or the provider reference), dedupe_key (selector or hash of body), event_map (gateway event to canonical status), must_inquire (treat the event as a hint and confirm with the VERIFY flow first), ack_template (the response the gateway expects). 

   - PollPolicy: first_after_seconds, backoff (for example 5, 10, 20, 40, 60), max_duration_seconds, stop_on states. 

   - WidgetDefinition (EMBEDDED): kind (LIGHTBOX, IFRAME, SDK_WEBVIEW, NATIVE_ANDROID), script_urls (must be on the platform script allow-list), config_template (values built from COMPUTE output), callbacks (widget event to our client-event endpoint), allowed_origins (postMessage), iframe_sandbox attributes, csp_additions (reviewed by the SECURITY role). 

   - RedirectDefinition (REDIRECT): method (GET or POST_FORM), url_source, form_fields (for POST_FORM), target (SAME_WINDOW, NEW_TAB, TOP_FRAME), return_method_expected (GET or POST), return_params_map. 

   - StatementSource: type (API, SFTP, UPLOAD), schedule, parser (format CSV, XLSX or JSON; header row; column mapping for provider_reference, our_reference, amount, fee, currency, status, timestamp; date format and timezone; decimal and thousand separators), settlement_lag_days, dedupe_key. 

   - ManualInstruction (MANUAL): bilingual instructions, destination account template, payment reference format, proof upload allowed (yes or no), operator SLA, auto-expiry. 

Page 14 of 44 

Dynamic Payment Gateway Management: Design v2 

### 4.6 Runtime tables 

- PaymentAttempt (the proposal's Payment Log, extended): link_id, attempt_group_id, rail_id, route_id, credential_set_id, gateway_version_id (pinned), env, status, substatus, gateway_reference (our reference in the gateway's format), provider_reference, network_reference, requested_amount, gateway_amount (as sent after scale and rounding), settled_amount, gateway_fee, fee_bearer, currency, customer_fields (masked), state (encrypted JSON: process id, tokens, session), expires_at, next_check_at, otp_attempts, idempotency_key, client_fingerprint, ledger_entry_id, terminal_at. 

- AttemptStepLog: per step, redacted request and response, HTTP status, duration, outcome, step id, version id. 

- InboundEvent (webhook inbox): raw body and headers (redacted), channel_id, verified, verification_error, dedupe_key, attempt_id, received_at, processed_at, result. Stored before any processing and never deleted. 

- AttemptGroup: all attempts by one customer on one link (retries, route switches). At most one may reach SUCCEEDED. 

- OperatorCase: UNKNOWN, held, conflicting, mismatched or late attempts, with SLA timers. 

- ReconciliationRun and ReconciliationItem: per-item results MATCHED, AMOUNT_MISMATCH, MISSING_AT_GATEWAY, MISSING_LOCALLY, DUPLICATE. 

- GatewayHealthSample: rolling counters per route for the circuit breaker. AuditLog: every admin action with before and after (secrets masked). 

### 4.7 Referential rules 

- A gateway can be deleted only when it has no routes and no attempts; otherwise it is RETIRED. Rails with attempts are blocked, not deleted. Attempts keep a snapshot of rail and gateway names and the pinned version. 

- Changing a rail's customer form never alters attempts in flight, because they read the pinned version. 

- Retiring a route goes through DRAINING first: no new attempts, existing ones finish, then other ACTIVE routes take over. 

- A Credential Set that is REVOKED or FAILING removes its routes from ranking without touching links. 

Page 15 of 44 

Dynamic Payment Gateway Management: Design v2 

## 5. The flow engine 

### 5.1 Phases, steps and retry safety 

Each route runs phases. A phase is an ordered list of steps; later steps read the outputs of earlier ones. Step types: HTTP (an outbound call), COMPUTE (transforms only, no network), RENDER (tell the client what to show: OTP prompt, redirect, widget, QR, pay code, deep link, instructions), WAIT (park until an external event or a poll), ASSERT (check a condition, fail if false) and BRANCH (choose the next steps by a condition). Every HTTP step declares: 

- side_effect: READ_ONLY (inquiry), SENDS_NOTIFICATION (send OTP, push request) or MOVES_MONEY (confirm, capture, refund). 

- retry_policy: SAFE (read-only), SAFE_WITH_COOLDOWN (re-sending an OTP only after a cooldown and within a cap), NEVER (any step that may have moved money). 

- idempotency: whether the gateway accepts an idempotency key on this call and where it goes. When it does, the key is derived from attempt id, step and retry counter, so a repeated call is safe. When it does not, retry_policy must stay NEVER. 

- point_of_no_return: from this step on the attempt is bound to this route. Route fallback is legal only before it. 

Failure classes, with the same discipline as the voucher design: 

Page 16 of 44 

Dynamic Payment Gateway Management: Design v2 

|Failure|Meaning|Action|
|---|---|---|
|Connection failure before<br>sending, 4xx, explicit decline, auth<br>failure after one refresh|Definitive, nothing<br>happened|FAILED; fallback to the next<br>route only if before the point of<br>no return|
|Timeout or reset after sending,<br>5xx, malformed or unmapped<br>response on a MOVES_MONEY<br>step|Ambiguous|UNKNOWN, no retry, start<br>inquiry and polling, alert|
|Failure on a later step after an<br>earlier one succeeded|Partial|UNKNOWN, or compensate<br>(cancel or void) if the gateway<br>supports it|
|Gateway rate limit (429)|Transient|Back off and retry only SAFE<br>steps; otherwise show a try-<br>again-shortly message|
|Response larger than the cap, too<br>deeply nested, wrong content<br>type|Hostile or broken|Treated as ambiguous on<br>money steps, definitive on<br>read-only steps; alert|



### 5.2 Parameter sources and the transform library 

#### Sources: 

- GATEWAY_META and ROUTE_META and CREDENTIAL: configured values (merchant id, terminal id, secrets). The credential comes from the route's Credential Set. 

- ATTEMPT: reference (gateway format), amount (after scale and rounding), requested_amount, currency, description, expires_at, merchant_name, link_key, idempotency_key. 

- CUSTOMER_FIELD: a value the customer entered. PAN fields are valid only in the step that needs them. 

- STATE: a value stored by an earlier step (process id, session id). 

- PREVIOUS_RESPONSE: a selector over the previous step's response (invalid on the first step). 

- URLS: return_url, cancel_url, callback_url, generated per attempt with an unguessable token. 

- CLIENT_CONTEXT: client IP, user agent, locale (only if the gateway needs them). CONSTANT, NOW, RANDOM (uuid, numeric). 

- COMPUTED: the result of a transform pipeline over other sources. 

Page 17 of 44 

Dynamic Payment Gateway Management: Design v2 

Transforms are a closed, whitelisted set. There is no scripting language and no adminsupplied code. Operations: concat, template, lowercase, uppercase, trim, pad, substring, to_int, to_string, scale(factor), round(mode), format_decimal(places), 

format_date(pattern, timezone), epoch, uuid, sha256, sha512, hmac_sha256(key_source, key_encoding = utf8 | hex | base64), rsa_sign(key_ref), base64, hex, upper_hex, sort_keys, values_only, join_pairs(separator, joiner), prepend(secret), mask, json_encode, xml_escape, url_encode. Each transform has typed input and output, so a pipeline is validated at save time (hmac_sha256 must receive a string and a key). The library is expressive enough for every signing style seen so far: a hex-secret hash over named fields, a header signature over the raw body, and a sorted-values hash with the secret prepended. 

### 5.3 Body formats and extraction 

Requests and responses can be JSON, form-urlencoded, multipart, XML or SOAP, or plain text. Selectors are dot-notation JSON paths, XPath for XML (parsed with external entities and DTDs disabled), form keys, or header names. A fixed pattern language (RE2-style, no backtracking) is allowed for matches. A required selector that finds nothing is a failure, not a silent null. Callbacks that arrive as form posts (not JSON) are supported by the same selectors. 

### 5.4 Success checks and status mapping 

Many gateways return HTTP 200 with an error in the body. After each step the engine evaluates, in order: 

1. HTTP status set (default 2xx). 

2. Body checks {selector, equals | exists | not_equals | in}. 

3. StatusRules mapping the body to a canonical status and error. Unmapped codes on money-moving steps become UNKNOWN; unmapped codes on read-only steps are logged and retried. 

4. ErrorMap supplies the bilingual customer message and whether the failure counts toward OTP lockout. 

### 5.5 Template safety 

Because operators author templates and customers supply values, every substitution is encoded for where it lands: 

- Customer values may go into BODY, FORM, QUERY or an encoded PATH segment, never into the scheme, host or port of a URL, and never raw into a header (CR and LF are rejected). 

Page 18 of 44 

Dynamic Payment Gateway Management: Design v2 

Values inserted into XML are escaped; values inserted into JSON are serialized, never concatenated. 

- Final URLs are re-validated after substitution (https only, host on the gateway's allowed hosts, no private or link-local addresses, no redirect following, or each hop revalidated). 

- Logs store the template and redacted values, never secrets, PANs or OTPs. 

- A step may not read another gateway's credentials. Secrets resolve only from the route's own Credential Set. 

### 5.6 References, idempotency and amounts 

Our reference for the gateway comes from a generator that obeys the gateway's charset and length limits and is unique per environment (a numeric-only, 10-digit reference is a real case). The requested amount comes only from the link. The gateway amount is derived as round(scale(requested amount plus any customer-borne fee)) using the gateway's scale, precision and rounding settings, and both values are stored. A contract test sends a known amount through the pipeline and asserts the wire value (100 dinars becoming 100000 on a gateway that works in thousandths; 76.255 becoming 76.26 where two decimals apply). 

### 5.7 Credential check and capability probe 

A gateway may define a CREDENTIAL_CHECK flow (a harmless authenticated read). It runs when credentials are saved, nightly, and as a circuit-breaker half-open probe. Where a gateway offers a list of enabled methods or limits (as MyPay does per merchant), a capability probe imports them so the platform's rails match what the account is actually allowed to use. 

## 6. Mode playbooks 

Each playbook lists what the client is told to render, the phases used, the channels that confirm, and the traps. 

### 6.1 OTP_PULL (Edfali, Sadad, MobiCash, Yussor Pay, Sahara Pay, Libyana) 

- Client: customer form (phone, birth year, card number as the rail requires), then an OTP prompt with countdown and a resend control. 

- Phases: INITIATE sends the code (SENDS_NOTIFICATION, retry SAFE_WITH_COOLDOWN) and stores a process id; SUBMIT confirms with process id, code, amount and our invoice or reference (MOVES_MONEY, retry NEVER, point of no return); VERIFY exists only if the gateway has a status endpoint. 

Page 19 of 44 

Dynamic Payment Gateway Management: Design v2 

   - Confirms by: SYNC_RESPONSE; INQUIRY where available; STATEMENT otherwise. Traps: a correct OTP followed by a timeout is UNKNOWN and the same OTP is never resubmitted; wrong-OTP counters are per attempt and per phone; resend is capped (SMS-pumping guard); the gateway's OTP lifetime (for example 10 minutes) wins over ours; the birth-year or card number is a sensitive field. 

- 6.2 REDIRECT (T-LYNC, MyPay, DPay hosted checkout, hosted card pages, 3-D Secure) 

   - Client: a redirect instruction, as a GET redirect or an auto-submitted POST form built from PUBLIC outputs, plus a waiting page that can resume if the browser comes back some other way. 

   - Phases: INITIATE creates the hosted session (token call first where the gateway needs one) and returns the redirect target; VERIFY is the inquiry. 

   - Confirms by: WEBHOOK (signature or IP allow-list; must_inquire for weak ones) and RETURN_URL (a hint that triggers VERIFY); POLL as the safety net. 

   - Traps: return and webhook race (section 9.4); return parameters can be tampered with; the customer may close the tab and the webhook still arrives; an in-app browser may block the redirect; the return URL carries only our unguessable attempt token. 

- 6.3 EMBEDDED (Moamalat Lightbox, hosted card fields) 

   - Client: the page loads the allow-listed script, opens the widget with server-computed configuration, and reports widget events to our client-event endpoint as hints. 

   - Phases: INITIATE is a COMPUTE step that builds the signed configuration (amount in the gateway's unit, reference, timestamp, secure hash) with no HTTP call; VERIFY is the inquiry by network and merchant reference. 

   - Confirms by: WEBHOOK from allow-listed IPs with must_inquire, BROWSER_CALLBACK as a hint, POLL as fallback. 

   - Traps: the secret never reaches the browser; a completed event in the page proves nothing; script hosts and CSP are tightly controlled; pop-up blockers and in-app browsers can stop the widget, so a REDIRECT route on the same rail is the fallback when one exists. 

- 6.4 PUSH_APPROVAL (GPay, Numo Pay, Hawelli, EVO Pay, wallet-by-phonenumber) 

   - Client: a form for the wallet number or phone, then a waiting screen (check your wallet app) with a cancel control and the expiry countdown. 

   - Phases: INITIATE sends the payment request; CANCEL withdraws it when supported; VERIFY or webhook decides. 

Page 20 of 44 

Dynamic Payment Gateway Management: Design v2 

- Confirms by: WEBHOOK and POLL with backoff until expiry; INQUIRY at expiry before declaring EXPIRED. 

- Traps: the customer may approve after our expiry; the customer may reject (a definitive failure, offer another rail); a request to a wrong or unregistered number must not reveal whether the account exists. 

6.5 QR_DISPLAY (OnePay, wallet QR) and PAY_CODE (Yussor Pay code, OnePay SMS) 

- Client: the QR image or the code plus bilingual instructions (which app, which menu, which number to text), with a countdown. On POS, the same screen is pushed to the POS screen in realtime and the cashier sees status change. 

- Phases: INITIATE asks the gateway for the QR payload or code (or builds it locally where the scheme allows); no SUBMIT step. 

- Confirms by: WEBHOOK, POLL, STATEMENT. 

- Traps: a static QR reused across attempts causes mismatched matching, so each attempt gets a unique code or amount; a customer who pays twice with the same QR (duplicate-payment handling); a QR that outlives the attempt; cross-bank payments settling to a different account than expected. 

### 6.6 DEEP_LINK 

   - Client: a button that opens the wallet app with the payment prepared, plus a fallback to QR or code if the app is not installed. A return deep link brings the customer back to the waiting page. 

   - Confirms by: the same channels as PUSH_APPROVAL. The return to our page is never proof of payment. 

   - Traps: desktop browsers have no app to open; link schemes can be hijacked, so the link carries no secrets. 

- 6.7 MANUAL (bank transfer, cash agent, gateways without usable APIs) 

   - Client: transfer instructions with our unique payment reference, expiry, and optionally a proof-of-payment upload. 

   - Phases: INITIATE only renders the instructions and opens an operator task. 

   - Confirms by: STATEMENT match first (automatic), otherwise OPERATOR_CONFIRMATION under maker-checker. 

   - Traps: customers omit or mistype the reference (unmatched statement lines open cases); long expiries tie up single-use links; proof images need malware scanning and are never treated as proof by themselves. 

Page 21 of 44 

Dynamic Payment Gateway Management: Design v2 

### 6.8 HYBRID 

The rail declares several sub-modes (for example QR, pay code and OTP). The customer picks one, and the attempt records which. Each sub-mode has its own flow and channels; the state machine and ledger path are shared. 

## 7. Illustrative flow definitions 

Field names follow public SDKs, not official gateway documents; they show the shape of the configuration, not verified contracts. Placeholders stand in for real URLs. 

A. OTP through a two-step API (Edfali, Sadad, MobiCash, Yussor Pay, Sahara Pay shape) 

```
rail: edfali   mode: OTP_PULL   fields: phone (regex ^09[0-9]{8}$), otp (4 to
6 digits)
INITIATE step 1  POST {api}/verify   side_effect: SENDS_NOTIFICATION   retry:
SAFE_WITH_COOLDOWN
```

```
  body: mobile_number <- CUSTOMER_FIELD.phone ; amount <- ATTEMPT.amount
  success: body.success == true
  outputs: process_id -> STATE ; masked_phone -> PUBLIC
  status: success => AWAITING_CUSTOMER/OTP_REQUIRED
SUBMIT step 1    POST {api}/confirm  side_effect: MOVES_MONEY   retry: NEVER
point_of_no_return
  body: process_id <- STATE.process_id ; code <- CUSTOMER_FIELD.otp ;
        amount <- ATTEMPT.amount ; invoice_no <- ATTEMPT.reference
  status: success => SUCCEEDED ; wrong code => stay AWAITING_CUSTOMER
(otp_attempts + 1) ;
          timeout, 5xx or unmapped => UNKNOWN
VERIFY: none on this rail => statement reconciliation
```

B. Embedded widget with a server-computed hash (Moamalat Lightbox shape) 

Page 22 of 44 

Dynamic Payment Gateway Management: Design v2 

```
rail: moamalat-card   mode: EMBEDDED   fields: none (card entered inside the
widget)
meta: MID, TID, SECRET (hex, secret), notification key, inbound IP allow-list
INITIATE step 1  COMPUTE (no HTTP)
  AmountTrxn        <- ATTEMPT.amount |> scale(1000) |> to_int
  MerchantReference <- ATTEMPT.reference (numeric format)
  TrxDateTime       <- NOW |> format_date(pattern per gateway docs,
Africa/Tripoli)
  SecureHash        <- hmac_sha256(key = SECRET as hex, message = canonical
string of signed fields) |> upper_hex
  outputs PUBLIC: MID, TID, AmountTrxn, MerchantReference, TrxDateTime,
SecureHash
  widget: LIGHTBOX (allow-listed script); complete, cancel, error => POST
/attempts/{id}/client-event
VERIFY step 1    POST {inquiry} by network reference and merchant reference
READ_ONLY
  success: approved response code AND amount == expected AND reference ==
ours
channels: BROWSER_CALLBACK (hint, must_inquire) ; WEBHOOK from allow-listed
IPs (must_inquire) ; POLL
```

#### C. Hosted checkout with a token and a signed webhook (MyPay and T-LYNC shape) 

```
rail: mypay-edfali   mode: REDIRECT   auth: TOKEN_ENDPOINT (client id and
secret)
INITIATE step 1  POST {api}/payment/create   side_effect: SENDS_NOTIFICATION
  body: amount <- ATTEMPT.amount ; order_id <- ATTEMPT.reference ;
method_alias <- ROUTE_META.alias ;
        return_url, cancel_url, webhook_url <- URLS
  outputs: redirect_url -> PUBLIC ; provider_ref -> STATE
channels: WEBHOOK (HMAC over raw body, header X-MyPay-Signature, must_inquire
if no inquiry-free trust)
          RETURN_URL (hint, triggers VERIFY) ; POLL
environments: sandbox base path differs from live; credentials never shared
```

#### D. Pay code or QR with delayed confirmation (OnePay, Yussor Pay code shape) 

```
rail: onepay-qr   mode: QR_DISPLAY (sub-mode of a HYBRID rail)
INITIATE step 1  POST {api}/qr   body: amount, reference <-
ATTEMPT.reference, expires_at
  outputs: qr_payload -> PUBLIC ; request_id -> STATE
channels: WEBHOOK ; POLL (5, 10, 20, 40, 60 seconds until expiry) ; STATEMENT
expiry: min(gateway TTL, platform TTL) ; CANCEL step on customer cancel when
supported
```

Page 23 of 44 

Dynamic Payment Gateway Management: Design v2 

## 8. Attempt state machine 

```
CREATED -> INITIATING -> AWAITING_CUSTOMER -> AUTHORIZING -> VERIFYING ->
SUCCEEDED
               |               |   (OTP_REQUIRED, REDIRECT_PENDING,
WIDGET_OPEN,
               |               |    PUSH_PENDING, QR_PENDING, CODE_PENDING,
TRANSFER_PENDING)
               |               +-------------------------------------->
FAILED, EXPIRED, CANCELLED
               +--> BLOCKED (velocity or AML)
any step -> UNKNOWN -> (inquiry, reconciliation, operator) -> SUCCEEDED or
FAILED
SUCCEEDED -> PARTIALLY_REFUNDED -> REFUNDED      SUCCEEDED -> DISPUTED
(chargeback)
```

Rules: 

1. Pinned configuration. The attempt stores gateway_version_id, route_id and credential_set_id at creation; edits never change a running attempt. 

2. Reservation. Creating an attempt reserves one use of the link inside the same transaction as the guard and velocity checks. The reservation is released on FAILED, EXPIRED or CANCELLED and kept through UNKNOWN. A single-use link cannot have two live reservations. 

3. Expiry. expires_at = min(gateway session TTL, platform TTL). After expiry the attempt moves to EXPIRED, but a grace window keeps the inbox open for late events. 

4. Terminal states are SUCCEEDED, FAILED, EXPIRED, CANCELLED and BLOCKED. Only a verified late event, reconciliation or an operator can move EXPIRED or FAILED to SUCCEEDED, and that always raises an operator alert. 

5. OTP limits. otp_attempts is capped per attempt (for example 3) and per customer identifier per hour; resend has a cooldown and a cap. A lockout never reveals whether the account exists. 

6. State only moves forward. A success is never downgraded by a later pending or failure event; a conflicting pair is flagged for review. 

7. Each transition writes the audit trail with actor (customer, gateway, worker, admin), time, old and new state, and the step or event that caused it. 

8. Ledger posting happens in the same database transaction as the move to SUCCEEDED, guarded by a unique constraint on ledger_entry_id per attempt so a duplicate event cannot post twice. 

9. Realtime. Each state change is pushed to the customer page and, for POS, to the POS screen's realtime room. 

Page 24 of 44 

Dynamic Payment Gateway Management: Design v2 

## 9. Confirmation and verification 

### 9.1 The inbound receiver 

Each gateway environment gets one public endpoint with a random path token, for example /inbound/{gateway}/{env}/{token}. Processing order: 

1. Reject bodies over the size limit and non-matching content types. 

2. Check the source IP against inbound_ip_allowlist when one is configured. Resolve the real client IP carefully (trusted proxy hops only). 

3. Store the raw event in the inbox first, then acknowledge quickly with the response the gateway expects (ack_template). Everything else runs asynchronously from the inbox. 

4. Verify the signature or token with a constant-time comparison against all active secret versions, and check the timestamp tolerance if the gateway sends one. 

5. Compute the dedupe key; a repeat is acknowledged and ignored. 

6. Correlate to an attempt using the configured selector (our reference or the provider reference). 

7. If the channel is must_inquire, run the VERIFY flow and decide from the inquiry, not from the event. 

8. Move the attempt through the state machine and, on SUCCEEDED, call the Ledger Poster. 

The Ledger Poster is the only component allowed to post a payment, and it is called once per attempt. A native adapter cannot post either. 

### 9.2 Verification methods 

|Method|How it works|Rule|
|---|---|---|
|HMAC_BODY|HMAC over the raw body,<br>signature in a header (the<br>MyPay style)|Strong; use the raw bytes,<br>never a re-serialized body|
|HASH_FIELDS|Hash or HMAC over named<br>fields in a fixed order with a<br>secret (the Moamalat secure<br>hash style)|Strong if the field list and order<br>come from the gateway's<br>documents|



Page 25 of 44 

Dynamic Payment Gateway Management: Design v2 

|Method|How it works|Rule|
|---|---|---|
|SORTED_VALUES_HASH|Remove the hash field, sort<br>the remaining keys, join the<br>values with the secret<br>prepended, hash (a common<br>callback-hash style, seen on<br>card services behind<br>aggregators)|Medium; the canonicalization<br>must match exactly, so a<br>contract test with a captured<br>sample is mandatory|
|RSA|Gateway signs with its<br>private key; we hold its public<br>key|Strong; keep key versions for<br>rotation|
|SHARED_TOKEN|A static token in a header or<br>path|Weak alone; pair with IP allow-<br>list and must_inquire|
|IP_ONLY|Source IP on an allow-list<br>(Moamalat and T-LYNC style)|Never enough alone; pair with<br>must_inquire or an<br>unguessable path token|
|NONE_PLUS_INQUIRY|No signature; the event is a<br>doorbell and the inquiry<br>decides|Allowed only when the gateway<br>has a status endpoint|



A gateway with neither a signature nor an inquiry is flagged HIGH RISK in the catalog, needs an explicit risk acceptance to go live, and has mandatory statement reconciliation. 

### 9.3 What counts as trusted success 

An attempt becomes SUCCEEDED only when a trusted source confirms all of: status success, our reference, the expected amount (within the gateway's rounding policy), the expected currency, and the correct environment. Trusted sources, strongest first: a verified inquiry response, a verified webhook, a synchronous confirm response on an OTP rail, a statement match, an operator confirmation under maker-checker. A browser callback or return URL alone is never enough. 

Mismatch policy per route: 

|Situation|Options|Default|
|---|---|---|
|Settled amount|CREDIT_REQUESTED,|HOLD when the|
|differs from|CREDIT_SETTLED_MINUS_FEE,|difference exceeds|
|requested (rounding,|HOLD_FOR_REVIEW|the route's|
|fee on top)||tolerance|



Page 26 of 44 

Dynamic Payment Gateway Management: Design v2 

|Situation|Options|Default|
|---|---|---|
|Settled lower than|HOLD_FOR_REVIEW,|HOLD|
|requested beyond|REJECT_AND_REFUND||
|tolerance|||
|Overpayment|HOLD_FOR_REVIEW,<br>CREDIT_REQUESTED_AND_REFUND_DIFF|HOLD|
|Reference matches|HOLD_FOR_REVIEW|HOLD|
|but currency differs|||



A held attempt does not post to the merchant wallet. Its funds sit in the AML Hold or a dedicated Suspense account, and a maker-checker Adjustment resolves it. 

### 9.4 Races, late events, duplicates and order 

- Return versus webhook: both paths request the same row lock on the attempt. The first moves PENDING to SUCCEEDED and posts the ledger entry; the second reads SUCCEEDED, skips posting and returns the recorded result. 

- Late events: the inbox stays open for a grace window after expiry (default 24 hours, indefinitely for gateways with no status endpoint). A verified late success on an EXPIRED or FAILED attempt moves it to SUCCEEDED, posts the entry if the link can still accept it, and raises an alert. If the link is already satisfied (a single-use link paid by another attempt) the payment goes to the refund pipeline. 

- Duplicates: deduped by key; the Ledger Poster is idempotent per attempt. 

- Order: state only moves forward; a success is never downgraded; conflicting signals (webhook says success, inquiry says failed) leave the attempt UNKNOWN, post nothing and open an operator case. 

- Early events: an event that arrives before the INITIATE response is committed is kept and retried for correlation for a short period (for example 60 seconds), then parked and alerted. 

- Events for unknown references are stored with no effect and alert on volume (they may belong to another environment). 

### 9.5 Polling, inquiry and reconciliation 

- Polling follows the route's PollPolicy and stops at a terminal state. It is the main safety net for PUSH_APPROVAL, EMBEDDED, REDIRECT, QR and PAY_CODE rails. 

- Inquiry on demand: operators can trigger the VERIFY flow for any non-terminal attempt. The engine triggers it automatically at expiry (before declaring EXPIRED), for UNKNOWN attempts, and when a hint arrives from a return URL or browser callback. 

Page 27 of 44 

Dynamic Payment Gateway Management: Design v2 

- Reconciliation: a scheduled job ingests the gateway statement through StatementSource (API, SFTP or manual upload with the configured column mapping) and matches by provider reference, our reference, amount and date. Results are MATCHED, AMOUNT_MISMATCH, MISSING_AT_GATEWAY, MISSING_LOCALLY and DUPLICATE. Anything unmatched opens an operator case, and if money moved without a SUCCEEDED attempt, a maker-checker Adjustment. 

- Rails with no status endpoint: UNKNOWN is resolved only by statement or by contacting the gateway. The dashboard shows an awaiting-gateway-statement state, and the customer sees we are confirming your payment, never failed. 

- Manual statement uploads are idempotent: re-uploading the same file creates no new matches. 

## 10. Money: amounts, fees and the ledger 

### 10.1 Amounts 

The link amount is the single source of truth and is never taken from the client. Per route the engine derives gateway_amount as described in 5.6, and stores requested, gateway and settled amounts. Rail currency must equal link currency or the rail is hidden. Foreigncurrency or cross-currency rails (for example a card rail that settles in another currency) are out of scope until a rate-snapshot design is approved; the schema keeps currency on every record so that extension is possible. 

### 10.2 Fee models and bearers 

Route cost is flat, percent or tiered with a minimum and a maximum, effective-dated and versioned like the Commission Profile. The fee bearer is PLATFORM, MERCHANT or CUSTOMER (a surcharge shown before confirmation). Provider-reported fees from the confirm call or statement overwrite estimates, and differences are tracked as fee variance. 

### 10.3 Ledger for platform-held settlement 

The proposal says every confirmed payment lands in the single Treasury Account. Gateways that pay out later, or into a bank account the platform does not see in real time, break that assumption. Draft v2 keeps one Gateway Clearing Account per gateway, environment and credential set: a receivable representing money the gateway owes us until it settles. Supporting accounts: Gateway Fee Expense, Gateway Fee Accrual (a payable for fees we owe or have been charged), and Suspense (unmatched or held funds). Confirmed payment, 100 LYD, 3% commission, platform-borne gateway fee 0.8 (accrual option on): 

Page 28 of 44 

Dynamic Payment Gateway Management: Design v2 

```
Dr Gateway Clearing (G)     100
   Cr Merchant Wallet (M)    97
   Cr Income Account          3
Dr Gateway Fee Expense      0.8
   Cr Gateway Fee Accrual   0.8
```

Settlement received, statement shows 99.2 net: 

```
Dr Treasury Account        99.2
Dr Gateway Fee Accrual      0.8
   Cr Gateway Clearing (G)  100
```

If the statement fee is 0.9 instead of 0.8, the extra 0.1 posts to Gateway Fee Expense as variance. With the accrual option off, the full fee posts to Gateway Fee Expense at settlement. 

Customer-borne fee (customer pays 100.8 for a 100 link, gateway deducts 0.8): 

```
At confirmation:  Dr Gateway Clearing 100.8 / Cr Merchant Wallet 97 / Cr
Income 3 / Cr Gateway Fee Accrual 0.8
At settlement:    Dr Treasury 100 / Dr Gateway Fee Accrual 0.8 / Cr Gateway
Clearing 100.8
```

For gateways that settle directly into the platform's bank account the same day, the two entries post the same day, so one model covers both. The reconciliation invariant becomes: the sum of debit-balance accounts (Treasury, every Gateway Clearing, Gateway Fee Expense) equals the sum of credit-balance accounts (Wallets, Income, AML Hold, Chargeback Reserve, Suspense, Gateway Fee Accrual, Commission-related payables). A daily check also compares each Clearing balance with the gateway's reported pending settlement, and drift alerts and halts payouts as in the proposal. 

### 10.4 Ledger for merchant-owned, directly settled accounts 

When the Credential Set is owned by the merchant and settles directly to the merchant, no money enters the platform: 

```
Confirmed payment 100, commission 3:
Dr Merchant Commission Receivable  3
   Cr Income Account               3
```

Commission is collected by netting against the merchant's wallet balance (Dr Merchant Wallet, Cr Commission Receivable), by invoice, or by a card on file, per merchant policy. The merchant wallet is not credited for these payments, but statistics and reports include them, tagged DIRECT. Controls: a per-merchant receivable ceiling, automatic pause of the 

Page 29 of 44 

Dynamic Payment Gateway Management: Design v2 

merchant's direct routes when the ceiling is passed, and a clear display that this balance is owed to the platform. Velocity, AML screening and the hold rules still apply to the decision to accept the attempt, but a hold cannot freeze money the platform never received. A held direct payment therefore blocks the link's completion message, flags the merchant and opens an AML case, and the case outcome is operational (notify, suspend, report) rather than a ledger release. 

### 10.5 Refunds, voids and chargebacks 

A rail's capabilities decide what is offered: VOID before settlement, REFUND (full or partial) within refund_window_days, or manual external refund only. Every refund or chargeback is an Adjustment under maker-checker. If the gateway supports an API refund, the executed Adjustment triggers the REFUND flow; a failed or UNKNOWN refund call keeps the Adjustment in an EXECUTING state and uses the same inquiry and reconciliation machinery. Refund evidence (the provider refund reference) is mandatory before the ledger reversal posts for rails that settle externally. A dispute event from a gateway auto-drafts an Adjustment that still needs checker approval. For merchant-direct accounts the refund or dispute happens on the merchant's own gateway account; the platform records it and reverses commission under the commission policy. 

### 10.6 Sandbox money 

Sandbox attempts carry env = SANDBOX, never post to the ledger, are excluded from merchant balances, statistics and AML, and use clearly marked test links visible only to roles with the testing permission. 

## 11. Routing, failover and health 

- Ranking: for a given rail and amount, candidate routes are ACTIVE, healthy, within min and max amount, within the daily cap and maintenance window, in scope for the merchant, application and channel (WEB, API, POS), and backed by a usable Credential Set. They are ordered by effective cost ascending, then priority descending, then a deterministic tiebreak (the voucher comparator). An admin can also choose weighted or strict priority per rail. 

- One entry per rail at checkout: if a rail has routes with different modes (Edfali direct as OTP, Edfali via an aggregator as hosted checkout), the customer sees one Edfali button and the winning route decides the mode. A rail may instead be configured to expose both as choices. 

- Failover is allowed only before the point of no return and only on a definitive failure at INITIATE. After the customer has been sent an OTP, a redirect, a widget session, a push request or a QR, the attempt is bound to that route. A customer who restarts gets a 

Page 30 of 44 

Dynamic Payment Gateway Management: Design v2 

new attempt (same attempt group) and the old one is cancelled through its CANCEL flow when supported, or left to expire while still being watched. 

- Circuit breaker per route: opens after N consecutive definitive failures or an error rate above a threshold over a window, counting only gateway-caused failures (customer errors such as a wrong OTP or a per-customer limit do not count). Half-open probes use the credential check or a read-only inquiry. An open breaker hides the route; when no route remains the rail disappears from checkout. 

- Drain and replace: set a route to DRAINING to move traffic elsewhere without losing in-flight attempts. 

- Scoping: a route can be limited to certain merchants, applications, channels or risk tiers, so a gateway account that belongs to one merchant is never used for others. 

- Direct versus aggregator: aggregators launch faster and cover several rails with one contract, but add a party to the settlement chain, a fee layer and a shared failure domain. Direct routes avoid that but need one contract and one profile per gateway. Because both are just routes on the same rail, the choice can differ per rail and change over time without touching links. 

- Rate limiting: per-route outbound limits and concurrency caps protect gateway accounts that throttle. 

## 12. Security 

- Roles: GATEWAY_ADMIN (draft configs, test), SECURITY_ADMIN (credentials, allowlists, widget scripts, CSP), FINANCE (routes, fees, settlement, statements), OPERATOR (read attempts, trigger inquiry, resolve UNKNOWN), MERCHANT_ADMIN (manage only their own Credential Sets), plus the platform's maker and checker eligibility flags. Revealing a stored credential is impossible; only replacing it is. 

- Maker-checker scope (added to section 12 of the proposal): create or edit a gateway version, set a route LIVE, change credentials or webhook secrets (platform or merchant), change inbound IP allow-lists, change fees or limits, change statement parsers, enable a native adapter, add a script host to the widget allow-list, resolve UNKNOWN, held or mismatched attempts, confirm MANUAL payments, and any refund. 

- Secrets: encrypted at rest with key ids for rotation; webhook secrets have overlapping versions (new and old valid together for a window); credentials never appear in logs, exports or error messages; configuration export and import omit secrets. 

- SSRF: admin-entered and merchant-entered URLs must be https, resolve through DNS, block private, loopback and link-local ranges, disable redirects or re-validate each hop, cap response size, and may be restricted to an allow-list of gateway hosts. Outbound calls leave from fixed egress IPs that can be given to gateways. 

Page 31 of 44 

Dynamic Payment Gateway Management: Design v2 

- Inbound endpoints: random path tokens, size and rate limits, strict content types, no reflection of input in responses, and alerts when valid signatures arrive from unlisted IPs. 

- Card data scope: the platform prefers hosted, redirected or embedded card capture so the PAN never reaches our servers. Some Libyan OTP rails ask for a card or transaction card number; those fields are marked PAN, kept only in memory for the single call, excluded from state, logs, analytics and error reports, and the rail goes through a PCI scope review before launch. 

- Personal data: phone numbers, birth years and wallet identifiers are personal data. They are masked in the UI, stored encrypted, retained only as long as the regulatory period requires, and never sent to analytics. The retention period must be confirmed with legal counsel and the central bank's requirements. 

- Embedded widgets: script hosts come from an allow-list; the checkout page uses a per-page CSP that adds only the gateway's hosts; widget iframes use sandbox and postMessage origin checks; the page never trusts a widget's success event. 

- Checkout hardening: attempt tokens are unguessable, short-lived and bound to the link; CSRF protection on all state-changing calls; frame-ancestors to prevent clickjacking; the redirectUrl must match an allow-list on the Application to prevent open redirects; Arabic-Indic digits are normalized before validation. 

- Abuse controls: reuse the proposal's velocity rules on OTP sends (per phone, per IP, per link, per rail), generic error messages that do not reveal whether an account exists, and an SMS-pumping guard that caps OTP sends per link and per hour. 

- Auditing and retention: every configuration change, approval and manual resolution is audited with before and after; raw inbox events and step logs are retained for the regulatory period with sensitive fields redacted at write time. 

## 13. Edge-case catalog 

### A. Lifecycle and timing 

|#|Situation|Handling|
|---|---|---|
|1|Customer closes the browser after the<br>OTP was sent or mid-redirect|Attempt stays pending; the page resumes<br>from server state with the attempt token;<br>an inquiry runs at expiry before declaring<br>EXPIRED|
|2|Reload or back button on the OTP screen|UI reads state from the server; no second<br>INITIATE; resend needs cooldown and|
|||cap|



Page 32 of 44 

Dynamic Payment Gateway Management: Design v2 

|#|Situation|Handling|
|---|---|---|
|3|Gateway session expires before ours (10<br>to 15 minutes on some rails)|expires_at = min(gateway TTL, platform<br>TTL); countdown shown; late submit<br>rejected locally|
|4|Repeated wrong OTP|Cap per attempt and per identifier;<br>generic message; only mapped customer<br>errors count|
|5|Correct OTP but the confirm call times<br>out|UNKNOWN; the same OTP is never<br>resubmitted; inquiry, polling, statement|
|6|Server restart during an attempt|Durable expires_at and next_check_at;<br>workers resume; locks are database-<br>backed, not memory-only|
|7|Two tabs or devices on the same link|Reservation inside the guard transaction;<br>attempt group; the second sees a<br>payment in progress|
|8|Customer retries while the previous<br>attempt is UNKNOWN|The link's reservation is held; the<br>customer sees payment being confirmed<br>until resolved|
|9|Customer switches rail mid-flow|Old attempt cancelled via CANCEL or left<br>to expire and watched; new attempt in<br>the same group; at most one may<br>succeed|
|10|Customer pays after expiry (push<br>approved late, QR scanned late)|Grace window; a verified late success is<br>accepted and alerted, or refunded if the<br>link is already satisfied|
|11|Clock skew and time zones|UTC internally; gateway time zone in<br>format_date; tolerance windows; never<br>assume a fixed offset|
|12|Link expires between page load and<br>submit|Submit re-checks inside the guard<br>transaction; clear message|
|13|Link use count reached while an attempt<br>is in flight|Reservations count toward use; an in-<br>flight attempt that later succeeds on a<br>satisfied link goes to duplicate-payment<br>handling|
|14|POS screen hits its 15-minute idle<br>timeout while a QR is pending|The attempt continues and is watched;<br>the result shows on reconnect; the<br>cashier can look it up by reference|



Page 33 of 44 

Dynamic Payment Gateway Management: Design v2 

### B. Confirmation and trust 

|#|Situation|Handling|
|---|---|---|
|15|Webhook arrives before the INITIATE<br>response is stored|Held in the inbox and re-correlated for a<br>short window, then parked and alerted|
|16|Webhook for an unknown reference|Stored, no effect, alert on volume (may<br>belong to another environment)|
|17|Duplicate webhooks|Deduped by key; Ledger Poster<br>idempotent per attempt|
|18|Out-of-order events|State moves forward only; success is<br>never downgraded; conflicts flagged|
|19|Success arrives after EXPIRED or FAILED|Verified late success accepted and<br>alerted, or refunded if the link is<br>satisfied|
|20|Webhook says success, inquiry says<br>failed|Conflict: no posting, attempt<br>UNKNOWN, operator case|
|21|Browser widget says success, no server<br>confirmation|Stays VERIFYING with polling; shows<br>confirming; becomes UNKNOWN after<br>the window|
|22|Forged webhook|Path token, IP allow-list, signature,<br>mandatory inquiry for weak channels|
|23|Replayed old webhook|Timestamp tolerance and dedupe; with<br>no timestamp, dedupe on event id or<br>body hash|
|24|Gateway retries because our<br>acknowledgement was slow|Acknowledge from the inbox before<br>processing; dedupe absorbs the retries|
|25|Valid signature but amount, currency or<br>environment differs|Mismatch policy; never credit on the<br>event's amount alone|
|26|Sandbox event hits a live endpoint (or the<br>reverse)|Separate endpoints and secrets; reject<br>and alert|
|27|Gateway silently changes signature<br>algorithm or field order|Signature-failure spike alert; overlapping<br>verification configs; contract tests on<br>captured samples|



Page 34 of 44 

Dynamic Payment Gateway Management: Design v2 

|#|Situation|Handling|
|---|---|---|
|28|Return URL parameters tampered with|Ignored for decisions; they only trigger<br>an inquiry|
|29|Callback arrives as a form post, in another<br>charset, or as XML|body_format and charset handling; raw<br>bytes retained for signature checks|
|30|Callback source IP is hidden behind a<br>proxy or changes|Trusted-proxy parsing; alert on unlisted<br>IPs; allow-list change through maker-<br>checker|
|31|Gateway has neither signature nor<br>inquiry|HIGH RISK; risk acceptance; mandatory<br>statement reconciliation; operator<br>confirmation above a threshold|



### C. Money 

|#|Situation|Handling|
|---|---|---|
|32|Settled differs from requested<br>(rounding, fee on top)|Route mismatch policy; HOLD above<br>tolerance|
|33|Amount scale error (1000 times too high<br>or low)|amount_scale setting, contract test<br>before go-live, and a sanity bound against<br>the link amount|
|34|Currency other than LYD|Rail currency must equal link currency,<br>otherwise the rail is hidden|
|35|Customer-borne fee|Total shown before confirmation; ledger<br>per 10.3|
|36|Per-customer ceilings (wallet or instant-<br>payment limits)|Canonical LIMIT_EXCEEDED with a<br>message suggesting another rail; not<br>counted against gateway health|
|37|Gateway minimum or maximum changes|Route limits plus optional live-limit fetch<br>that fails open; the gateway stays the<br>authority|
|38|Partial payment or overpayment|Mismatch policy; no partial capture<br>unless the link allows it|
|39|Refund after settlement, past the<br>window, or on a rail without refunds|Capability check; manual Adjustment<br>with external refund evidence|



Page 35 of 44 

Dynamic Payment Gateway Management: Design v2 

|#|Situation|Handling|
|---|---|---|
|40|Chargeback or dispute event|Auto-drafted Adjustment; checker<br>approval before the reversing entry|
|41|Second success on a single-use link|Duplicate-payment handling: refund or<br>void pipeline, operator alert|
|42|Settlement has missing or extra lines|Reconciliation items; Clearing drift alert|
|43|Gateway settles in batches net of fees<br>and refunds|Statement parser supports batch lines;<br>match by batch reference, then break<br>down|
|44|Gateway fee changes mid-month|Route cost is versioned and effective-<br>dated; fee variance report|
|45|Three-decimal amount on a two-decimal<br>gateway|gateway_amount stored; tolerance and<br>rounding direction fixed in the contract<br>test; credit policy per route|
|46|Commission rounding leaves a sub-dinar<br>remainder|Rounding rule in the Commission Profile;<br>remainder posts to Income so the entry<br>balances|
|47|Statement in another encoding,<br>separator or date format|Parser configuration: encoding,<br>separators, date format, time zone;<br>preview before activation|
|48|Merchant-direct commission not paid|Receivable ceiling; automatic pause of<br>direct routes; netting against wallet|



### D. Routing and availability 

|#|Situation|Handling|
|---|---|---|
|49|Gateway down at INITIATE|Definitive failure; next route before the<br>point of no return; breaker counts|
|50|Gateway slow or flapping|Timeouts; breaker DEGRADED; rail<br>hidden if no healthy route|
|51|Bank or wallet maintenance windows|Route maintenance schedule hides the<br>rail in advance|
|52|Gateway retired, merged or moved to<br>another operator|DRAINING; rail re-routed; history keeps<br>the old gateway name|



Page 36 of 44 

Dynamic Payment Gateway Management: Design v2 

|#|Situation|Handling|
|---|---|---|
|53|The only route for a rail opens its breaker|Rail hidden; links unaffected; alert|
|54|Aggregator down while the underlying<br>gateway is up|A direct route as second route; breaker<br>per route|
|55|Aggregator and direct routes both<br>enabled and the customer tries both|Attempt group; one success; the other<br>cancelled or refunded|
|56|Gateway rate-limits us (429)|Backoff; concurrency cap; only SAFE<br>steps retried|
|57|Gateway changes its API silently|Unmapped responses become<br>UNKNOWN on money steps; error-spike<br>alert; synthetic probes and contract<br>tests|
|58|Daily cap reached on a route|Route excluded; next route; if none, the<br>rail is hidden|



### E. Credentials and ownership 

|#|Situation|Handling|
|---|---|---|
|59|Merchant enters wrong credentials|Credential check at save; the set stays<br>UNTESTED until verified|
|60|Merchant credentials expire or are<br>revoked at the gateway|Scheduled checks; route hidden;<br>merchant and operators notified; in-flight<br>attempts finish|
|61|Credential or secret rotation|Overlapping versions; sandbox test<br>before switch; maker-checker|
|62|Token refresh failure|Single-flight refresh, keep the old token,<br>retry sooner, alert on repeats|
|63|Two merchants register the same<br>gateway account|Duplicate detection on the gateway's<br>merchant identifier; block and review|
|64|Merchant moves from direct to platform-<br>held settlement|New Credential Set and route; history<br>untouched; in-flight attempts stay<br>pinned|
|65|Merchant suspended with attempts in<br>flight|Attempts finish; no new ones; held funds<br>follow merchant policy|



Page 37 of 44 

Dynamic Payment Gateway Management: Design v2 

|#|Situation|Handling|
|---|---|---|
|66|Platform credentials used for a merchant<br>they are not scoped to|Scope enforced in the ranker and again in<br>the orchestrator; tested|
|67|Merchant-direct payment triggers an|Operational case only (10.4): flag, notify,|
||AML hold|suspend or report|



### F. Configuration and operations 

|#|Situation|Handling|
|---|---|---|
|68|Admin edits a flow while attempts are in<br>flight|Attempts are pinned to their version|
|69|A bad configuration reaches LIVE|SANDBOX_VERIFIED gate, scenario suite,<br>canary rollout, named rollback version|
|70|Two admins edit the same gateway|Separate drafts; changes merge by<br>creating a new version; optimistic<br>concurrency|
|71|Sandbox traffic reaching production|Separate environments, credentials,<br>endpoints and ledger effect|
|72|Reference length or charset limits,<br>collisions|reference_format generator plus a unique<br>constraint; regenerate before sending|
|73|Name collisions (Sadad elsewhere, EVO<br>Payments the acquirer)|Identity is operator plus country plus<br>code; aliases for spelling variants; catalog<br>warnings|
|74|An imported template targets another<br>environment|Import omits secrets; requires re-entry<br>and re-verification; UNVERIFIED until<br>partner documents arrive|
|75|Maker leaves or no checker is available|Pending approvals reassignable by role; no<br>self-approval ever|
|76|Configuration export leaks secrets|Exports contain references only|
|77|Many attempts stuck in UNKNOWN|Operator queue with SLA, bulk inquiry;<br>alert when age passes the SLA|
|78|Migration from existing coded rails|Existing adapters register as<br>NATIVE_ADAPTER gateways with one<br>route each; links untouched|



Page 38 of 44 

Dynamic Payment Gateway Management: Design v2 

|#|Situation|Handling|
|---|---|---|
|79|Deleting a rail or gateway that has<br>history|Blocked or RETIRED; snapshots retained|



### G. Security and abuse 

|#|Situation|Handling|
|---|---|---|
|80|Client tampers with amount or currency|The client never sends amounts; the<br>server derives them|
|81|PAN typed into our form|Memory-only, redacted, PCI scope<br>review; prefer hosted capture|
|82|Account enumeration through OTP<br>errors|Generic messages; rate limits|
|83|OTP or SMS pumping|Caps per phone, IP, link, rail and hour;<br>prefix-based limits|
|84|Open redirect or clickjacking|Redirect allow-list; frame-ancestors;<br>sandboxed iframes|
|85|Oversized or malicious gateway<br>response|Size caps, JSON depth limit, XML entity<br>expansion disabled, timeouts|
|86|Template injection from customer fields|Encoding rules in 5.5|
|87|SSRF through an admin- or merchant-<br>entered URL|Rules in section 12|
|88|Leaked inbound path token|Rotate the token; signatures still<br>required; alert on unusual sources|
|89|Insider changes secrets or routes|Maker-checker, audit, and alerts on every<br>credential or route change|
|90|Malicious proof upload on a MANUAL rail|Type and size limits, malware scan, never<br>treated as proof on its own|



Page 39 of 44 

Dynamic Payment Gateway Management: Design v2 

### H. Customer experience and channels 

|#|Situation|Handling|
|---|---|---|
|91|Arabic-Indic digits, +218 and 09 phone<br>formats|Normalization per field type before<br>validation and sending|
|92|In-app browsers that block pop-ups or<br>third-party scripts|Detect; fall back to a redirect route if one<br>exists, else show a clear instruction|
|93|Untranslated gateway error text|ErrorMap gives bilingual messages;<br>unmapped codes show a generic<br>message and log the raw code|
|94|No wallet app installed for a DEEP_LINK<br>rail|Fall back to QR or pay code, or to another<br>rail|
|95|Cashier needs to cancel a pending QR on<br>POS|CANCEL flow if supported; otherwise<br>mark cancelled locally and keep watching|
|96|Slow OTP gateway makes the customer<br>retry|Progress state and the reservation<br>prevent a double payment|
|97|Success reached but ledger posting fails|Same database transaction, so the<br>attempt does not reach SUCCEEDED; it<br>stays VERIFYING and retries|
|98|Merchant notification sent twice|Merchant-facing events originate only<br>from ledger posting and carry an event id<br>for idempotency|



## 14. Admin experience, lifecycle and testing 

### 14.1 Add-a-gateway wizard 

1. Basics: name, operator, country, aliases, kind, collection modes, verification state. 

2. Environments and credentials: URLs, auth method, meta, secrets (shown once at entry, never again), inbound IP allow-list, ownership model and settlement target. 

3. Customer form: fields, validation, bilingual labels, sensitivity. 

4. Flows: step builder per phase with parameters, transforms, success checks, sideeffect, retry and idempotency flags, point of no return. 

5. Confirmation: channels, verification method, correlation, dedupe, acknowledgement, polling. 

6. Mapping: status rules and error map with bilingual customer messages. 

Page 40 of 44 

Dynamic Payment Gateway Management: Design v2 

7. Limits, fees and settlement: amount scale, precision and rounding, min and max, fee model, bearer, statement source and parser. 

8. Preview and test, then submit for approval. 

Starter templates exist for each shape (OTP two-step, hosted redirect with signed webhook, embedded widget with hash, push approval, QR or pay code, manual transfer) and for each researched gateway, marked UNVERIFIED until a partner supplies documents. 

### 14.2 Lifecycle 

DRAFT, SANDBOX_VERIFIED, PENDING_APPROVAL, LIVE, then SUSPENDED or RETIRED. A version reaches SANDBOX_VERIFIED only when the required scenario suite passes. Going LIVE needs maker-checker, a named rollback version and, for HIGH RISK gateways, an explicit risk acceptance. Canary rollout can send a configurable percentage or a named merchant allow-list through the new route first. 

### 14.3 Test console 

- Dry-run: builds each request without sending, showing resolved parameters and transform steps with secrets masked. 

- Live sandbox run: executes a phase against the sandbox and shows the redacted request, response, outputs and status mapping. 

- Scenario suite per rail: success, wrong OTP, expired OTP, insufficient funds, percustomer limit, customer cancel, gateway 5xx, timeout on confirm, malformed response, duplicate webhook, out-of-order webhook, late webhook, amount mismatch, rounding case, webhook for another environment. 

- Webhook replay: paste or capture a real event and replay it through the verifier and mapper. Signature methods are validated against a captured real sample before a version can go live. 

- Statement parser test: upload a sample file and preview the matched columns and rows. 

- Mock gateway: a built-in simulator that plays scripted responses, used for regression tests when a version changes. 

- Contract tests run on every new version and nightly in sandbox as health probes. 

### 14.4 Merchant-facing credential setup 

In the Merchant Portal a merchant can add their own gateway account for routes that allow it: a guided form built from the gateway's declared meta fields, a credential check, a status badge (UNTESTED, VERIFIED, FAILING), clear wording on who receives the money 

Page 41 of 44 

Dynamic Payment Gateway Management: Design v2 

and how commission is collected, and a maker-checker review on the platform side before the route goes live for that merchant. 

## 15. API surface and observability 

- Checkout (customer-facing): GET /links/{key} (rails, limits, fees); POST 

- /links/{key}/attempts (rail, customer fields); GET /attempts/{id} (state and public outputs); POST /attempts/{id}/submit (OTP); POST /attempts/{id}/resend; POST /attempts/{id}/cancel; POST /attempts/{id}/client-event (widget hints, never trusted). Inbound: POST /inbound/{gateway}/{env}/{token}; GET or POST /return/{attemptToken}. 

- Admin: /gateways, /gateways/{id}/versions, /environments, /meta, /flows, /channels, /mappings, /statements, /test (dry-run, live-sandbox, scenarios, replay), /rails, /rails/{id}/fields, /routes, /routes/{id}/pause, resume or drain, /credential-sets, /attempts (filters), /attempts/{id}/inquire and resolve, /inbox, /reconciliation, /health. 

- Merchant: /merchant/credential-sets (create, replace, check; never read back), /merchant/routes (view status). 

- Stable error envelope { code, message, reference? } with codes including RAIL_UNAVAILABLE, LIMIT_EXCEEDED, OTP_INVALID, OTP_EXPIRED, OTP_LOCKED, ATTEMPT_EXPIRED, PAYMENT_PENDING_CONFIRMATION, GATEWAY_ERROR, VALIDATION_FAILED. 

- Metrics per route: initiate and confirm success rates, latency percentiles, OTP send failures, UNKNOWN count and age, webhook lag, polling load, breaker state, fee variance, settlement lag. 

- Alerts: any UNKNOWN older than its SLA, late success, conflicting signals, rejected callback from an unlisted IP, signature-failure spike, unmapped response codes, reconciliation mismatch, token refresh failures, credential check failures, Clearing balance drift against the gateway's reported amount, merchant receivable above ceiling, sandbox event seen on a live endpoint. 

- Dashboards: volume and success by gateway, rail and merchant; funnel from attempt to success per mode; operator queue for UNKNOWN, held and conflicting attempts. Runbooks linked from each alert: how to inquire, how to resolve with maker-checker, how to contact each gateway's support. 

## 16. Delivery plan 

1. Foundations: gateway, environment, versions, Credential Sets, auth layer and ApiConsumer registry, rails, routes, customer forms, flow engine core with transforms, attempt state machine, inbox, audit and maker-checker hooks. 

Page 42 of 44 

Dynamic Payment Gateway Management: Design v2 

2. OTP and redirect rails: two-step OTP flows, redirect and return handling, webhook verification, status mapping, scenario suite, sandbox lifecycle. First live candidates: one aggregator route and one direct OTP rail. 

3. Embedded, push, QR, pay code and deep link: widget definitions, hash transforms, client-event hints with mandatory inquiry (the Moamalat Lightbox is the reference case), push and QR flows with polling, POS realtime. 

4. Money safety and operations: Gateway Clearing accounts, fee accrual, statements and reconciliation, refunds and chargebacks, circuit breaker, canary rollout, dashboards and alerts. 

5. Merchant-owned credentials and direct settlement: merchant credential setup, commission receivable and netting, MANUAL rail with operator confirmation. 

6. Growth: native adapter framework, more gateway templates as partner documents arrive, live-limit fetch, multi-instance workers and cache invalidation. 

## 17. Decisions needed and open questions 

### For management 

1. Approve the Gateway Clearing Account and fee accrual changes to the ledger model (10.3) and their effect on the single-Treasury invariant. 

2. Decide whether merchant-owned, directly settled gateway accounts are in scope at launch, and how commission is collected from them (netting, invoice or card on file) (10.4). 

3. Decide the PCI scope position for OTP rails that take a card or transaction card number (hosted only, or in-memory pass-through with a scope review). 

4. Decide the preference between direct gateways and aggregators for launch (aggregators are faster but add a party in the settlement chain and a fee layer). 

5. Confirm the mismatch default (hold above tolerance) and the late-success policy (accept and alert, or always refund). 

6. Confirm which refund and chargeback capabilities are required at launch. 

7. Decide whether MANUAL rails (bank transfer, agent) are in launch scope. 

8. Confirm retention periods for personal data and raw gateway events with legal counsel and the central bank's requirements. 

### For each gateway partner (verification checklist) 

Official API documents and sandbox credentials; session and OTP lifetimes; status or inquiry endpoint; webhook signature scheme, source IPs and retry policy; amount unit, precision, rounding and per-customer limits; whether idempotency keys are accepted; 

Page 43 of 44 

Dynamic Payment Gateway Management: Design v2 

refund, void and capture support; statement format and settlement timing; whether merchants can hold their own accounts; reference length and charset; test card or wallet data; support contacts and maintenance windows. 

### Research gaps to close first 

Moamalat's official documents (findings come from community SDKs); DPay, T-LYNC and Plutu API specifications; any merchant API for Numo Pay, GPay, Hawelli (confirm the zaho.ly relationship), EVO Pay Libya and Libyana's general payments; the exact rounding behavior of DPay and other aggregators; whether the central bank's OnePay is available directly to merchants or only through banks and aggregators. 

## 18. Sources consulted 

- Moamalat integration packages: Node (moamalat), Laravel (alifaraun/laravel-moamalatpay), the Odoo Lightbox module, Flutter moamalat_payment. 

- DPay: the official PHP SDK and a community SDK, plus the DPay LY app listing. Plutu: PHP and Node SDKs. MyPay: the WooCommerce plugin. T-LYNC: the Laravel SDK and app listing. 

- Central Bank of Libya notices (Sadad launch, instant-payment and OnePay limits and statistics, e-commerce circular, National Switch transfer), bank and operator pages (Commercial and Development Bank for Edfali; Masarat for MobiCash and Yussor Pay; National Commercial Bank; Libyana; Almadar Sadad; ProgressSoft), and app-store listings (GPay, Hawelli, EVO wallet, Numo Pay, Sahara Pay, MobiCash, Tadawul). 

Page 44 of 44 

