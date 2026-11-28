//! The admin edge route table.
//!
//! Every route registered by `admin-back` is listed here with its public pattern, the core path
//! it forwards to, the mount-level authority guard, the zod schema of its body/params/query, the
//! body translator and the response status. Registration order mirrors the TS routers where it
//! matters; matching prefers an exact path, then the pattern with the most literal segments, so
//! `/merchants/summary` can never be captured by `/merchants/:id`.
//!
//! If a route is not in this table the edge answers `404 NOT_FOUND`; no request is ever silently
//! forwarded to a guessed core path.

#![forbid(unsafe_code)]

use crate::contract;
use crate::schema::Schema;
use crate::schemas;

/// Mount-level authority guard, mirroring `protected/index.ts`.
#[derive(Debug, Clone, Copy)]
pub enum Guard {
    /// No edge session or authority check (auth routes; core authenticates).
    None,
    /// `requireSession` only.
    Session,
    /// Read/write any-of lists; `read_paths` are read-only POSTs.
    Authorities {
        read: &'static [&'static str],
        write: &'static [&'static str],
        read_paths: &'static [&'static str],
    },
}

const fn rw(
    read: &'static [&'static str],
    write: &'static [&'static str],
    read_paths: &'static [&'static str],
) -> Guard {
    Guard::Authorities {
        read,
        write,
        read_paths,
    }
}

pub const G_USERS: Guard = rw(
    &["user:read", "security:read"],
    &["user:write", "security:write"],
    &[],
);
pub const G_KYB: Guard = rw(
    &["kyb:read", "compliance:read"],
    &["kyb:write", "compliance:write"],
    &[],
);
pub const G_GATEWAY: Guard = rw(&["gateway:read"], &["gateway:write", "gateway:test"], &[]);
pub const G_MERCHANT: Guard = rw(&["merchant:read"], &["merchant:write"], &[]);
pub const G_MERCHANT_KYB: Guard = rw(
    &["merchant:read", "kyb:read"],
    &["kyb:write", "merchant:write"],
    &[],
);
pub const G_MERCHANT_OPS: Guard = rw(&["merchant:read"], &["merchant:write"], &[]);
pub const G_TRANSACTIONS: Guard = rw(
    &["attempt:read", "merchant:read", "finance:read"],
    &["attempt:inquire"],
    &[],
);
pub const G_INBOUND: Guard = rw(&["attempt:read", "case:read"], &["attempt:inquire"], &[]);
pub const G_APPROVALS: Guard = rw(
    &["approval:read"],
    &["approval:check", "approval:write"],
    &[],
);
pub const G_AML: Guard = rw(
    &["COMPLIANCE", "MLRO", "aml:read", "aml:write"],
    &["COMPLIANCE", "MLRO", "aml:read", "aml:write"],
    &[],
);
pub const G_CREDENTIALS: Guard = rw(
    &[
        "credential:read",
        "credential:write",
        "gateway:read",
        "gateway:write",
    ],
    &["credential:write", "gateway:write"],
    &[],
);
pub const G_RECONCILIATION: Guard = rw(&["reconciliation:read"], &["reconciliation:write"], &[]);
pub const G_SETTINGS: Guard = rw(
    &["settings:read"],
    &["settings:write"],
    &["/settings/restore-preview"],
);
pub const G_AUDIT: Guard = rw(&["security:read"], &["security:read"], &[]);
pub const G_OBJECT_STORAGE: Guard = rw(
    &[
        "system:storage:read",
        "system:storage:admin",
        "system:storage:legal-hold",
    ],
    &["system:storage:admin", "system:storage:legal-hold"],
    &[],
);
pub const G_BACKUPS_READ: Guard = rw(&["security:read", "gateway:read"], &["security:write"], &[]);
/// Maintenance jobs additionally require `system:storage:admin` (the mount guard also allows
/// legal-hold operators; this route does not).
pub const G_OBJECT_STORAGE_ADMIN: Guard =
    rw(&["system:storage:admin"], &["system:storage:admin"], &[]);
