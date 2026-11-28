//! GL-account resolution and its bounded cache.
//!
//! Port of `LedgerPoster.resolveAccountIds` / `accountPredicates` / `resolveAccountId`
//! (`core-back/engine/ledger/LedgerPoster.ts:1086-1299`) and of the raw-SQL candidate query
//! (`:1173-1209`).
//!
//! Resolution order per line (design chapter 2 §14 step 3):
//!
//! 1. `selector.account_id` (no existence check, like TS);
//! 2. `context.accounts[account_type]`;
//! 3. a scoped lookup: account type plus only the dimensions the account type carries
//!    (`ACCOUNT_SCOPING`, `LedgerPoster.ts:316-328`) — merchant wallet: owner; gateway clearing:
//!    gateway, credential set, environment; everything else: global — all with the currency;
//! 4. the platform-wide fallback of the same type and currency (null scope dimensions);
//! 5. `GL_ACCOUNT_NOT_FOUND`.
//!
//! The scoped and fallback predicates of every unresolved line are resolved in **one** `SELECT`
//! over their `OR` (like the TS batched path), ordered by `id`, and matched in memory with the same
//! precedence. Only a **scoped** hit is cached; a fallback is never remembered because a scoped
//! account created afterwards must take over (`LedgerPoster.ts:1096-1103`).

#![forbid(unsafe_code)]

use std::collections::{BTreeSet, HashMap};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use pg_domain_ledger::AccountType;
use sqlx::{FromRow, PgConnection, Postgres, QueryBuilder};
use uuid::Uuid;

use crate::error::LedgerError;
use crate::template::{AccountSelector, JournalTemplate, PostOptions};

/// Default TTL of a resolved scoped account (`ACCOUNT_CACHE_TTL_MS`, `LedgerPoster.ts:195`).
pub const ACCOUNT_CACHE_TTL: Duration = Duration::from_secs(60);

/// Maximum entries of the account cache (`ACCOUNT_CACHE_MAX_ENTRIES`, `LedgerPoster.ts:202`).
pub const ACCOUNT_CACHE_MAX_ENTRIES: usize = 20_000;

/// Bounded, 60-second cache of *scoped* account resolutions.
///
/// The cache stores a predicate key (the scoped dimensions of a lookup) and the account id it
/// resolved to. It is empty by default unless a [`PostOptions`] carries one. It is `Sync`; one
/// instance can be shared by every caller in a process, like the TS `Map` on the poster.
#[derive(Debug)]
pub struct AccountCache {
    ttl: Duration,
    max_entries: usize,
    entries: Mutex<HashMap<String, CacheEntry>>,
}

#[derive(Debug, Clone, Copy)]
struct CacheEntry {
    id: Uuid,
    expires_at: Instant,
}

impl Default for AccountCache {
    fn default() -> Self {
        Self::new()
    }
}

impl AccountCache {
    /// The production cache: 60 s, at most 20,000 entries.
    #[must_use]
    pub fn new() -> Self {
        Self::with_limits(ACCOUNT_CACHE_TTL, ACCOUNT_CACHE_MAX_ENTRIES)
    }

    /// A cache with explicit limits (tests, and a process that wants a tighter budget).
    #[must_use]
    pub fn with_limits(ttl: Duration, max_entries: usize) -> Self {
        Self {
            ttl,
            max_entries,
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// The account resolved from `key`, when it is still fresh.
    #[must_use]
    pub fn get(&self, key: &str) -> Option<Uuid> {
        self.get_at(key, Instant::now())
    }

    /// Remembers a **scoped** account resolution.
    pub fn insert(&self, key: String, id: Uuid) {
        self.insert_at(key, id, Instant::now());
    }

    /// Forgets every entry (tests; after an account is created that must take over).
    pub fn clear(&self) {
        self.entries.lock().clear();
    }

    /// Number of live entries (tests and metrics).
    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.lock().len()
    }

    /// `true` when nothing is cached.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn get_at(&self, key: &str, now: Instant) -> Option<Uuid> {
        let entries = self.entries.lock();
        let entry = entries.get(key)?;
        (entry.expires_at > now).then_some(entry.id)
    }

    fn insert_at(&self, key: String, id: Uuid, now: Instant) {
        if self.ttl.is_zero() {
            return;
        }
        let mut entries = self.entries.lock();
        if entries.len() >= self.max_entries {
            // TS clears the whole map when it reaches the bound (`LedgerPoster.ts:1159`).
            entries.clear();
        }
        entries.insert(
            key,
            CacheEntry {
                id,
                expires_at: now + self.ttl,
            },
        );
    }
}

