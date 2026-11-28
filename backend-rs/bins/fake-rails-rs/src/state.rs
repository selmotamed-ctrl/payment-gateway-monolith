//! App-wide state shared by the rail server, the tester portal and the control plane.

#![forbid(unsafe_code)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::config::Config;
use crate::db::Db;
use crate::events::Hub;
use crate::webhook::WebhookService;

pub struct AppState {
    pub config: Arc<Config>,
    pub db: Db,
    pub hub: Hub,
    pub webhooks: WebhookService,
    /// Single-use SSE tickets: `jti -> exp (epoch seconds)`.
    pub used_tickets: Arc<Mutex<HashMap<String, i64>>>,
    /// Login failures per bucket (`ip:<addr>` and `acct:<username>`): epoch milliseconds.
    pub login_attempts: Arc<Mutex<HashMap<String, Vec<i64>>>>,
    pub started_at: chrono::DateTime<chrono::Utc>,
}

impl Clone for AppState {
    fn clone(&self) -> Self {
        Self {
            config: self.config.clone(),
            db: self.db.clone(),
            hub: self.hub.clone(),
            webhooks: self.webhooks.clone(),
            used_tickets: self.used_tickets.clone(),
            login_attempts: self.login_attempts.clone(),
            started_at: self.started_at,
        }
    }
}

impl std::fmt::Debug for AppState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppState")
            .field("node_env", &self.config.node_env)
            .finish_non_exhaustive()
    }
}

impl AppState {
    pub fn new(config: Config) -> crate::error::ApiResult<Self> {
        let db = Db::open(&config.db_path)?;
        crate::chaos::ensure_default_scenarios(&db)?;
        crate::accounts::ensure_default_accounts(&db)?;
        let hub = Hub::new();
        let config = Arc::new(config);
        let webhooks = WebhookService::new(db.clone(), config.clone(), hub.clone());
        Ok(Self {
            config,
            db,
            hub,
            webhooks,
            used_tickets: Arc::new(Mutex::new(HashMap::new())),
            login_attempts: Arc::new(Mutex::new(HashMap::new())),
            started_at: chrono::Utc::now(),
        })
    }

    #[must_use]
    pub fn now_ms() -> i64 {
        chrono::Utc::now().timestamp_millis()
    }
}