pub const G_SYSTEM: Guard = rw(&["security:read"], &["security:write"], &[]);
pub const G_REPORT_ENGINE: Guard = rw(
    &[
        "report:review",
        "report:approve",
        "report_engine:author",
        "report_engine:run",
        "gateway:write",
        "security:read",
        "security:write",
        "reports.draft",
    ],
    &[
        "report:approve",
        "report_engine:author",
        "report:review",
        "security:write",
        "reports.draft",
    ],
    &["/report-engine/catalog/:code/execute"],
);
pub const G_CASES: Guard = rw(
    &["case:read", "operator:read"],
    &["case:write", "operator:write", "attempt:inquire"],
    &[],
);
pub const G_ATTEMPTS: Guard = rw(&["attempt:read"], &["attempt:inquire"], &[]);
pub const G_DISPUTES: Guard = rw(&["dispute:read"], &["dispute:write"], &[]);
pub const G_ADJUSTMENTS: Guard = rw(&["finance:read"], &["finance:write"], &[]);
pub const G_CASHOUTS: Guard = rw(&["cashout:read"], &["cashout:review", "finance:write"], &[]);
pub const G_COMMISSION: Guard = rw(
    &["commission:read", "finance:read"],
    &["commission:write"],
    &[],
);
pub const G_VELOCITY: Guard = rw(
    &["velocity:read", "compliance:read"],
    &["velocity:write", "compliance:write"],
    &[],
);
pub const G_FINANCE: Guard = rw(&["finance:read"], &["finance:write"], &[]);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Local {
    Logout,
    ApprovalBulkReject,
    UserBulkPatch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RawMode {
    Plain,
    KybContent,
    AssetContent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Forward,
    Raw(RawMode),
    Local(Local),
}

/// One registered route.
pub struct Route {
    pub method: &'static str,
    pub pattern: &'static str,
    pub core: String,
    pub guard: Guard,
    pub params: Option<Schema>,
    pub query: Option<Schema>,
    pub body: Option<Schema>,
    pub map: Option<fn(&serde_json::Value) -> crate::error::EdgeResult<serde_json::Value>>,
    pub status: u16,
    pub relay_status: bool,
    pub kind: Kind,
    pub capture_session: bool,
}

impl Route {
    fn new(method: &'static str, pattern: &'static str) -> Self {
        Self {
            method,
            pattern,
            core: core_path(pattern),
            guard: Guard::Session,
            params: None,
            query: None,
            body: None,
            map: None,
            status: 200,
            relay_status: false,
            kind: Kind::Forward,
            capture_session: false,
        }
    }

    fn core(mut self, core: &str) -> Self {
        self.core = core.to_owned();
        self
    }

    fn guard(mut self, guard: Guard) -> Self {
        self.guard = guard;
        self
    }

    fn params(mut self, params: Schema) -> Self {
        self.params = Some(params);
        self
    }

    fn query(mut self, query: Schema) -> Self {
        self.query = Some(query);
        self
    }

    fn body(mut self, body: Schema) -> Self {
        self.body = Some(body);
        self
    }

    fn map(
        mut self,
        map: fn(&serde_json::Value) -> crate::error::EdgeResult<serde_json::Value>,
    ) -> Self {
        self.map = Some(map);
        self
    }

    fn status(mut self, status: u16) -> Self {
        self.status = status;
        self
    }

    fn relay(mut self) -> Self {
        self.relay_status = true;
        self
    }

    fn kind(mut self, kind: Kind) -> Self {
        self.kind = kind;
        self
    }

    fn capture(mut self) -> Self {
        self.capture_session = true;
        self
    }
}

fn core_path(pattern: &str) -> String {
    let suffix = pattern.trim_start_matches('/');
    if suffix.is_empty() {
        "/internal/admin".to_owned()
    } else {
        format!("/internal/admin/{suffix}")
    }
}

fn get(pattern: &'static str, guard: Guard) -> Route {
    Route::new("GET", pattern).guard(guard)
}

fn post(pattern: &'static str, guard: Guard) -> Route {
    Route::new("POST", pattern).guard(guard)
}

fn patch(pattern: &'static str, guard: Guard) -> Route {
    Route::new("PATCH", pattern).guard(guard)
}

fn put(pattern: &'static str, guard: Guard) -> Route {
    Route::new("PUT", pattern).guard(guard)
}

fn delete(pattern: &'static str, guard: Guard) -> Route {
    Route::new("DELETE", pattern).guard(guard)
}

/// Every route, in registration order.
#[must_use]
pub fn table() -> Vec<Route> {
    let mut routes = Vec::with_capacity(420);
    auth_routes(&mut routes);
    protected_routes(&mut routes);
    routes
}

/// `admin-back/api/public/auth.ts`.
fn auth_routes(routes: &mut Vec<Route>) {
    routes.push(post("/auth/logout", Guard::None).kind(Kind::Local(Local::Logout)));
    routes.push(
        post("/auth/login", Guard::None)
            .body(schemas::login())
            .core("/internal/admin/auth/login")
            .capture(),
    );
    routes.push(
        post("/auth/mfa", Guard::None)
            .body(schemas::mfa())
            .core("/internal/admin/auth/mfa")
            .capture(),
    );
    routes.push(
        post("/auth/accept-invitation", Guard::None)
            .body(schemas::accept_invitation())
            .core("/internal/admin/auth/accept-invitation"),
    );
    routes.push(
        post("/auth/mfa/resend", Guard::None)
            .body(schemas::mfa_resend())
            .core("/internal/admin/auth/mfa/resend"),
    );
    routes.push(
        post("/auth/password/forgot", Guard::None)
            .body(schemas::password_forgot())
            .core("/internal/admin/auth/password/forgot")
            .status(202),
    );
    routes.push(
        post("/auth/password/reset", Guard::None)
            .body(schemas::password_reset())
            .core("/internal/admin/auth/password/reset"),
    );
    routes.push(get("/auth/me", Guard::None).core("/internal/admin/auth/me"));
}

fn protected_routes(routes: &mut Vec<Route>) {
    search_and_academy(routes);
    users(routes);
    join_requests(routes);
    merchants(routes);
    merchant_operations(routes);
    transactions_and_approvals(routes);
    aml(routes);
    gateways(routes);
    rails(routes);
    reconciliation(routes);
    settings(routes);
    options_and_stats(routes);
    credentials(routes);
    audit(routes);
    kyb(routes);
    object_storage(routes);
    backups(routes);
    system(routes);
    report_engine(routes);
    operations(routes);
    finance(routes);
}

fn search_and_academy(routes: &mut Vec<Route>) {
    routes.push(
        post("/search", Guard::Session)
            .body(search_schema())
            .core("/internal/admin/search"),
    );
    routes.push(get("/academy/progress", Guard::Session));
    routes.push(put("/academy/progress", Guard::Session).body(schemas::academy_progress()));
    routes.push(
        get("/academy/exams/:examId/eligibility", Guard::Session)
            .params(schemas::academy_exam_params()),
    );
    routes.push(
        post("/academy/exams/:examId/start", Guard::Session)
            .params(schemas::academy_exam_params())
            .body(schemas::academy_start()),
    );
    routes.push(
        post("/academy/exams/:examId/submit", Guard::Session)
            .params(schemas::academy_exam_params())
            .body(schemas::academy_submit()),
    );
    routes.push(
        get(
            "/academy/certificates/:trackId/verification",
            Guard::Session,
        )
        .params(schemas::academy_track_params()),
    );
    routes.push(get("/academy/team", Guard::Session));
    routes.push(
        post("/academy/certificates/:identifier/revoke", Guard::Session)
            .params(schemas::academy_certificate_params())
            .body(schemas::academy_revoke()),
    );
    routes.push(get("/academy/team/export", Guard::Session).query(schemas::summary_export_query()));
}

fn search_schema() -> Schema {
    crate::schema::object()
        .req("query", crate::schema::trimmed(2, 120))
        .opt(
            "types",
            crate::schema::array_sized(crate::schema::text(1, 64), 0, 30),
        )
        .def("limit", crate::schema::integer(1, 10), serde_json::json!(5))
        .strict()
        .build()
}

fn users(routes: &mut Vec<Route>) {
    routes.push(get("/users", G_USERS).query(schemas::list_query()));
    routes.push(get("/users/export", G_USERS).query(schemas::list_query()));
    routes.push(get("/users/summary", G_USERS));
    routes.push(
        post("/users", G_USERS)
            .body(schemas::user_create())
            .map(contract::to_core_user_create)
            .status(201),
    );
    routes.push(
        post("/users/:id/invite", G_USERS)
            .params(schemas::user_id_params())
            .body(schemas::user_invite()),
    );
    routes.push(
        patch("/users", G_USERS)
            .body(schemas::user_bulk_patch())
            .kind(Kind::Local(Local::UserBulkPatch)),
    );
    routes.push(
        patch("/users/:id", G_USERS)
            .params(schemas::user_id_params())
            .body(schemas::user_patch())
            .map(contract::to_core_user_update)
            .relay(),
    );
    routes.push(get("/users/summary/export", G_USERS).query(schemas::summary_export_query()));
    routes.push(get("/users/:id", G_USERS).params(schemas::user_id_params()));
}

fn join_requests(routes: &mut Vec<Route>) {
    routes.push(get("/join-requests", G_KYB).query(schemas::list_query()));
    routes.push(get("/join-requests/export", G_KYB).query(schemas::list_query()));
    routes.push(get("/join-requests/summary", G_KYB));
    routes.push(get("/join-requests/summary/export", G_KYB).query(schemas::summary_export_query()));
    routes.push(get("/join-requests/:id", G_KYB).params(schemas::join_request_id_params()));
    routes.push(
        post("/join-requests/admin-assisted", G_KYB)
            .body(schemas::admin_assisted())
            .relay(),
    );
    routes.push(
        patch("/join-requests/:id/profile", G_KYB)
            .params(schemas::join_request_id_params())
            .body(schemas::admin_assisted()),
    );
    routes.push(
        post("/join-requests/:id/beneficial-owners", G_KYB)
            .params(schemas::join_request_id_params())
            .body(schemas::admin_assisted())
            .relay(),
    );
    routes.push(
        patch("/join-requests/:id/beneficial-owners/:ownerId", G_KYB)
            .params(schemas::join_request_owner_params())
            .body(schemas::admin_assisted()),
    );
    routes.push(
        delete("/join-requests/:id/beneficial-owners/:ownerId", G_KYB)
            .params(schemas::join_request_owner_params()),
    );
    // POST /join-requests/:id/kyb-documents is the multipart upload handled by `upload.rs`.
    routes.push(
        delete("/join-requests/:id/kyb-documents/:docId", G_KYB)
            .params(schemas::join_request_document_params()),
    );
    routes.push(
        post("/join-requests/:id/submit", G_KYB)
            .params(schemas::join_request_id_params())
            .body(schemas::admin_assisted()),
    );
    routes.push(
        post("/join-requests/:id/withdraw", G_KYB)
            .params(schemas::join_request_id_params())
            .body(schemas::admin_assisted()),
    );
    routes.push(
        patch("/join-requests/:id/checklist", G_KYB)
            .params(schemas::join_request_id_params())
            .body(schemas::join_request_checklist()),
    );
    routes.push(
        post("/join-requests/:id/screening/retry", G_KYB)
            .params(schemas::join_request_id_params())
            .body(schemas::admin_assisted()),
    );
    routes.push(
        post("/join-requests/:id/assign", G_KYB)
            .params(schemas::join_request_id_params())
            .body(schemas::join_request_assign())
            .map(contract::to_core_join_request_assign),
    );
    routes.push(
        post("/join-requests/:id/request-info", G_KYB)
            .params(schemas::join_request_id_params())
            .body(schemas::join_request_request_info())
            .map(contract::to_core_join_request_request_info),
    );
    routes.push(
        post("/join-requests/:id/decide", G_KYB)
            .params(schemas::join_request_id_params())
            .body(schemas::join_request_decide())
            .map(contract::to_core_join_request_decide)
            .relay(),
    );
}

fn merchants(routes: &mut Vec<Route>) {
    routes.push(get("/merchants", G_MERCHANT).query(schemas::list_query()));
    routes.push(get("/merchants/export", G_MERCHANT).query(schemas::list_query()));
    routes.push(get("/merchants/summary", G_MERCHANT));
    routes
        .push(get("/merchants/summary/export", G_MERCHANT).query(schemas::summary_export_query()));
    routes.push(
        get("/merchants/:id/summary/export", G_MERCHANT)
            .params(schemas::merchant_id_params())
            .query(schemas::summary_export_query()),
    );
    routes.push(get("/merchants/:id", G_MERCHANT).params(schemas::merchant_id_params()));
    for pattern in [
        "/merchants/:id/transactions",
        "/merchants/:id/applications",
        "/merchants/:id/wallets",
        "/merchants/:id/cashouts",
        "/merchants/:id/disputes",
        "/merchants/:id/adjustments",
        "/merchants/:id/notifications",
        "/merchants/:id/audit-events",
    ] {
        routes.push(
            get(pattern, G_MERCHANT)
                .params(schemas::merchant_id_params())
                .query(schemas::list_query()),
        );
    }
    routes.push(
        get("/merchants/:id/stats", G_MERCHANT)
            .params(schemas::merchant_id_params())
            .query(schemas::list_query()),
    );
    routes.push(
        patch("/merchants/:id/descriptive", G_MERCHANT)
            .params(schemas::merchant_id_params())
            .body(schemas::merchant_descriptive())
            .map(contract::to_core_merchant_descriptive),
    );
    routes.push(
        post("/merchants/:id/suspend", G_MERCHANT)
            .params(schemas::merchant_id_params())
            .body(schemas::merchant_suspend())
            .map(contract::to_core_merchant_suspend)
            .relay(),
    );
    routes.push(
        post("/merchants/:id/reinstate", G_MERCHANT)
            .params(schemas::merchant_id_params())
            .body(schemas::merchant_reinstate())
            .map(contract::to_core_merchant_reinstate)
            .relay(),
    );
    routes.push(
        post("/merchants/:id/close", G_MERCHANT)
            .params(schemas::merchant_id_params())
            .body(schemas::merchant_close())
            .map(contract::to_core_merchant_close)
            .relay(),
    );
    routes.push(
        get("/merchants/:id/pending-changes", G_MERCHANT).params(schemas::merchant_id_params()),
    );
    routes.push(
        post(
            "/merchants/:id/pending-changes/:approvalId/withdraw",
            G_MERCHANT,
        )
        .params(schemas::merchant_bulk_params())
        .body(schemas::merchant_withdraw())
        .map(contract::to_core_merchant_withdraw),
    );
    routes.push(
        post("/merchants/:id/propose-edit", G_MERCHANT)
            .params(schemas::merchant_id_params())
            .body(schemas::merchant_propose_edit())
            .map(contract::to_core_merchant_propose_edit)
            .relay(),
    );
    routes.push(
        get("/merchants/:id/detail-changes", G_MERCHANT).params(schemas::merchant_id_params()),
    );
    routes.push(
        get("/merchants/:id/beneficial-owners", G_MERCHANT_KYB).params(schemas::uuid_params()),
    );
    routes.push(
        post("/merchants/:id/beneficial-owners", G_MERCHANT_KYB)
            .params(schemas::uuid_params())
            .body(schemas::beneficial_owner_create())
            .relay(),
    );
    routes.push(
        patch("/merchants/:id/beneficial-owners/:ownerId", G_MERCHANT_KYB)
            .params(schemas::owner_params())
            .body(schemas::beneficial_owner_patch())
            .relay(),
    );
    routes.push(
        delete("/merchants/:id/beneficial-owners/:ownerId", G_MERCHANT_KYB)
            .params(schemas::owner_params())
            .relay(),
    );
    routes.push(
        post("/merchants/:id/revalidations", G_MERCHANT_KYB)
            .params(schemas::uuid_params())
            .body(schemas::merchant_revalidation())
            .relay(),
    );
}

fn merchant_operations(routes: &mut Vec<Route>) {
    // wallets
    routes.push(get("/wallets", G_MERCHANT_OPS).query(schemas::list_query()));
    routes.push(get("/wallets/summary", G_MERCHANT_OPS).query(schemas::list_query()));
    routes.push(get("/wallets/:id", G_MERCHANT_OPS).params(schemas::uuid_params()));
    routes.push(
        get("/wallets/:id/statement", G_MERCHANT_OPS)
            .params(schemas::uuid_params())
            .query(schemas::list_query()),
    );
    routes.push(
        get("/wallets/:id/audit-events", G_MERCHANT_OPS)
            .params(schemas::uuid_params())
            .query(schemas::list_query()),
    );
    routes.push(
        post("/wallets/:id/status", G_MERCHANT_OPS)
            .params(schemas::uuid_params())
            .body(wallet_status())
            .relay(),
    );
    // applications
    routes.push(get("/applications", G_MERCHANT_OPS).query(schemas::list_query()));
    routes.push(get("/applications/summary", G_MERCHANT_OPS).query(schemas::list_query()));
    routes.push(get("/applications/:id", G_MERCHANT_OPS).params(schemas::uuid_params()));
    routes.push(
        patch("/applications/:id", G_MERCHANT_OPS)
            .params(schemas::uuid_params())
            .body(schemas::application_patch())
            .relay(),
    );
    routes.push(
        post("/applications/:id/tokens/:tokenId/revoke", G_MERCHANT_OPS)
            .params(schemas::application_token_params())
            .body(schemas::application_token_revoke())
            .relay(),
    );
    routes.push(get("/access-tokens", G_MERCHANT_OPS).query(schemas::list_query()));
    routes.push(get("/access-tokens/summary", G_MERCHANT_OPS).query(schemas::list_query()));
    routes.push(get("/payment-links", G_MERCHANT_OPS).query(schemas::list_query()));
    routes.push(
        post("/payment-links/:id/state", G_MERCHANT_OPS)
            .params(schemas::uuid_params())
            .body(schemas::payment_link_state())
            .relay(),
    );
    routes.push(get("/pos-terminals", G_MERCHANT_OPS).query(schemas::list_query()));
    routes.push(
        post("/pos-terminals/:id/status", G_MERCHANT_OPS)
            .params(schemas::uuid_params())
            .body(schemas::pos_terminal_status())
            .relay(),
    );
}

fn wallet_status() -> Schema {
    crate::schema::object()
        .req("status", crate::schema::enumeration(&["FROZEN", "ACTIVE"]))
        .req("reason", crate::schema::trimmed(10, 500))
        .opt("checklist", schemas::checklist_any(10))
        .strict()
        .build()
}

fn transactions_and_approvals(routes: &mut Vec<Route>) {
    routes.push(get("/transactions", G_TRANSACTIONS).query(schemas::list_query()));
    routes.push(get("/transactions/summary", G_TRANSACTIONS).query(schemas::list_query()));
    routes.push(
        get("/transactions/summary/export", G_TRANSACTIONS).query(schemas::summary_export_query()),
    );
    routes.push(get("/inbound-events", G_INBOUND).query(schemas::list_query()));
    routes.push(
        get("/inbound-events/:id", G_INBOUND).params(
            crate::schema::object()
                .req("id", crate::schema::uuid())
                .strict()
                .build(),
        ),
    );
    routes.push(get("/approvals", G_APPROVALS).query(schemas::list_query()));
    routes.push(get("/approvals/export", G_APPROVALS).query(schemas::list_query()));
    routes.push(get("/approvals/summary", G_APPROVALS));
    routes.push(
        post("/approvals/bulk-reject", G_APPROVALS)
            .body(schemas::approval_bulk_reject())
            .kind(Kind::Local(Local::ApprovalBulkReject)),
    );
    routes
        .push(get("/approvals/summary/export", G_APPROVALS).query(schemas::summary_export_query()));
    routes.push(get("/approvals/:id", G_APPROVALS).params(schemas::approval_id_params()));
    routes.push(
        post("/approvals/:id/approve", G_APPROVALS)
            .params(schemas::approval_id_params())
            .body(schemas::approval_decision())
            .map(contract::to_core_approval_approve)
            .relay(),
    );
    routes.push(
        post("/approvals/:id/reject", G_APPROVALS)
            .params(schemas::approval_id_params())
            .body(schemas::approval_decision())
            .map(contract::to_core_approval_reject),
    );
    routes.push(
        post("/approvals/:id/extend-emergency", G_APPROVALS)
            .params(schemas::approval_id_params())
            .body(schemas::approval_extend_emergency()),
    );
}

fn aml(routes: &mut Vec<Route>) {
    // Every route below is under `router.use(amlConfidential)` and has no extra authority guard.
    routes.push(get("/aml/screenings", G_AML).query(schemas::list_query()));
    routes.push(get("/aml/screenings/export", G_AML).query(schemas::list_query()));
    routes.push(get("/aml/screenings/summary", G_AML).query(schemas::list_query()));
    routes
        .push(get("/aml/screenings/summary/export", G_AML).query(schemas::summary_export_query()));
    routes.push(get("/aml/screenings/:id", G_AML).params(schemas::aml_id_params()));
    routes.push(
        post("/aml/matches/:id/disposition", G_AML)
            .params(schemas::aml_id_params())
            .body(schemas::aml_disposition())
            .map(contract::to_core_aml_match_disposition),
    );
    routes.push(get("/aml/cases", G_AML).query(schemas::list_query()));
    routes.push(get("/aml/cases/export", G_AML).query(schemas::list_query()));
    routes.push(get("/aml/cases/summary", G_AML).query(schemas::list_query()));
    routes.push(get("/aml/cases/summary/export", G_AML).query(schemas::summary_export_query()));
    routes.push(get("/aml/cases/:id/evidence", G_AML).params(schemas::aml_id_params()));
    // POST /aml/cases/:id/evidence is the multipart upload handled by `upload.rs`.
    routes.push(
        get("/aml/cases/:id/evidence/:evidenceId/content", G_AML)
            .params(schemas::evidence_params())
            .kind(Kind::Raw(RawMode::Plain)),
    );
    routes.push(get("/aml/cases/:id", G_AML).params(schemas::aml_id_params()));
    routes.push(
        post("/aml/cases/:id/propose", G_AML)
            .params(schemas::aml_id_params())
            .body(schemas::aml_case_propose())
            .map(contract::to_core_aml_case_propose)
            .relay(),
    );
    routes.push(get("/aml/rules", G_AML).query(schemas::list_query()));
    routes.push(get("/aml/rules/export", G_AML).query(schemas::list_query()));
    routes.push(get("/aml/rules/summary", G_AML).query(schemas::list_query()));
    routes.push(get("/aml/rules/summary/export", G_AML).query(schemas::summary_export_query()));
    routes.push(get("/aml/rules/:id", G_AML).params(schemas::aml_id_params()));
    routes.push(
        post("/aml/rules", G_AML)
            .body(schemas::aml_rule())
            .map(contract::to_core_aml_rule)
            .relay(),
    );
    routes.push(get("/aml/reporting-rules", G_AML));
    routes.push(
        post("/aml/reporting-rules", G_AML)
            .body(schemas::aml_reporting_rule())
            .map(contract::to_core_aml_reporting_rule)
            .status(201),
    );
    routes.push(
        post("/aml/reporting-rules/:id/promote", G_AML)
            .params(schemas::aml_id_params())
            .body(
                crate::schema::object()
                    .opt("checklist", schemas::checklist_any(10))
                    .strict()
                    .build(),
            )
            .relay(),
    );
    routes.push(get("/aml/reports", G_AML).query(schemas::list_query()));
    routes.push(get("/aml/reports/export", G_AML).query(schemas::list_query()));
    routes.push(get("/aml/reports/summary", G_AML).query(schemas::list_query()));
    routes.push(get("/aml/reports/summary/export", G_AML).query(schemas::summary_export_query()));
    routes.push(
        post("/aml/reports/:id/submit", G_AML)
            .params(schemas::aml_id_params())
            .body(schemas::aml_report_submit()),
    );
    routes.push(
        post("/aml/reports/:id/acknowledge", G_AML)
            .params(schemas::aml_id_params())
            .body(schemas::aml_report_acknowledge()),
    );
    routes.push(get("/aml/reports/:id", G_AML).params(schemas::aml_id_params()));
    routes.push(
        post("/aml/reports", G_AML)
            .body(schemas::aml_report())
            .map(contract::to_core_aml_report)
            .status(201),
    );
    routes.push(get("/aml/report-context-catalog", G_AML));
    routes.push(get("/aml/report-schemas", G_AML));
    routes.push(get("/aml/report-schemas/:id", G_AML).params(schemas::aml_id_params()));
    routes.push(
        post("/aml/report-schemas", G_AML)
            .body(schemas::aml_report_schema_upload())
            .relay(),
    );
    routes.push(
        post("/aml/report-schemas/:id/compile", G_AML)
            .params(schemas::aml_id_params())
            .body(schemas::aml_empty_body()),
    );
    routes.push(
        post("/aml/report-schemas/:id/simulate", G_AML)
            .params(schemas::aml_id_params())
            .body(schemas::aml_report_simulate()),
    );
    routes.push(
        post("/aml/report-schemas/:id/promote", G_AML)
            .params(schemas::aml_id_params())
            .body(schemas::aml_report_schema_promote())
            .relay(),
    );
    routes.push(
        put("/aml/report-schemas/:id", G_AML)
            .params(schemas::aml_id_params())
            .body(schemas::aml_schema_draft()),
    );
    routes.push(
        post("/aml/report-schemas/:id/clone", G_AML)
            .params(schemas::aml_id_params())
            .body(schemas::aml_schema_clone())
            .relay(),
    );
    routes.push(post("/aml/report-schemas/validate", G_AML).body(schemas::aml_schema_validate()));
    routes.push(
        post("/aml/report-schemas/:id/validate", G_AML)
            .params(schemas::aml_id_params())
            .body(schemas::aml_schema_validate()),
    );
    routes.push(
        post("/aml/report-schemas/:id/sample-context", G_AML)
            .params(schemas::aml_id_params())
            .body(schemas::aml_sample_context()),
    );
    routes.push(
        post("/aml/report-schemas/:id/code-lists/preview", G_AML)
            .params(schemas::aml_id_params())
            .body(schemas::aml_code_list_preview()),
    );
    routes.push(
        post("/aml/report-schemas/:id/template/analyze", G_AML)
            .params(schemas::aml_id_params())
            .body(schemas::aml_template_analyze()),
    );
    routes.push(
        post("/aml/report-schemas/:id/template/upload", G_AML)
            .params(schemas::aml_id_params())
            .body(schemas::aml_template_upload())
            .relay(),
    );
    routes.push(delete("/aml/report-schemas/:id/template", G_AML).params(schemas::aml_id_params()));
    routes.push(get("/aml/report-schemas/:id/template", G_AML).params(schemas::aml_id_params()));
    routes.push(
        put("/aml/report-schemas/:id/template", G_AML)
            .params(schemas::aml_id_params())
            .body(schemas::aml_template_upload()),
    );
    routes.push(
        post("/aml/report-schemas/:id/workbook/preview", G_AML)
            .params(schemas::aml_id_params())
            .body(schemas::aml_report_simulate()),
    );
    routes.push(
        get("/aml/reporting-rules/:id/schema-bindings", G_AML).params(schemas::aml_id_params()),
    );
    routes.push(
        put("/aml/reporting-rules/:id/schema-bindings", G_AML)
            .params(schemas::aml_id_params())
            .body(schemas::aml_rule_bindings())
            .relay(),
    );
    routes.push(get("/aml/reports/:id/requirements", G_AML).params(schemas::aml_id_params()));
    routes.push(get("/aml/report-schema-defaults", G_AML));
    routes.push(
        put("/aml/report-schema-defaults", G_AML)
            .body(schemas::aml_report_schema_default())
            .relay(),
    );
    routes.push(get("/aml/reports/:id/payload", G_AML).params(schemas::aml_id_params()));
    routes.push(
        patch("/aml/reports/:id/payload", G_AML)
            .params(schemas::aml_id_params())
            .body(schemas::aml_report_narrative()),
    );
    routes.push(
        post("/aml/reports/:id/generate-output", G_AML)
            .params(schemas::aml_id_params())
            .body(schemas::aml_report_generate()),
    );
    routes.push(
        post("/aml/reports/:id/request-approval", G_AML)
            .params(schemas::aml_id_params())
            .body(schemas::aml_empty_body())
            .relay(),
    );
    routes.push(
        get("/aml/reports/:id/outputs/:format/download", G_AML)
            .params(schemas::aml_report_output_params())
            .kind(Kind::Raw(RawMode::Plain)),
    );

    // Incidents and filing adapters (registered after the report routes in TS).
    routes.push(
        get("/aml/incidents/summary/export", G_AML)
            .core("/internal/admin/incidents/summary/export")
            .query(schemas::summary_export_query()),
    );
    routes.push(
        get("/aml/incidents/export", G_AML)
            .core("/internal/admin/incidents/export")
            .query(schemas::incident_export_query()),
    );
    routes.push(
        get("/aml/incidents", G_AML)
            .core("/internal/admin/incidents")
            .query(schemas::incident_list_query()),
    );
    routes.push(
        post("/aml/incidents", G_AML)
            .core("/internal/admin/incidents")
            .body(schemas::incident_create())
            .relay(),
    );
    routes.push(
        get("/aml/incidents/:id", G_AML)
            .core("/internal/admin/incidents/:id")
            .params(schemas::aml_id_params()),
    );
    routes.push(
        patch("/aml/incidents/:id", G_AML)
            .core("/internal/admin/incidents/:id")
            .params(schemas::aml_id_params())
            .body(schemas::incident_patch())
            .relay(),
    );
    routes.push(
        post("/aml/incidents/:id/transition", G_AML)
            .core("/internal/admin/incidents/:id/transition")
            .params(schemas::aml_id_params())
            .body(schemas::incident_transition())
            .relay(),
    );
    routes.push(
        post("/aml/incidents/:id/timeline", G_AML)
            .core("/internal/admin/incidents/:id/timeline")
            .params(schemas::aml_id_params())
            .body(schemas::incident_timeline())
            .relay(),
    );
    routes.push(
        post("/aml/incidents/:id/responders", G_AML)
            .core("/internal/admin/incidents/:id/responders")
            .params(schemas::aml_id_params())
            .body(schemas::incident_responder())
            .relay(),
    );
    routes.push(
        patch("/aml/incidents/:id/responders/:childId", G_AML)
            .core("/internal/admin/incidents/:id/responders/:childId")
            .params(schemas::incident_child_params())
            .body(schemas::incident_responder_patch())
            .relay(),
    );
    routes.push(
        post("/aml/incidents/:id/actions", G_AML)
            .core("/internal/admin/incidents/:id/actions")
            .params(schemas::aml_id_params())
            .body(schemas::incident_action())
            .relay(),
    );
    routes.push(
        patch("/aml/incidents/:id/actions/:childId", G_AML)
            .core("/internal/admin/incidents/:id/actions/:childId")
            .params(schemas::incident_child_params())
            .body(schemas::incident_action_patch())
            .relay(),
    );
    routes.push(
        post("/aml/incidents/:id/links", G_AML)
            .core("/internal/admin/incidents/:id/links")
            .params(schemas::aml_id_params())
            .body(schemas::incident_link())
            .relay(),
    );
    routes.push(
        delete("/aml/incidents/:id/links/:childId", G_AML)
            .core("/internal/admin/incidents/:id/links/:childId")
            .params(schemas::incident_child_params())
            .relay(),
    );
    routes.push(
        post("/aml/incidents/:id/communications", G_AML)
            .core("/internal/admin/incidents/:id/communications")
            .params(schemas::aml_id_params())
            .body(schemas::incident_communication())
            .relay(),
    );
    routes.push(
        post("/aml/incidents/:id/report", G_AML)
            .core("/internal/admin/incidents/:id/report")
            .params(schemas::aml_id_params())
            .body(schemas::aml_empty_body())
            .relay(),
    );
    routes.push(get("/aml/filing-adapters", G_AML));
    routes.push(
        post("/aml/filing-adapters", G_AML)
            .body(schemas::aml_filing_adapter())
            .relay(),
    );
    routes.push(
        patch("/aml/filing-adapters/:id", G_AML)
            .params(schemas::aml_id_params())
            .body(schemas::aml_filing_adapter_patch())
            .relay(),
    );
    routes.push(
        delete("/aml/filing-adapters/:id", G_AML)
            .params(schemas::aml_id_params())
            .relay(),
    );
    routes.push(get("/aml/reports/:id/submissions", G_AML).params(schemas::aml_id_params()));
    routes.push(
        post("/aml/reports/:id/file", G_AML)
            .params(schemas::aml_id_params())
            .body(schemas::aml_report_file())
            .relay(),
    );
}

fn gateways(routes: &mut Vec<Route>) {
    routes.push(get("/gateways/ai-transcript", G_GATEWAY).query(schemas::gateway_ai_transcript()));
    routes.push(post("/gateways/spec-verify", G_GATEWAY).body(schemas::gateway_spec_verify()));
    routes.push(
        post("/gateways/spec-import", G_GATEWAY)
            .body(schemas::gateway_spec_import())
            .status(201),
    );
    routes.push(get("/gateways/export", G_GATEWAY).query(schemas::gateway_export_query()));
    routes.push(get("/gateways", G_GATEWAY).query(schemas::list_query()));
    routes.push(
        post("/gateways", G_GATEWAY)
            .body(schemas::gateway_create())
            .map(contract::to_core_gateway_create)
            .status(201),
    );
    routes.push(get("/gateways/summary", G_GATEWAY).query(schemas::list_query()));
    routes.push(get("/gateways/summary/export", G_GATEWAY).query(schemas::summary_export_query()));
    routes.push(
        patch("/gateways/:id", G_GATEWAY)
            .params(schemas::gateway_id_params())
            .body(schemas::gateway_patch())
            .map(contract::to_core_gateway_update),
    );
    routes.push(get("/gateways/:id", G_GATEWAY).params(schemas::gateway_id_params()));
    routes.push(
        post("/gateways/:id/rollback", G_GATEWAY)
            .params(schemas::gateway_id_params())
            .body(schemas::gateway_rollback())
            .map(contract::to_core_gateway_rollback),
    );
    routes.push(get("/gateways/:id/health", G_GATEWAY).params(schemas::gateway_id_params()));
    routes.push(get("/gateways/:id/versions", G_GATEWAY).params(schemas::gateway_id_params()));
    routes.push(
        post("/gateways/:id/versions", G_GATEWAY)
            .params(schemas::gateway_id_params())
            .body(schemas::version_create())
            .map(contract::to_core_gateway_version_create)
            .status(201),
    );
    let versions = [
        (
            "/gateway-versions/:vid/clone",
            "POST",
            Some(schemas::version_clone()),
            None,
            201u16,
            false,
        ),
        ("/gateway-versions/:vid", "GET", None, None, 200, false),
        (
            "/gateway-versions/:vid/environments",
            "PUT",
            Some(schemas::gateway_environments()),
            Some(
                contract::to_core_gateway_version_environments
                    as fn(&serde_json::Value) -> crate::error::EdgeResult<serde_json::Value>,
            ),
            200,
            false,
        ),
        (
            "/gateway-versions/:vid/auth",
            "PUT",
            Some(schemas::gateway_auth()),
            Some(
                contract::to_core_gateway_version_auth
                    as fn(&serde_json::Value) -> crate::error::EdgeResult<serde_json::Value>,
            ),
            200,
            false,
        ),
        (
            "/gateway-versions/:vid/settings",
            "PUT",
            Some(schemas::gateway_settings()),
            Some(
                contract::to_core_gateway_version_settings
                    as fn(&serde_json::Value) -> crate::error::EdgeResult<serde_json::Value>,
            ),
            200,
            false,
        ),
        (
            "/gateway-versions/:vid/crypto-profiles",
            "PUT",
            Some(schemas::gateway_crypto_profiles()),
            Some(
                contract::to_core_gateway_version_crypto_profiles
                    as fn(&serde_json::Value) -> crate::error::EdgeResult<serde_json::Value>,
            ),
            200,
            false,
        ),
        (
            "/gateway-versions/:vid/flows",
            "PUT",
            Some(schemas::gateway_flows()),
            Some(
                contract::to_core_gateway_version_flows
                    as fn(&serde_json::Value) -> crate::error::EdgeResult<serde_json::Value>,
            ),
            200,
            false,
        ),
        (
            "/gateway-versions/:vid/channels",
            "PUT",
            Some(schemas::gateway_channels()),
            Some(
                contract::to_core_gateway_version_channels
                    as fn(&serde_json::Value) -> crate::error::EdgeResult<serde_json::Value>,
            ),
            200,
            false,
        ),
        (
            "/gateway-versions/:vid/status-rules",
            "PUT",
            Some(schemas::gateway_status_rules()),
            Some(
                contract::to_core_gateway_version_status_rules
                    as fn(&serde_json::Value) -> crate::error::EdgeResult<serde_json::Value>,
            ),
            200,
            false,
        ),
        (
            "/gateway-versions/:vid/error-maps",
            "PUT",
            Some(schemas::gateway_error_maps()),
            Some(
                contract::to_core_gateway_version_error_maps
                    as fn(&serde_json::Value) -> crate::error::EdgeResult<serde_json::Value>,
            ),
            200,
            false,
        ),
        (
            "/gateway-versions/:vid/dry-run",
            "POST",
            Some(schemas::gateway_dry_run()),
            Some(
                contract::to_core_gateway_version_dry_run
                    as fn(&serde_json::Value) -> crate::error::EdgeResult<serde_json::Value>,
            ),
            200,
            false,
        ),
        (
            "/gateway-versions/:vid/run-suite",
            "POST",
            Some(schemas::gateway_run_suite()),
            Some(
                contract::to_core_gateway_version_run_suite
                    as fn(&serde_json::Value) -> crate::error::EdgeResult<serde_json::Value>,
            ),
            200,
            false,
        ),
        (
            "/gateway-versions/:vid/submit-approval",
            "POST",
            Some(schemas::gateway_submit_approval()),
            None,
            200,
            true,
        ),
    ];
    for (pattern, method, body, map, status, relay) in versions {
        let pattern: &'static str = pattern;
        let mut route = Route::new(method, pattern)
            .guard(G_GATEWAY)
            .params(schemas::version_id_params())
            .status(status);
        if let Some(body) = body {
            route = route.body(body);
        }
        if let Some(map) = map {
            route = route.map(map);
        }
        if relay {
            route = route.relay();
        }
        routes.push(route);
    }
}

fn rails(routes: &mut Vec<Route>) {
    routes.push(get("/rails", G_GATEWAY).query(schemas::list_query()));
    routes.push(
        post("/rails", G_GATEWAY)
            .body(schemas::rail_create())
            .map(contract::to_core_rail_create)
            .status(201),
    );
    routes.push(get("/rails/export", G_GATEWAY).query(schemas::gateway_export_query()));
    routes.push(get("/rails/summary", G_GATEWAY).query(schemas::list_query()));
    routes.push(get("/rails/summary/export", G_GATEWAY).query(schemas::summary_export_query()));
    routes.push(
        patch("/rails/:id", G_GATEWAY)
            .params(schemas::rail_id_params())
            .body(schemas::rail_patch())
            .map(contract::to_core_rail_update),
    );
    routes.push(get("/rails/:id", G_GATEWAY).params(schemas::rail_id_params()));
    routes.push(
        put("/rails/:id/fields", G_GATEWAY)
            .params(schemas::rail_id_params())
            .body(schemas::rail_fields())
            .map(contract::to_core_rail_fields),
    );
    routes.push(get("/routes", G_GATEWAY).query(schemas::list_query()));
    routes.push(
        post("/routes", G_GATEWAY)
            .body(schemas::route_create())
            .map(contract::to_core_route_create)
            .status(201),
    );
    routes.push(
        patch("/routes/:id", G_GATEWAY)
            .params(schemas::rail_id_params())
            .body(schemas::route_patch())
            .map(contract::to_core_route_update),
    );
    routes.push(get("/routes/export", G_GATEWAY).query(schemas::gateway_export_query()));
    routes.push(get("/routes/summary", G_GATEWAY).query(schemas::list_query()));
    routes.push(get("/routes/summary/export", G_GATEWAY).query(schemas::summary_export_query()));
    routes.push(get("/routes/:id", G_GATEWAY).params(schemas::rail_id_params()));
    routes.push(
        post("/routes/:id/state", G_GATEWAY)
            .params(schemas::rail_id_params())
            .body(schemas::route_state())
            .map(contract::to_core_route_state),
    );
    routes.push(get("/routes/:id/health", G_GATEWAY).params(schemas::rail_id_params()));
    routes.push(post("/routes/:id/health/probe", G_GATEWAY).params(schemas::rail_id_params()));
    routes.push(
        post("/routes/:id/health/override", G_GATEWAY)
            .params(schemas::rail_id_params())
            .body(schemas::route_health_override()),
    );
    routes.push(
        post("/routes/:id/health/override/clear", G_GATEWAY)
            .params(schemas::rail_id_params())
            .body(schemas::route_health_clear()),
    );

    // assets (gateway guard)
    routes.push(get("/assets", G_GATEWAY));
    routes.push(
        post("/assets", G_GATEWAY)
            .body(schemas::asset_create())
            .map(contract::to_core_asset_create)
            .status(201),
    );
    // POST /assets/upload is a multipart route.
    routes.push(
        get("/assets/:id/content", G_GATEWAY)
            .params(
                crate::schema::object()
                    .req("id", crate::schema::pattern(1, 64, "^[A-Za-z0-9_-]+$"))
                    .build(),
            )
            .kind(Kind::Raw(RawMode::AssetContent)),
    );
    routes.push(
        delete("/assets/:id", G_GATEWAY).params(
            crate::schema::object()
                .req("id", crate::schema::pattern(1, 64, "^[A-Za-z0-9_-]+$"))
                .build(),
        ),
    );
    routes.push(
        get("/assets/:id", G_GATEWAY).params(
            crate::schema::object()
                .req("id", crate::schema::pattern(1, 64, "^[A-Za-z0-9_-]+$"))
                .build(),
        ),
    );
}

fn reconciliation(routes: &mut Vec<Route>) {
    routes.push(get("/reconciliation/sources", G_RECONCILIATION).query(schemas::list_query()));
    routes.push(
        post("/reconciliation/sources", G_RECONCILIATION)
            .body(schemas::reconciliation_source_create())
            .map(contract::to_core_reconciliation_source_create)
            .status(201),
    );
    routes.push(
        patch("/reconciliation/sources/:id", G_RECONCILIATION)
            .params(schemas::reconciliation_source_params())
            .body(schemas::reconciliation_source_patch()),
    );
    // POST /reconciliation/upload is the multipart statement route.
    routes.push(
        get("/reconciliation/runs/summary", G_RECONCILIATION)
            .core("/internal/admin/reconciliation/summary")
            .query(schemas::list_query()),
    );
    routes.push(
        get("/reconciliation/runs/summary/export", G_RECONCILIATION)
            .core("/internal/admin/reconciliation/summary/export")
            .query(schemas::summary_export_query()),
    );
    routes.push(
        get("/reconciliation/runs/:id/statement", G_RECONCILIATION)
            .params(schemas::reconciliation_source_params())
            .kind(Kind::Raw(RawMode::Plain)),
    );
    routes.push(
        get("/reconciliation/runs/:id/export", G_RECONCILIATION)
            .params(schemas::reconciliation_source_params())
            .query(schemas::gateway_export_query()),
    );
    routes.push(
        get("/reconciliation/runs/:id", G_RECONCILIATION)
            .params(schemas::reconciliation_source_params())
            .query(schemas::list_query()),
    );
    routes.push(get("/reconciliation/runs", G_RECONCILIATION).query(schemas::list_query()));
}

fn settings(routes: &mut Vec<Route>) {
    routes.push(get("/settings", G_SETTINGS));
    routes.push(
        post("/settings/restore-preview", G_SETTINGS).body(schemas::settings_restore_preview()),
    );
    routes
        .push(post("/settings/restore-apply", G_SETTINGS).body(schemas::settings_restore_apply()));
    routes.push(get("/settings/export", G_SETTINGS).query(schemas::summary_export_query()));
    routes.push(get("/settings/summary", G_SETTINGS));
    routes.push(get("/settings/summary/export", G_SETTINGS).query(schemas::summary_export_query()));
    routes.push(get("/settings/communication/status", G_SETTINGS));
    routes.push(
        post("/settings/communication/test-email", G_SETTINGS)
            .body(schemas::communication_test_email()),
    );
    routes.push(
        post("/settings/communication/test-sms", G_SETTINGS)
            .body(schemas::communication_test_sms()),
    );
    routes.push(
        put("/settings", G_SETTINGS)
            .body(schemas::settings_update())
            .map(contract::to_core_settings_update),
    );
    routes.push(get("/settings/checkout-support", G_SETTINGS));
    routes.push(get("/settings/checkout-support/history", G_SETTINGS));
    routes.push(get("/settings/checkout-support/summary", G_SETTINGS));
    routes.push(
        get("/settings/checkout-support/summary/export", G_SETTINGS)
            .query(schemas::summary_export_query()),
    );
    routes.push(
        put("/settings/checkout-support", G_SETTINGS)
            .body(schemas::checkout_support())
            .map(|body| {
                let mut value = body.clone();
                if let Some(object) = value.as_object_mut() {
                    object.remove("checklist");
                }
                let checklist = body.get("checklist").cloned();
                match checklist {
                    Some(checklist) => {
                        Ok(serde_json::json!({ "value": value, "checklist": checklist }))
                    }
                    None => Ok(serde_json::json!({ "value": value })),
                }
            }),
    );
    routes.push(get("/settings/notification-templates", G_SETTINGS).query(schemas::list_query()));
    routes.push(
        put("/settings/notification-templates/:id", G_SETTINGS)
            .params(schemas::uuid_params())
            .body(schemas::notification_template_update())
            .relay(),
    );
}

fn options_and_stats(routes: &mut Vec<Route>) {
    routes.push(
        get("/options/:kind", Guard::Session)
            .params(
                crate::schema::object()
                    .req(
                        "kind",
                        crate::schema::enumeration(&[
                            "merchants",
                            "rails",
                            "gateways",
                            "users",
                            "applications",
                            "wallets",
                            "credential-sets",
                            "gl-accounts",
                        ]),
                    )
                    .build(),
            )
            .query(
                crate::schema::object()
                    .opt("search", crate::schema::text(0, 120))
                    .opt("limit", crate::schema::coerce_integer(1, 100))
                    .opt("ownerId", crate::schema::text(0, 64))
                    .strict()
                    .build(),
            ),
    );
    routes.push(
        get("/stats/export", Guard::Session)
            .core("/internal/admin/stats/overview")
            .query(stats_query()),
    );
    routes.push(
        post("/stats/export-audit", Guard::Session)
            .body(stats_export_audit())
            .status(201),
    );
    routes.push(get("/stats/overview", Guard::Session).query(stats_query()));
    routes
        .push(get("/stats/recent-activity/export", Guard::Session).query(recent_activity_query()));
    routes.push(get("/stats/recent-activity", Guard::Session).query(recent_activity_query()));
}

fn stats_query() -> Schema {
    crate::schema::object()
        .opt(
            "period",
            crate::schema::enumeration(&["24h", "7d", "30d", "90d"]),
        )
        .passthrough()
        .build()
}

fn recent_activity_query() -> Schema {
    crate::schema::object()
        .opt("limit", crate::schema::coerce_integer(1, 5000))
        .passthrough()
        .build()
}

fn stats_export_audit() -> Schema {
    crate::schema::object()
        .req(
            "period",
            crate::schema::enumeration(&["24h", "7d", "30d", "90d"]),
        )
        .opt(
            "checklist",
            crate::schema::array_sized(
                crate::schema::enumeration(&[
                    "PERIOD_VERIFIED",
                    "METRICS_REVIEWED",
                    "DISTRIBUTION_ACKNOWLEDGED",
                    "EXPORT_SCOPE_CONFIRMED",
                ]),
                0,
                10,
            ),
        )
        .strict()
        .build()
}

fn credentials(routes: &mut Vec<Route>) {
    routes.push(get("/credential-sets", G_CREDENTIALS).query(schemas::list_query()));
    routes
        .push(get("/credential-sets/:id", G_CREDENTIALS).params(schemas::credential_set_params()));
    routes.push(
        post("/credential-sets", G_CREDENTIALS)
            .body(schemas::credential_set_create())
            .status(201),
    );
    routes.push(
        put("/credential-sets/:id", G_CREDENTIALS)
            .params(schemas::credential_set_params())
            .body(schemas::credential_set_update()),
    );
    routes.push(
        post("/credential-sets/:id/verify", G_CREDENTIALS)
            .params(schemas::credential_set_params())
            .body(schemas::credential_set_verify()),
    );
    routes.push(
        post("/credential-sets/:id/revoke", G_CREDENTIALS)
            .params(schemas::credential_set_params())
            .body(schemas::credential_set_revoke()),
    );
}

fn audit(routes: &mut Vec<Route>) {
    routes.push(get("/audit-logs", G_AUDIT).query(schemas::audit_list_query()));
    routes.push(get("/audit-logs/export", G_AUDIT).query(schemas::list_query()));
    routes.push(get("/audit-logs/summary/export", G_AUDIT).query(schemas::summary_export_query()));
    routes.push(get("/audit-logs/summary", G_AUDIT));
    routes.push(
        get("/audit-logs/:id", G_AUDIT).params(
            crate::schema::object()
                .req("id", crate::schema::text(1, 64))
                .build(),
        ),
    );
}

fn kyb(routes: &mut Vec<Route>) {
    routes.push(get("/kyb-documents", G_KYB).query(schemas::list_query()));
    routes.push(get("/kyb-documents/export", G_KYB).query(schemas::list_query()));
    routes.push(get("/kyb-documents/summary", G_KYB));
    routes.push(get("/kyb-documents/summary/export", G_KYB).query(schemas::summary_export_query()));
    routes.push(get("/kyb-documents/:id", G_KYB).params(schemas::kyb_id_params()));
    routes.push(
        post("/kyb-documents/:id/review", G_KYB)
            .params(schemas::kyb_id_params())
            .body(schemas::kyb_review())
            .map(contract::to_core_kyb_document_review),
    );
    routes.push(
        post("/kyb-documents/:id/request-replacement", G_KYB)
            .params(schemas::kyb_id_params())
            .body(schemas::kyb_replacement())
            .map(contract::to_core_kyb_document_replacement),
    );
    routes.push(
        post("/kyb-documents/:id/request-revalidation", G_KYB)
            .params(schemas::kyb_id_params())
            .body(schemas::kyb_revalidation())
            .map(contract::to_core_kyb_document_revalidation)
            .relay(),
    );
    routes.push(
        get("/kyb-documents/:id/content", G_KYB)
            .params(schemas::kyb_id_params())
            .kind(Kind::Raw(RawMode::KybContent)),
    );
}

fn object_storage(routes: &mut Vec<Route>) {
    routes.push(get("/object-storage/summary", G_OBJECT_STORAGE));
    routes.push(
        get("/object-storage/access-logs", G_OBJECT_STORAGE)
            .query(schemas::object_storage_access_logs()),
    );
    routes.push(
        get("/object-storage/objects", G_OBJECT_STORAGE).query(schemas::object_storage_list()),
    );
    routes.push(
        get("/object-storage/objects/:id", G_OBJECT_STORAGE)
            .params(schemas::object_storage_object_params()),
    );
    routes.push(
        post("/object-storage/objects/:id/legal-hold", G_OBJECT_STORAGE)
            .params(schemas::object_storage_object_params())
            .body(schemas::object_storage_legal_hold())
            .relay(),
    );
    routes.push(
        delete("/object-storage/objects/:id/legal-hold", G_OBJECT_STORAGE)
            .params(schemas::object_storage_object_params())
            .body(schemas::object_storage_legal_hold())
            .relay(),
    );
    routes.push(
        post("/object-storage/maintenance/:job", G_OBJECT_STORAGE_ADMIN)
            .params(schemas::object_storage_maintenance_params())
            .body(
                crate::schema::object()
                    .opt("checklist", schemas::checklist_any(10))
                    .strict()
                    .build(),
            ),
    );
}

fn backups(routes: &mut Vec<Route>) {
    routes.push(get("/system/backups/overview", G_BACKUPS_READ));
    routes.push(get("/system/backups/catalog", G_BACKUPS_READ));
    routes.push(
        post("/system/backups/trigger", G_BACKUPS_READ)
            .body(schemas::backup_trigger())
            .relay(),
    );
    routes.push(
        post("/system/backups/drill", G_BACKUPS_READ)
            .body(schemas::backup_drill())
            .relay(),
    );
    routes.push(
        put("/system/backups/policy", G_BACKUPS_READ)
            .body(schemas::backup_policy())
            .relay(),
    );
}

fn system(routes: &mut Vec<Route>) {
    routes.push(get("/system/jobs-outbox/summary", G_SYSTEM));
    routes.push(get("/system/jobs", G_SYSTEM).query(schemas::list_query()));
    routes.push(
        post("/system/jobs/:id/requeue", G_SYSTEM)
            .params(schemas::uuid_params())
            .body(job_action())
            .relay(),
    );
    routes.push(get("/system/outbox", G_SYSTEM).query(schemas::list_query()));
    routes.push(get("/system/audit-outbox", G_SYSTEM).query(schemas::list_query()));
    routes.push(get("/system/notifications", G_SYSTEM).query(schemas::list_query()));
    routes.push(
        post("/system/notifications/:id/retry", G_SYSTEM)
            .params(schemas::uuid_params())
            .body(job_action())
            .relay(),
    );
}

fn job_action() -> Schema {
    crate::schema::object()
        .req("reason", crate::schema::trimmed(10, 500))
        .opt("checklist", schemas::checklist_any(10))
        .strict()
        .build()
}

fn report_engine(routes: &mut Vec<Route>) {
    routes.push(
        get("/report-engine/transcript", G_REPORT_ENGINE).query(
            crate::schema::object()
                .opt("kind", crate::schema::string_any())
                .opt("domains", crate::schema::string_any())
                .passthrough()
                .build(),
        ),
    );
    routes.push(
        post("/report-engine/specs/verify", G_REPORT_ENGINE).body(schemas::report_verify_body()),
    );
    routes.push(
        post("/report-engine/specs/preview", G_REPORT_ENGINE).body(schemas::report_preview_body()),
    );
    routes.push(
        post("/report-engine/specs", G_REPORT_ENGINE)
            .body(schemas::report_spec_body())
            .status(201),
    );
    routes.push(
        get("/report-engine/specs", G_REPORT_ENGINE).query(
            crate::schema::object()
                .opt("code", crate::schema::text(0, 64))
                .opt("status", crate::schema::text(0, 32))
                .passthrough()
                .build(),
        ),
    );
    routes.push(
        get("/report-engine/specs/needs-migration", G_REPORT_ENGINE).query(
            crate::schema::object()
                .opt("source", crate::schema::text(0, 16))
                .opt("search", crate::schema::text(0, 200))
                .passthrough()
                .build(),
        ),
    );
    routes.push(
        get("/report-engine/specs/:id/migration-prompt", G_REPORT_ENGINE)
            .params(schemas::report_engine_id_params()),
    );
    routes.push(
        get("/report-engine/specs/:id", G_REPORT_ENGINE).params(schemas::report_engine_id_params()),
    );
    routes.push(
        post("/report-engine/specs/:id/archive", G_REPORT_ENGINE)
            .params(schemas::report_engine_id_params())
            .body(schemas::report_empty_body()),
    );
    routes.push(
        post("/report-engine/specs/:id/publish", G_REPORT_ENGINE)
            .params(schemas::report_engine_id_params())
            .body(schemas::report_publish_body()),
    );
    routes.push(
        get("/report-engine/executions", G_REPORT_ENGINE).query(
            crate::schema::object()
                .opt("limit", crate::schema::coerce_integer(1, 200))
                .passthrough()
                .build(),
        ),
    );
    routes.push(
        post(
            "/report-engine/specs/:id/authority-override",
            G_REPORT_ENGINE,
        )
        .params(schemas::report_engine_id_params())
        .body(schemas::report_override_body()),
    );
    routes.push(
        get("/report-engine/catalog", G_REPORT_ENGINE).query(
            crate::schema::object()
                .opt("audience", crate::schema::text(0, 32))
                .opt("page", crate::schema::coerce_integer(1, i64::MAX))
                .opt("pageSize", crate::schema::coerce_integer(1, 200))
                .opt("search", crate::schema::text(0, 200))
                .opt("sortKey", crate::schema::text(0, 64))
                .opt(
                    "sortDirection",
                    crate::schema::enumeration(&["asc", "desc"]),
                )
                .passthrough()
                .build(),
        ),
    );
    routes.push(
        get("/report-engine/autocomplete/:sourceKey", G_REPORT_ENGINE)
            .params(schemas::report_engine_source_params())
            .query(
                crate::schema::object()
                    .opt("q", crate::schema::string_any())
                    .opt("limit", crate::schema::coerce_integer(1, 50))
                    .opt("dependent", crate::schema::string_any())
                    .passthrough()
                    .build(),
            ),
    );
    routes.push(
        post("/report-engine/catalog/:code/execute", G_REPORT_ENGINE)
            .params(schemas::report_engine_code_params())
            .body(schemas::report_execute_body()),
    );
    routes.push(get("/report-engine/aml-bypass/pending", G_REPORT_ENGINE));
    routes.push(
        post("/report-engine/aml-bypass/:id/approve", G_REPORT_ENGINE)
            .params(schemas::report_engine_id_params())
            .body(schemas::report_empty_body()),
    );
    routes.push(
        post("/report-engine/aml-bypass/:id/reject", G_REPORT_ENGINE)
            .params(schemas::report_engine_id_params())
            .body(schemas::report_reject_body()),
    );
    routes.push(
        get("/report-engine/chrome", G_REPORT_ENGINE).query(
            crate::schema::object()
                .opt("type", crate::schema::string_any())
                .opt("includeArchived", crate::schema::string_any())
                .opt("page", crate::schema::coerce_integer(1, i64::MAX))
                .opt("pageSize", crate::schema::coerce_integer(1, 200))
                .opt("search", crate::schema::text(0, 200))
                .opt("sortKey", crate::schema::text(0, 64))
                .opt(
                    "sortDirection",
                    crate::schema::enumeration(&["asc", "desc"]),
                )
                .passthrough()
                .build(),
        ),
    );
    routes.push(
        post("/report-engine/chrome", G_REPORT_ENGINE)
            .body(schemas::report_chrome_body())
            .status(201),
    );
    routes.push(
        post("/report-engine/chrome/:id/archive", G_REPORT_ENGINE)
            .params(schemas::report_engine_id_params())
            .body(schemas::report_empty_body()),
    );
    routes.push(
        post("/report-engine/chrome/:id/set-default", G_REPORT_ENGINE)
            .params(schemas::report_engine_id_params())
            .body(schemas::report_chrome_default_body()),
    );
    routes.push(
        get("/report-engine/merchant-reports", G_REPORT_ENGINE).query(
            crate::schema::object()
                .opt("merchantId", crate::schema::uuid())
                .opt("search", crate::schema::text(0, 200))
                .opt("page", crate::schema::coerce_integer(1, i64::MAX))
                .opt("pageSize", crate::schema::coerce_integer(1, 200))
                .opt("sortKey", crate::schema::text(0, 64))
                .opt(
                    "sortDirection",
                    crate::schema::enumeration(&["asc", "desc"]),
                )
                .passthrough()
                .build(),
        ),
    );
    routes.push(
        get("/report-engine/merchant-executions", G_REPORT_ENGINE).query(
            crate::schema::object()
                .opt("merchantId", crate::schema::uuid())
                .opt("limit", crate::schema::coerce_integer(1, 500))
                .passthrough()
                .build(),
        ),
    );
    routes.push(
        post(
            "/report-engine/merchant-reports/:merchantId/suspend",
            G_REPORT_ENGINE,
        )
        .params(schemas::report_merchant_params())
        .body(schemas::report_merchant_suspend()),
    );
    routes.push(
        post(
            "/report-engine/merchant-reports/:merchantId/resume",
            G_REPORT_ENGINE,
        )
        .params(schemas::report_merchant_params())
        .body(schemas::report_merchant_resume()),
    );
    routes.push(
        get(
            "/report-engine/merchant-reports/:id/migration-prompt",
            G_REPORT_ENGINE,
        )
        .params(schemas::report_engine_id_params()),
    );
    routes.push(
        get("/report-engine/chrome/needs-migration", G_REPORT_ENGINE).query(
            crate::schema::object()
                .opt("page", crate::schema::coerce_integer(1, i64::MAX))
                .opt("pageSize", crate::schema::coerce_integer(1, 200))
                .opt("search", crate::schema::text(0, 200))
                .passthrough()
                .build(),
        ),
    );
    routes.push(
        get("/report-engine/chrome/:id", G_REPORT_ENGINE)
            .params(schemas::report_engine_id_params()),
    );
    routes.push(
        get(
            "/report-engine/chrome/:id/migration-prompt",
            G_REPORT_ENGINE,
        )
        .params(schemas::report_engine_id_params()),
    );
    routes.push(
        post("/report-engine/chrome/reconcile-defaults", G_REPORT_ENGINE).body(
            crate::schema::object()
                .opt("checklist", schemas::checklist_any(10))
                .strict()
                .build(),
        ),
    );
}

fn operations(routes: &mut Vec<Route>) {
    routes.push(get("/gateway-inquiries", G_CASES).query(schemas::list_query()));
    routes.push(get("/gateway-inquiries/summary", G_CASES));
    routes.push(
        get("/gateway-inquiries/summary/export", G_CASES).query(schemas::summary_export_query()),
    );
    routes.push(get("/gateway-inquiries/:id", G_CASES).params(schemas::operator_id_params()));
    routes.push(
        post("/gateway-inquiries/:id/cancel", G_CASES)
            .params(schemas::operator_id_params())
            .body(schemas::gateway_inquiry_cancel())
            .relay(),
    );
    routes.push(
        post("/gateway-inquiries/:id/run-now", G_CASES)
            .params(schemas::operator_id_params())
            .body(schemas::gateway_inquiry_action())
            .relay(),
    );
    routes.push(
        post("/gateway-inquiries/:id/retry", G_CASES)
            .params(schemas::operator_id_params())
            .body(schemas::gateway_inquiry_action())
            .relay(),
    );
    routes.push(get("/operator-cases", G_CASES).query(schemas::list_query()));
    routes.push(get("/operator-cases/export", G_CASES).query(schemas::list_query()));
    routes.push(get("/operator-cases/summary", G_CASES));
    routes.push(post("/operator-cases/bulk-inquire", G_CASES).body(schemas::bulk_inquire()));
    routes.push(post("/operator-cases/bulk-assign", G_CASES).body(schemas::bulk_assign()));
    routes.push(post("/operator-cases/bulk-state", G_CASES).body(schemas::bulk_state()));
    routes.push(
        patch("/operator-cases/:id", G_CASES)
            .params(schemas::operator_id_params())
            .body(schemas::operator_case_patch()),
    );
    routes.push(
        post("/operator-cases/:id/resolve", G_CASES)
            .params(schemas::operator_id_params())
            .body(schemas::operator_case_resolve())
            .map(contract::to_core_operator_case_resolve)
            .relay(),
    );
    routes.push(
        get("/operator-cases/summary/export", G_CASES).query(schemas::summary_export_query()),
    );
    routes.push(get("/operator-cases/catalog", G_CASES));
    routes.push(
        post("/operator-cases/:id/acknowledge", G_CASES)
            .params(schemas::operator_id_params())
            .body(schemas::operator_case_acknowledge()),
    );
    routes.push(get("/operator-cases/:id", G_CASES).params(schemas::operator_id_params()));
    routes.push(
        post("/attempts/:id/inquire", G_ATTEMPTS)
            .params(schemas::operator_id_params())
            .body(schemas::attempt_inquire()),
    );
    routes.push(get("/attempts/:id", G_ATTEMPTS).params(schemas::operator_id_params()));
}

fn finance(routes: &mut Vec<Route>) {
    routes.push(get("/disputes", G_DISPUTES).query(schemas::list_query()));
    routes.push(
        post("/disputes", G_DISPUTES)
            .body(schemas::dispute_create())
            .map(contract::to_core_dispute_create)
            .relay(),
    );
    routes.push(get("/disputes/export", G_DISPUTES).query(schemas::gateway_export_query()));
    routes.push(get("/disputes/summary", G_DISPUTES).query(schemas::list_query()));
    routes.push(get("/disputes/summary/export", G_DISPUTES).query(schemas::summary_export_query()));
    routes.push(get("/disputes/:id/attachments", G_DISPUTES).params(schemas::finance_id_params()));
    // POST /disputes/:id/attachments is a multipart route.
    routes.push(
        get(
            "/disputes/:id/attachments/:attachmentId/content",
            G_DISPUTES,
        )
        .params(schemas::attachment_params())
        .kind(Kind::Raw(RawMode::Plain)),
    );
    routes.push(
        delete("/disputes/:id/attachments/:attachmentId", G_DISPUTES)
            .params(schemas::attachment_params()),
    );
    routes.push(get("/disputes/:id", G_DISPUTES).params(schemas::finance_id_params()));
    routes.push(
        post("/disputes/:id/evidence", G_DISPUTES)
            .params(schemas::finance_id_params())
            .body(schemas::dispute_evidence()),
    );
    routes.push(get("/adjustments", G_ADJUSTMENTS).query(schemas::list_query()));
    routes.push(get("/adjustments/export", G_ADJUSTMENTS).query(schemas::gateway_export_query()));
    routes.push(get("/adjustments/summary", G_ADJUSTMENTS).query(schemas::list_query()));
    routes.push(
        get("/adjustments/summary/export", G_ADJUSTMENTS).query(schemas::summary_export_query()),
    );
    routes.push(get("/adjustments/:id", G_ADJUSTMENTS).params(schemas::finance_id_params()));
    routes.push(
        post("/adjustments", G_ADJUSTMENTS)
            .body(schemas::adjustment_create())
            .map(contract::to_core_adjustment_create)
            .status(201),
    );
    routes.push(get("/cashouts", G_CASHOUTS).query(schemas::list_query()));
    routes.push(get("/cashouts/export", G_CASHOUTS).query(schemas::gateway_export_query()));
    routes.push(get("/cashouts/summary", G_CASHOUTS).query(schemas::list_query()));
    routes.push(get("/cashouts/summary/export", G_CASHOUTS).query(schemas::summary_export_query()));
    routes.push(get("/cashouts/:id", G_CASHOUTS).params(schemas::finance_id_params()));
    routes.push(
        post("/cashouts/:id/process", G_CASHOUTS)
            .params(schemas::finance_id_params())
            .body(schemas::cashout_process())
            .map(contract::to_core_cashout_process),
    );
    routes.push(get("/commission-profiles", G_COMMISSION));
    routes.push(get("/commission-profiles/summary", G_COMMISSION));
    routes.push(
        post("/commission-profiles", G_COMMISSION)
            .body(schemas::commission_profile_create())
            .map(contract::to_core_commission_profile_create)
            .status(201),
    );
    routes.push(
        get("/commission-profiles/:id/history", G_COMMISSION).params(schemas::finance_id_params()),
    );
    routes.push(
        post("/commission-profiles/:id/expire", G_COMMISSION)
            .params(schemas::finance_id_params())
            .body(schemas::commission_profile_expire())
            .relay(),
    );
    routes.push(get("/velocity-rules", G_VELOCITY));
    routes
        .push(get("/velocity-rules/:id/history", G_VELOCITY).params(schemas::finance_id_params()));
    routes.push(
        post("/velocity-rules/:id/deactivate", G_VELOCITY)
            .params(schemas::finance_id_params())
            .body(schemas::velocity_rule_deactivate())
            .relay(),
    );
    routes.push(get("/velocity-rules/summary", G_VELOCITY));
    routes.push(
        post("/velocity-rules", G_VELOCITY)
            .body(schemas::velocity_rule_create())
            .map(contract::to_core_velocity_rule_create)
            .status(201),
    );
    routes.push(get("/finance/profitability", G_FINANCE).query(schemas::finance_period_query()));
    routes.push(
        get("/finance/profitability/export", G_FINANCE)
            .query(schemas::finance_period_export_query()),
    );
    routes.push(get("/finance/liquidity", G_FINANCE).query(schemas::finance_period_query()));
    routes.push(
        get("/finance/liquidity/export", G_FINANCE).query(schemas::finance_period_export_query()),
    );
    routes.push(
        get("/finance/invariant-check/export", G_FINANCE).query(schemas::summary_export_query()),
    );
    routes.push(get("/finance/invariant-check", G_FINANCE));
    routes.push(get("/finance/route-caps", G_FINANCE));
    routes.push(get("/finance/journal-entries", G_FINANCE).query(schemas::list_query()));
    routes.push(get("/finance/journal-entries/summary", G_FINANCE).query(schemas::list_query()));
    routes.push(
        get("/finance/journal-entries/summary/export", G_FINANCE)
            .query(schemas::summary_export_query()),
    );
    routes.push(get("/finance/journal-entries/:id", G_FINANCE).params(schemas::uuid_params()));
    routes.push(
        get("/finance/gl-accounts/:id/lines", G_FINANCE)
            .params(schemas::uuid_params())
            .query(schemas::list_query()),
    );
    routes.push(get("/finance/gl-accounts/:id", G_FINANCE).params(schemas::uuid_params()));
    routes.push(
        get(
            "/finance/gl-accounts/:id/shards/:shardId/repair-plan",
            G_FINANCE,
        )
        .params(schemas::shard_params()),
    );
    routes.push(
        post("/finance/gl-accounts/:id/shards/:shardId/repair", G_FINANCE)
            .params(schemas::shard_params())
            .body(schemas::shard_repair()),
    );
    routes.push(
        post(
            "/finance/gl-accounts/:id/shards/:shardId/repair/request",
            G_FINANCE,
        )
        .params(schemas::shard_params())
        .body(schemas::shard_repair())
        .relay(),
    );
    routes.push(
        post("/finance/gl-accounts/:id/shards/scale", G_FINANCE)
            .params(schemas::uuid_params())
            .body(schemas::shard_scale()),
    );
    routes.push(
        post("/finance/gl-accounts/:id/checkpoint", G_FINANCE)
            .params(schemas::uuid_params())
            .body(schemas::gl_checkpoint())
            .relay(),
    );
}

/// Multipart routes, matched before the JSON table because their bodies are not JSON.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UploadRoute {
    JoinRequestKyb,
    DisputeAttachment,
    AmlEvidence,
    ReconciliationStatement,
    Asset,
}