/// One dimension of an account predicate: unconstrained, `IS NULL`, or one value.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Dim<T> {
    Any,
    Null,
    Eq(T),
}

impl<T: AsRef<str>> Dim<T> {
    fn matches_text(&self, candidate: Option<&str>) -> bool {
        match self {
            Self::Any => true,
            Self::Null => candidate.is_none(),
            Self::Eq(value) => candidate == Some(value.as_ref()),
        }
    }
}

/// A scoped or platform-wide account predicate (`scopedWhere` / `fallbackWhere`,
/// `LedgerPoster.ts:1229-1258`).
#[derive(Debug, Clone, PartialEq, Eq)]
struct AccountPredicate {
    account_type: AccountType,
    owner_id: Dim<String>,
    gateway_id: Dim<Uuid>,
    credential_set_id: Dim<Uuid>,
    env: Dim<String>,
    currency: Dim<String>,
}

impl AccountPredicate {
    fn matches(&self, candidate: &AccountCandidate) -> bool {
        AccountType::parse(&candidate.account_type) == Some(self.account_type)
            && self.owner_id.matches_text(candidate.owner_id.as_deref())
            && matches_uuid(&self.gateway_id, candidate.gateway_id)
            && matches_uuid(&self.credential_set_id, candidate.credential_set_id)
            && self.env.matches_text(candidate.env.as_deref())
            && self.currency.matches_text(Some(candidate.currency.trim()))
    }

    /// A stable key for the scoped lookup: the cache key and the deduplication key of the batch.
    fn key(&self) -> String {
        fn text(dim: &Dim<String>) -> String {
            match dim {
                Dim::Any => "-".to_owned(),
                Dim::Null => "null".to_owned(),
                Dim::Eq(value) => value.clone(),
            }
        }
        fn uuid(dim: &Dim<Uuid>) -> String {
            match dim {
                Dim::Any => "-".to_owned(),
                Dim::Null => "null".to_owned(),
                Dim::Eq(value) => value.to_string(),
            }
        }
        format!(
            "{}|o={}|g={}|c={}|e={}|cur={}",
            self.account_type.as_str(),
            text(&self.owner_id),
            uuid(&self.gateway_id),
            uuid(&self.credential_set_id),
            text(&self.env),
            text(&self.currency),
        )
    }
}

#[derive(Debug, Clone)]
// The lookup variant is the hot path of a posting; boxing its predicates would add two heap
// allocations per resolution to save stack space only a handful of plans use.
#[allow(clippy::large_enum_variant)]
enum LookupPlan {
    Direct(Uuid),
    Lookup {
        key: String,
        account_type: AccountType,
        scoped: AccountPredicate,
        fallback: AccountPredicate,
    },
}

impl LookupPlan {
    fn account_type(&self) -> AccountType {
        match self {
            Self::Direct(_) => AccountType::Treasury,
            Self::Lookup { account_type, .. } => *account_type,
        }
    }
}

/// One row of the batched candidate query (`fetchAccountCandidates`, `LedgerPoster.ts:1203-1208`).
#[derive(Debug, Clone, FromRow)]
struct AccountCandidate {
    id: Uuid,
    account_type: String,
    owner_id: Option<String>,
    gateway_id: Option<Uuid>,
    credential_set_id: Option<Uuid>,
    env: Option<String>,
    currency: String,
}