/// A multipart route description.
pub struct UploadSpec {
    pub route: UploadRoute,
    pub pattern: &'static str,
    pub core: &'static str,
    pub field: &'static str,
    pub guard: Guard,
    pub status: u16,
}

/// The five multipart endpoints.
#[must_use]
pub fn uploads() -> Vec<UploadSpec> {
    vec![
        UploadSpec {
            route: UploadRoute::JoinRequestKyb,
            pattern: "/join-requests/:id/kyb-documents",
            core: "/internal/admin/join-requests/:id/kyb-documents",
            field: "file",
            guard: G_KYB,
            status: 200,
        },
        UploadSpec {
            route: UploadRoute::DisputeAttachment,
            pattern: "/disputes/:id/attachments",
            core: "/internal/admin/disputes/:id/attachments",
            field: "file",
            guard: G_DISPUTES,
            status: 201,
        },
        UploadSpec {
            route: UploadRoute::AmlEvidence,
            pattern: "/aml/cases/:id/evidence",
            core: "/internal/admin/aml/cases/:id/evidence",
            field: "file",
            guard: G_AML,
            status: 201,
        },
        UploadSpec {
            route: UploadRoute::ReconciliationStatement,
            pattern: "/reconciliation/upload",
            core: "/internal/admin/reconciliation/upload",
            field: "statement",
            guard: G_RECONCILIATION,
            status: 202,
        },
        UploadSpec {
            route: UploadRoute::Asset,
            pattern: "/assets/upload",
            core: "/internal/admin/assets/upload",
            field: "file",
            guard: G_GATEWAY,
            status: 201,
        },
    ]
}