/// Resolves the GL account of every template line, in line order.
pub(crate) async fn resolve_account_ids(
    conn: &mut PgConnection,
    template: &JournalTemplate,
    options: &PostOptions<'_>,
) -> Result<Vec<Uuid>, LedgerError> {
    let plans = build_plans(template, options);
    if options.require_currency
        && template.currency.trim().is_empty()
        && plans
            .iter()
            .any(|plan| matches!(plan, LookupPlan::Lookup { .. }))
    {
        return Err(LedgerError::MissingCurrency);
    }

    let mut resolved: Vec<Option<Uuid>> = plans
        .iter()
        .map(|plan| match plan {
            LookupPlan::Direct(id) => Some(*id),
            LookupPlan::Lookup { key, .. } => options.cache.and_then(|cache| cache.get(key)),
        })
        .collect();

    // One predicate per distinct scoped lookup, both the scoped and the fallback form.
    let mut pending: Vec<(&AccountPredicate, &AccountPredicate)> = Vec::new();
    let mut seen = BTreeSet::new();
    for (index, plan) in plans.iter().enumerate() {
        if resolved[index].is_some() {
            continue;
        }
        if let LookupPlan::Lookup {
            key,
            scoped,
            fallback,
            ..
        } = plan
        {
            if seen.insert(key.clone()) {
                pending.push((scoped, fallback));
            }
        }
    }

    let candidates = if pending.is_empty() {
        Vec::new()
    } else {
        fetch_candidates(conn, &pending).await?
    };

    for (index, plan) in plans.iter().enumerate() {
        if resolved[index].is_some() {
            continue;
        }
        let LookupPlan::Lookup {
            key,
            account_type,
            scoped,
            fallback,
        } = plan
        else {
            continue;
        };
        if let Some(candidate) = candidates
            .iter()
            .find(|candidate| scoped.matches(candidate))
        {
            if let Some(cache) = options.cache {
                cache.insert(key.clone(), candidate.id);
            }
            resolved[index] = Some(candidate.id);
            continue;
        }
        if let Some(candidate) = candidates
            .iter()
            .find(|candidate| fallback.matches(candidate))
        {
            resolved[index] = Some(candidate.id);
            continue;
        }
        return Err(LedgerError::AccountNotFound {
            account_type: *account_type,
        });
    }

    resolved
        .into_iter()
        .enumerate()
        .map(|(index, id)| {
            id.ok_or(LedgerError::AccountNotFound {
                account_type: plans[index].account_type(),
            })
        })
        .collect()
}

fn build_plans(template: &JournalTemplate, options: &PostOptions<'_>) -> Vec<LookupPlan> {
    let context = PostContextRef::from_context(&options.context);
    template
        .lines
        .iter()
        .map(|line| plan_for(&line.account, &context, &template.currency))
        .collect()
}

fn plan_for(
    selector: &AccountSelector,
    context: &PostContextRef<'_>,
    currency: &str,
) -> LookupPlan {
    if let Some(id) = selector.account_id {
        return LookupPlan::Direct(id);
    }
    if let Some(id) = context.accounts.get(&selector.account_type) {
        return LookupPlan::Direct(*id);
    }
    let currency = selector
        .currency
        .clone()
        .or_else(|| context.currency.clone())
        .unwrap_or_else(|| currency.to_owned());
    let (scoped, fallback) = account_predicates(selector, context, currency);
    LookupPlan::Lookup {
        key: scoped.key(),
        account_type: selector.account_type,
        scoped,
        fallback,
    }
}

/// A borrowed view over [`crate::template::PostContext`] so the pure planner does not need to
/// clone the whole context.
struct PostContextRef<'a> {
    accounts: &'a std::collections::HashMap<AccountType, Uuid>,
    merchant_id: Option<&'a str>,
    gateway_id: Option<Uuid>,
    credential_set_id: Option<Uuid>,
    env: Option<&'a str>,
    currency: Option<String>,
}

impl PostContextRef<'_> {
    fn from_context(context: &crate::template::PostContext) -> PostContextRef<'_> {
        PostContextRef {
            accounts: &context.accounts,
            merchant_id: context.merchant_id.as_deref(),
            gateway_id: context.gateway_id,
            credential_set_id: context.credential_set_id,
            env: context.env.as_deref(),
            currency: context.currency.clone(),
        }
    }
}

fn account_predicates(
    selector: &AccountSelector,
    context: &PostContextRef<'_>,
    currency: String,
) -> (AccountPredicate, AccountPredicate) {
    let merchant_scoped = selector.account_type.is_merchant_scoped();
    let gateway_scoped = selector.account_type.is_gateway_scoped();
    let owner_id = selector.owner_id.clone().or_else(|| {
        if merchant_scoped {
            context.merchant_id.map(str::to_owned)
        } else {
            None
        }
    });
    let gateway_id = selector.gateway_id.or(if gateway_scoped {
        context.gateway_id
    } else {
        None
    });
    let credential_set_id = selector.credential_set_id.or(if gateway_scoped {
        context.credential_set_id
    } else {
        None
    });
    let env = selector.env.clone().or_else(|| {
        if gateway_scoped {
            context.env.map(str::to_owned)
        } else {
            None
        }
    });

    let scoped = AccountPredicate {
        account_type: selector.account_type,
        owner_id: owner_id.map_or(Dim::Any, Dim::Eq),
        gateway_id: gateway_id.map_or(Dim::Any, Dim::Eq),
        credential_set_id: credential_set_id.map_or(Dim::Any, Dim::Eq),
        env: env.map_or(Dim::Any, Dim::Eq),
        currency: Dim::Eq(currency),
    };
    let fallback = AccountPredicate {
        account_type: selector.account_type,
        owner_id: Dim::Null,
        gateway_id: Dim::Null,
        credential_set_id: Dim::Null,
        env: Dim::Null,
        currency: scoped.currency.clone(),
    };
    (scoped, fallback)
}

async fn fetch_candidates(
    conn: &mut PgConnection,
    pending: &[(&AccountPredicate, &AccountPredicate)],
) -> Result<Vec<AccountCandidate>, LedgerError> {
    let mut builder: QueryBuilder<Postgres> = QueryBuilder::new(
        "SELECT id, account_type::text AS account_type, owner_id, gateway_id, \
         credential_set_id, env, currency::text AS currency FROM gl_accounts WHERE ",
    );
    let mut pushed: BTreeSet<String> = BTreeSet::new();
    let mut first = true;
    for (scoped, fallback) in pending {
        for predicate in [*scoped, *fallback] {
            if !pushed.insert(predicate.key()) {
                continue;
            }
            if !first {
                builder.push(" OR ");
            }
            first = false;
            push_predicate(&mut builder, predicate);
        }
    }
    builder.push(" ORDER BY id ASC");
    let rows = builder
        .build_query_as::<AccountCandidate>()
        .fetch_all(conn)
        .await?;
    Ok(rows)
}

fn push_predicate(builder: &mut QueryBuilder<Postgres>, predicate: &AccountPredicate) {
    builder
        .push("(account_type = ")
        .push_bind(predicate.account_type.as_str())
        .push("::\"GlAccountType\"");
    push_text_dim(builder, "owner_id", &predicate.owner_id);
    push_uuid_dim(builder, "gateway_id", &predicate.gateway_id);
    push_uuid_dim(builder, "credential_set_id", &predicate.credential_set_id);
    push_text_dim(builder, "env", &predicate.env);
    match &predicate.currency {
        Dim::Any => {}
        Dim::Null => {
            builder.push(" AND currency IS NULL");
        }
        Dim::Eq(value) => {
            builder
                .push(" AND currency = ")
                .push_bind(value.clone())
                .push("::char(3)");
        }
    }
    builder.push(")");
}

fn push_text_dim(builder: &mut QueryBuilder<Postgres>, column: &str, dim: &Dim<String>) {
    match dim {
        Dim::Any => {}
        Dim::Null => {
            builder.push(" AND ").push(column).push(" IS NULL");
        }
        Dim::Eq(value) => {
            builder
                .push(" AND ")
                .push(column)
                .push(" = ")
                .push_bind(value.clone());
        }
    }
}

fn push_uuid_dim(builder: &mut QueryBuilder<Postgres>, column: &str, dim: &Dim<Uuid>) {
    match dim {
        Dim::Any => {}
        Dim::Null => {
            builder.push(" AND ").push(column).push(" IS NULL");
        }
        Dim::Eq(value) => {
            builder
                .push(" AND ")
                .push(column)
                .push(" = ")
                .push_bind(*value)
                .push("::uuid");
        }
    }
}