/// The Sandbox prefix handled by `sandbox.rs` (the TS router is a catch-all `use`).
pub const SANDBOX_PREFIX: &str = "/sandbox";

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn no_duplicate_method_and_pattern() {
        let mut seen = HashSet::new();
        for route in table() {
            assert!(
                seen.insert((route.method, route.pattern)),
                "duplicate {} {}",
                route.method,
                route.pattern
            );
        }
    }

    #[test]
    fn every_protected_route_has_a_session_guard() {
        for route in table() {
            if route.pattern.starts_with("/auth/") {
                assert!(matches!(route.guard, Guard::None));
            } else {
                assert!(
                    matches!(route.guard, Guard::Session | Guard::Authorities { .. }),
                    "{} {} has no guard",
                    route.method,
                    route.pattern
                );
            }
        }
    }

    #[test]
    fn covers_every_route_of_the_ts_inventory() {
        let routes = table();
        // 418 inventory entries: 10 auth (2 are limiter registrations for /login and /mfa) and
        // 408 protected. Five protected routes are multipart (`uploads()`), so the JSON table is
        // 8 auth + 403 forwarding/raw routes.
        assert_eq!(routes.len(), 411, "route count");
        assert_eq!(
            routes
                .iter()
                .filter(|route| route.pattern.starts_with("/auth/"))
                .count(),
            8
        );
        let count = |prefix: &str| {
            routes
                .iter()
                .filter(|route| {
                    route.pattern == prefix
                        || route
                            .pattern
                            .strip_prefix(prefix)
                            .is_some_and(|rest| rest.starts_with('/'))
                })
                .count()
        };
        for (prefix, expected) in [
            ("/academy", 9),
            ("/access-tokens", 2),
            ("/aml", 82), // 83 inventory, the evidence multipart upload is separate
            ("/applications", 5),
            ("/approvals", 9),
            ("/assets", 5), // 6 inventory, the multipart upload is separate
            ("/audit-logs", 5),
            ("/credential-sets", 6),
            ("/disputes", 10), // 11 inventory, the attachment upload is separate
            ("/adjustments", 6),
            ("/cashouts", 6),
            ("/commission-profiles", 5),
            ("/velocity-rules", 5),
            ("/finance", 18),
            ("/gateways", 14),
            ("/gateway-versions", 13),
            ("/join-requests", 18), // 19 inventory, the KYB upload is separate
            ("/kyb-documents", 9),
            ("/merchants", 28),
            ("/object-storage", 7),
            ("/gateway-inquiries", 7),
            ("/operator-cases", 12),
            ("/attempts", 2),
            ("/options", 1),
            ("/payment-links", 2),
            ("/pos-terminals", 2),
            ("/rails", 8),
            ("/routes", 12),
            ("/reconciliation", 9), // 10 inventory, the statement upload is separate
            ("/report-engine", 31),
            ("/search", 1),
            ("/settings", 17),
            ("/stats", 5),
            ("/system", 12),
            ("/transactions", 3),
            ("/inbound-events", 2),
            ("/users", 9),
            ("/wallets", 6),
        ] {
            assert_eq!(count(prefix), expected, "{prefix}");
        }
    }

    #[test]
    fn special_core_paths_match_the_ts_overrides() {
        let routes = table();
        let core = |method: &str, pattern: &str| {
            routes
                .iter()
                .find(|route| route.method == method && route.pattern == pattern)
                .map(|route| route.core.as_str())
                .unwrap_or_default()
        };
        assert_eq!(
            core("GET", "/stats/export"),
            "/internal/admin/stats/overview"
        );
        assert_eq!(
            core("GET", "/reconciliation/runs/summary"),
            "/internal/admin/reconciliation/summary"
        );
        assert_eq!(
            core("GET", "/reconciliation/runs/summary/export"),
            "/internal/admin/reconciliation/summary/export"
        );
        assert_eq!(core("GET", "/aml/incidents"), "/internal/admin/incidents");
        assert_eq!(
            core("POST", "/aml/incidents/:id/report"),
            "/internal/admin/incidents/:id/report"
        );
    }

    #[test]
    fn every_core_path_stays_in_the_admin_channel() {
        for route in table() {
            assert!(
                route.core.starts_with("/internal/admin/"),
                "{} {} -> {}",
                route.method,
                route.pattern,
                route.core
            );
        }
    }

    #[test]
    fn matches_the_committed_route_inventory_exactly() {
        let raw = include_str!("../../../tests/golden-vectors/route-inventory/edge-routes.json");
        let inventory: Vec<serde_json::Value> =
            serde_json::from_str(raw).expect("route inventory JSON");
        let mut expected: std::collections::BTreeSet<(String, String)> =
            std::collections::BTreeSet::new();
        for entry in inventory {
            if entry.get("service").and_then(|value| value.as_str()) != Some("admin-back") {
                continue;
            }
            let Some(full) = entry.get("fullPath").and_then(|value| value.as_str()) else {
                continue;
            };
            let Some(relative) = full.strip_prefix("/api/v1/admin") else {
                continue;
            };
            let method = entry
                .get("method")
                .and_then(|value| value.as_str())
                .unwrap_or("GET")
                .to_owned();
            expected.insert((method, relative.to_owned()));
        }
        let mut served: std::collections::BTreeSet<(String, String)> =
            std::collections::BTreeSet::new();
        for route in table() {
            served.insert((route.method.to_owned(), route.pattern.to_owned()));
        }
        for spec in uploads() {
            served.insert(("POST".to_owned(), spec.pattern.to_owned()));
        }
        assert_eq!(
            expected, served,
            "the Rust table must serve every inventory route exactly once"
        );
    }

    #[test]
    fn uploads_cover_the_five_multipart_endpoints() {
        let uploads = uploads();
        assert_eq!(uploads.len(), 5);
        let mut seen = HashSet::new();
        for spec in uploads {
            assert!(seen.insert(spec.pattern), "duplicate {}", spec.pattern);
            assert!(spec.core.starts_with("/internal/admin/"));
        }
    }
}