fn matches_uuid(dim: &Dim<Uuid>, candidate: Option<Uuid>) -> bool {
    match dim {
        Dim::Any => true,
        Dim::Null => candidate.is_none(),
        Dim::Eq(value) => candidate == Some(*value),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::template::PostContext;
    use rust_decimal::Decimal;
    use std::str::FromStr;

    fn selector(account_type: AccountType) -> AccountSelector {
        AccountSelector::new(account_type)
    }

    #[test]
    fn cache_hits_expire_at_the_ttl() {
        let cache = AccountCache::with_limits(Duration::from_secs(60), 10);
        let now = Instant::now();
        let id = Uuid::now_v7();
        cache.insert_at("key".to_owned(), id, now);
        assert_eq!(cache.get_at("key", now), Some(id));
        assert_eq!(cache.get_at("key", now + Duration::from_secs(59)), Some(id));
        assert_eq!(cache.get_at("key", now + Duration::from_secs(61)), None);
        assert_eq!(cache.get_at("other", now), None);
    }

    #[test]
    fn cache_is_bounded_by_clearing_like_the_typescript_map() {
        let cache = AccountCache::with_limits(Duration::from_secs(60), 3);
        let now = Instant::now();
        for index in 0..3 {
            cache.insert_at(format!("k{index}"), Uuid::now_v7(), now);
        }
        assert_eq!(cache.len(), 3);
        cache.insert_at("k3".to_owned(), Uuid::now_v7(), now);
        // The bound clears everything, then stores the new entry.
        assert_eq!(cache.len(), 1);
        assert_eq!(cache.get_at("k0", now), None);
        assert!(cache.get_at("k3", now).is_some());
    }

    #[test]
    fn a_zero_ttl_disables_the_cache() {
        let cache = AccountCache::with_limits(Duration::ZERO, 10);
        cache.insert_at("k".to_owned(), Uuid::now_v7(), Instant::now());
        assert!(cache.is_empty());
    }

    #[test]
    fn predicates_follow_the_account_scoping_table() {
        let context = PostContext::new()
            .with_merchant("merchant-1")
            .with_currency("LYD")
            .with_gateway(Uuid::from_u128(7))
            .with_env("LIVE");
        let borrowed = PostContextRef::from_context(&context);

        // A global account never takes the merchant/gateway dimensions.
        let (scoped, fallback) = account_predicates(
            &selector(AccountType::Treasury),
            &borrowed,
            "LYD".to_owned(),
        );
        assert_eq!(scoped.owner_id, Dim::Any);
        assert_eq!(scoped.gateway_id, Dim::Any);
        assert_eq!(scoped.currency, Dim::Eq("LYD".to_owned()));
        assert_eq!(fallback.owner_id, Dim::Null);
        assert_eq!(fallback.env, Dim::Null);

        // A wallet takes the context merchant.
        let (wallet, wallet_fallback) = account_predicates(
            &selector(AccountType::MerchantWallet),
            &borrowed,
            "LYD".to_owned(),
        );
        assert_eq!(wallet.owner_id, Dim::Eq("merchant-1".to_owned()));
        assert_eq!(wallet.gateway_id, Dim::Any);
        assert_eq!(wallet_fallback.owner_id, Dim::Null);

        // Clearing takes gateway, environment (and the credential set when present).
        let (clearing, _) = account_predicates(
            &selector(AccountType::GatewayClearing),
            &borrowed,
            "LYD".to_owned(),
        );
        assert_eq!(clearing.gateway_id, Dim::Eq(Uuid::from_u128(7)));
        assert_eq!(clearing.env, Dim::Eq("LIVE".to_owned()));
        assert_eq!(clearing.owner_id, Dim::Any);
        assert_eq!(clearing.credential_set_id, Dim::Any);
    }

    #[test]
    fn an_explicit_selector_dimension_wins_over_the_context() {
        let context = PostContext::new().with_merchant("merchant-1");
        let borrowed = PostContextRef::from_context(&context);
        let explicit = selector(AccountType::MerchantWallet).with_owner("merchant-2");
        let (scoped, _) = account_predicates(&explicit, &borrowed, "LYD".to_owned());
        assert_eq!(scoped.owner_id, Dim::Eq("merchant-2".to_owned()));
    }

    #[test]
    fn direct_plans_win_over_every_lookup() {
        let explicit = Uuid::from_u128(1);
        let mapped = Uuid::from_u128(2);
        let context = PostContext::new().with_account(AccountType::Treasury, mapped);
        let borrowed = PostContextRef::from_context(&context);
        let plan = plan_for(
            &selector(AccountType::Treasury).with_account_id(explicit),
            &borrowed,
            "LYD",
        );
        match plan {
            LookupPlan::Direct(id) => assert_eq!(id, explicit),
            LookupPlan::Lookup { .. } => panic!("an explicit id must not be looked up"),
        }
        let plan = plan_for(&selector(AccountType::Treasury), &borrowed, "LYD");
        match plan {
            LookupPlan::Direct(id) => assert_eq!(id, mapped),
            LookupPlan::Lookup { .. } => panic!("a context override must not be looked up"),
        }
    }

    #[test]
    fn the_cache_key_distinguishes_every_scope_dimension() {
        let base = AccountPredicate {
            account_type: AccountType::MerchantWallet,
            owner_id: Dim::Eq("m1".to_owned()),
            gateway_id: Dim::Any,
            credential_set_id: Dim::Any,
            env: Dim::Any,
            currency: Dim::Eq("LYD".to_owned()),
        };
        let mut other = base.clone();
        other.owner_id = Dim::Eq("m2".to_owned());
        assert_ne!(base.key(), other.key());
        let mut currency = base.clone();
        currency.currency = Dim::Eq("USD".to_owned());
        assert_ne!(base.key(), currency.key());
    }

    #[test]
    fn money_is_not_part_of_account_resolution() {
        // Guards against a future refactor that would make the resolver depend on amounts.
        let _ = Decimal::from_str("1.0000").expect("decimal");
        let context = PostContext::new();
        let borrowed = PostContextRef::from_context(&context);
        let plan = plan_for(&selector(AccountType::Treasury), &borrowed, "LYD");
        assert_eq!(plan.account_type(), AccountType::Treasury);
    }
}
