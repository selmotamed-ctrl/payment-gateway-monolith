//! Pure renderers for every storage configuration file, unit and SQL script.
//!
//! Ports: `postgresConfigSnippet`, `postgresMainConfigSnippet`, `pgHbaSnippet`,
//! `primaryBootstrapSql`, `replicaCommands` (`deploy/provisioners/postgres18Provisioner.ts`);
//! `pgbouncerIni`/`pgbouncerUserlist`; `redisConfigSnippet` (`redisProvisioner.ts`);
//! `AUDIT_DB_BASE`/`LOG_DB_BASE`/`auditRuntimeGrants` (`auditAndLogDbProvisioner.ts`); and
//! `clamdConfig` (`clamavProvisioner.ts`). Differences are recorded in `DEVIATIONS.md` (DEV-029
//! onwards): internal-CA TLS instead of self-signed certificates, SCRAM verifiers instead of a
//! plaintext PgBouncer userlist, one pgctl-owned Redis config path, and secrets as
//! `{{secret:<name>}}` placeholders resolved at apply time.

#![forbid(unsafe_code)]

use super::settings::{
    ClamavSettings, PgbouncerSettings, PostgresSettings, RedisEngine, RedisSettings,
};

/// Header every managed file carries (chapter 7 §9).
#[must_use]
pub fn managed_header(component: &str) -> String {
    format!(
        "# managed by pgctl {}, do not edit\n# component: {component}\n",
        super::GENERATOR_VERSION
    )
}

/// SQL identifier quoting (`"name"`).
#[must_use]
pub fn sql_ident(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

/// SQL string literal quoting (`'value'`).
#[must_use]
pub fn sql_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// PgBouncer/libpq `[databases]` value: single-quoted with `\` and `'` escaped.
#[must_use]
pub fn conn_value(value: &str) -> String {
    let escaped = value.replace('\\', "\\\\").replace('\'', "\\'");
    format!("'{escaped}'")
}

/// Shell single-quote.
#[must_use]
pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Strip the `secret:` prefix of a credential reference (the name the executor resolves).
#[must_use]
pub fn secret_name(reference: &Option<String>) -> Option<String> {
    reference
        .as_deref()
        .and_then(|value| value.strip_prefix("secret:"))
        .map(str::to_owned)
}

/// `{{secret:name}}` placeholder for rendered files.
#[must_use]
pub fn secret_placeholder(name: &str) -> String {
    format!("{{{{secret:{name}}}}}")
}

/// The PostgreSQL tuning block (port of `postgresConfigSnippet`, plus S-DB-05/S-DB-12).
#[allow(clippy::too_many_arguments)]
#[must_use]
pub fn postgres_conf(
    settings: &PostgresSettings,
    listen_addresses: &str,
    data_directory: &str,
    hba_file: &str,
    port: u16,
    tls_dir: &str,
    sync_standbys: &[String],
    replica: bool,
) -> String {
    let memory = settings.memory();
    let io_method = settings.io_method.rendered();
    let wal_compression = if settings.wal_compression {
        "lz4"
    } else {
        "off"
    };
    let mut text = managed_header("postgresql");
    text.push_str(&format!(
        "data_directory = '{data_directory}'\nhba_file = '{hba_file}'\nport = {port}\nlisten_addresses = '{listen_addresses}'\n"
    ));
    text.push_str(&format!(
        "max_connections = {}\nshared_buffers = {}\neffective_cache_size = {}\nwork_mem = {}MB\nmaintenance_work_mem = {}\n",
        settings.max_connections,
        memory.shared_buffers,
        memory.effective_cache_size,
        settings.work_mem_mb,
        memory.maintenance_work_mem
    ));
    text.push_str(&format!(
        "io_method = '{io_method}'\nsynchronous_commit = {}\nwal_level = replica\nwal_compression = {wal_compression}\n",
        settings.synchronous_commit.as_str()
    ));
    text.push_str(&format!(
        "max_wal_senders = {}\nmax_replication_slots = {}\nmax_slot_wal_keep_size = '{}'\nmax_wal_size = 16GB\nmin_wal_size = 2GB\ncheckpoint_completion_target = 0.9\nrandom_page_cost = 1.1\n",
        settings.max_wal_senders, settings.max_replication_slots, settings.max_slot_wal_keep_size
    ));
    if settings.pg_stat_statements {
        text.push_str("shared_preload_libraries = 'pg_stat_statements'\n");
    }
    text.push_str(&format!(
        "track_io_timing = on\ntrack_activity_query_size = 4096\nidle_in_transaction_session_timeout = '60s'\nlog_min_duration_statement = {}\nlog_lock_waits = on\ntimezone = 'UTC'\nlog_timezone = 'UTC'\n",
        settings.log_min_duration_ms
    ));
    if replica && settings.hot_standby_feedback {
        text.push_str("hot_standby_feedback = on\n");
    }
    if !sync_standbys.is_empty() {
        text.push_str(&format!(
            "synchronous_standby_names = 'ANY 1 ({})'\n",
            sync_standbys.join(",")
        ));
    }
    text.push_str(&format!(
        "ssl = on\nssl_cert_file = '{tls_dir}/server.crt'\nssl_key_file = '{tls_dir}/server.key'\nssl_ca_file = '{tls_dir}/ca.crt'\nssl_crl_file = '{tls_dir}/crl.pem'\nssl_min_protocol_version = 'TLSv1.2'\npassword_encryption = 'scram-sha-256'\n"
    ));
    text
}

/// `pg_hba.conf`: TLS-only application and replication rules (port of `pgHbaSnippet`, S-DB-12).
///
/// `app_sources` and `replication_sources` are IPv4/IPv6 literals; the planner validates them
/// before rendering. There is deliberately no plain `host` rule.
#[must_use]
pub fn pg_hba(
    settings: &PostgresSettings,
    app_sources: &[String],
    replication_sources: &[String],
) -> String {
    let client_cert = settings.client_cert.hba_suffix();
    let mut lines = vec![
        "# managed by pgctl, do not edit".to_owned(),
        "# hostssl only: plaintext TCP is never allowed (S-SEC-06)".to_owned(),
        "local   all             all                                     peer".to_owned(),
    ];
    for address in ["127.0.0.1", "::1"] {
        let mask = if address.contains(':') { "128" } else { "32" };
        lines.push(format!(
            "hostssl all             all             {address}/{mask}            scram-sha-256{client_cert}"
        ));
    }
    for source in app_sources {
        let mask = if source.contains(':') { "128" } else { "32" };
        lines.push(format!(
            "hostssl all             all             {source}/{mask}            scram-sha-256{client_cert}"
        ));
    }
    let replication_role = &settings.roles.replication;
    for source in replication_sources {
        let mask = if source.contains(':') { "128" } else { "32" };
        lines.push(format!(
            "hostssl replication     {replication_role}             {source}/{mask}            scram-sha-256"
        ));
    }
    lines.push(String::new());
    lines.join("\n")
}

/// Role and database SQL.
///
/// Passwords are psql variables (`:'name'`), fed by the executor from the credential store: no
/// literal password can reach the plan, a log or `ps`. Port of `primaryBootstrapSql` with the
/// same idempotent `CREATE ... WHERE NOT EXISTS ... \gexec` pattern.
#[must_use]
pub fn postgres_bootstrap_sql(
    settings: &PostgresSettings,
    replicas: &[(String, String)],
) -> (String, Vec<String>) {
    let roles = &settings.roles;
    let mut secrets = Vec::new();
    let mut sql = String::from(
        "\\set ON_ERROR_STOP on\n-- managed by pgctl; passwords are psql variables, never literals\n",
    );
    if let Some(name) = secret_name(&settings.owner_password) {
        sql.push_str(&create_login_role_sql(&roles.owner, &name));
        secrets.push(name);
    }
    if let Some(name) = secret_name(&settings.app_password) {
        sql.push_str(&format!(
            "-- runtime group (DML only; created by the append-only migration too)\nSELECT 'CREATE ROLE {} NOLOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = {})\\gexec\n",
            sql_ident(&roles.app_group),
            sql_literal(&roles.app_group)
        ));
        sql.push_str(&create_login_role_sql(&roles.app, &name));
        sql.push_str(&format!(
            "ALTER ROLE {} NOSUPERUSER NOCREATEDB NOCREATEROLE;\nGRANT {} TO {};\nALTER ROLE {} SET statement_timeout = '30s';\nALTER ROLE {} SET idle_in_transaction_session_timeout = '60s';\n",
            sql_ident(&roles.app),
            sql_ident(&roles.app_group),
            sql_ident(&roles.app),
            sql_ident(&roles.app),
            sql_ident(&roles.app)
        ));
        secrets.push(name);
    }
    sql.push_str(&format!(
        "SELECT format('CREATE DATABASE %I OWNER %I', {}, {}) WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = {})\\gexec\n",
        sql_literal(&settings.database),
        sql_literal(&roles.owner),
        sql_literal(&settings.database)
    ));
    if let Some(sandbox) = &settings.sandbox_database {
        sql.push_str(&format!(
            "SELECT format('CREATE DATABASE %I OWNER %I', {}, {}) WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = {})\\gexec\n",
            sql_literal(sandbox),
            sql_literal(&roles.owner),
            sql_literal(sandbox)
        ));
    }
    if let Some(name) = secret_name(&settings.replication_password) {
        sql.push_str(&create_replication_role_sql(&roles.replication, &name));
        secrets.push(name);
    }
    for (slot, _) in replicas {
        sql.push_str(&format!(
            "SELECT pg_create_physical_replication_slot({}) WHERE NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = {});\n",
            sql_literal(slot),
            sql_literal(slot)
        ));
    }
    sql.push_str(&ownership_reconcile_sql(settings));
    (sql, secrets)
}

fn create_login_role_sql(role: &str, password_variable: &str) -> String {
    format!(
        "SELECT format('CREATE ROLE %I LOGIN', {}) WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = {})\\gexec\nALTER ROLE {} WITH LOGIN PASSWORD :'{password_variable}';\n",
        sql_literal(role),
        sql_literal(role),
        sql_ident(role)
    )
}

fn create_replication_role_sql(role: &str, password_variable: &str) -> String {
    format!(
        "SELECT format('CREATE ROLE %I REPLICATION LOGIN', {}) WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = {})\\gexec\nALTER ROLE {} WITH REPLICATION LOGIN PASSWORD :'{password_variable}';\n",
        sql_literal(role),
        sql_literal(role),
        sql_ident(role)
    )
}

/// Hand a database created by an earlier deploy under another role to the configured owner
/// (port of `ownershipReconcileSql`).
#[must_use]
pub fn ownership_reconcile_sql(settings: &PostgresSettings) -> String {
    let owner = &settings.roles.owner;
    let body = format!(
        "DECLARE r record; BEGIN FOR r IN SELECT DISTINCT o.rolname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_roles o ON o.oid = c.relowner WHERE n.nspname = 'public' AND NOT o.rolsuper AND o.rolname <> {} LOOP EXECUTE format('REASSIGN OWNED BY %I TO %I', r.rolname, {}); END LOOP; END",
        sql_literal(owner),
        sql_literal(owner)
    );
    format!(
        "ALTER DATABASE {} OWNER TO {};\n\\connect {}\nDO $$ {body} $$;\n",
        sql_ident(&settings.database),
        sql_ident(owner),
        sql_ident(&settings.database)
    )
}

/// The replica `~postgres/.pgpass` line, with a `{{secret:...}}` placeholder (written over stdin,
/// mode 0600; never in argv, GAP-028).
#[must_use]
pub fn replica_pgpass(
    settings: &PostgresSettings,
    primary: &str,
    port: u16,
) -> (String, Vec<String>) {
    let role = &settings.roles.replication;
    let mut secrets = Vec::new();
    let password = secret_name(&settings.replication_password).map_or_else(
        || "{{secret:pg_replication_password}}".to_owned(),
        |name| {
            let placeholder = secret_placeholder(&name);
            secrets.push(name);
            placeholder
        },
    );
    (format!("{primary}:{port}:*:{role}:{password}\n"), secrets)
}

/// Paths of one replica cluster.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReplicaDirs<'a> {
    /// Cluster name (`replica_db_2`).
    pub cluster: &'a str,
    /// Data directory.
    pub data_dir: &'a str,
    /// Configuration directory (`/etc/postgresql/18/<cluster>`).
    pub config_dir: &'a str,
    /// Internal-CA material directory.
    pub tls_dir: &'a str,
}

/// `pg_basebackup -R` for one replica (port of `replicaCommands`).
///
/// The replication password is read from `~postgres/.pgpass`, which the previous step writes from
/// the credential store; it is never interpolated into this script or into `argv`.
#[must_use]
pub fn replica_basebackup_script(
    settings: &PostgresSettings,
    primary: &str,
    port: u16,
    slot: &str,
    dirs: &ReplicaDirs<'_>,
) -> String {
    let cluster = dirs.cluster;
    let data = shell_quote(dirs.data_dir);
    let config = shell_quote(dirs.config_dir);
    let tls_dir = shell_quote(dirs.tls_dir);
    let pgpass = "/var/lib/postgresql/.pgpass";
    let guard = if settings.replica_rebuild { "0" } else { "1" };
    let primary = shell_quote(primary);
    let replication_role = shell_quote(&settings.roles.replication);
    format!(
        "set -eu
install -d -m 0700 -o postgres -g postgres /var/lib/postgresql
test -s {pgpass} && chown postgres:postgres {pgpass} && chmod 0600 {pgpass}
if [ -s {data}/PG_VERSION ] && [ -f {data}/standby.signal ] && [ {guard} -eq 1 ]; then
  echo 'replica {slot} already initialised; skipping rebuild (set storage.postgres.replica_rebuild = true to re-clone)'
  systemctl start postgresql@18-{cluster} 2>/dev/null || true
  exit 0
fi
systemctl stop postgresql@18-{cluster} 2>/dev/null || true
rm -rf {data}/*
runuser -u postgres -- env PGPASSFILE={pgpass} PGSSLMODE=verify-full PGSSLROOTCERT={tls_dir}/ca.crt pg_basebackup -h {primary} -p {port} -U {replication_role} -D {data} -Fp -Xs -P -R -S {slot}
rm -f {data}/postgresql.conf {data}/pg_hba.conf
ln -sfn {config}/postgresql.conf {data}/postgresql.conf
ln -sfn {config}/pg_hba.conf {data}/pg_hba.conf
touch {data}/postgresql.auto.conf
# synchronous_standby_names matches application_name, not the slot name: rewrite the
# pg_basebackup-generated conninfo with both, so a synchronous commit can be acknowledged.
sed -i \"/^primary_conninfo[[:space:]]*=/d\" {data}/postgresql.auto.conf
printf \"primary_conninfo = 'host=%s port=%s user=%s passfile=%s sslmode=verify-full sslrootcert=%s application_name=%s'\\n\" {primary} {port} {replication_role} {pgpass} {tls_dir}/ca.crt {slot} >> {data}/postgresql.auto.conf
if grep -q '^primary_slot_name' {data}/postgresql.auto.conf; then sed -i \"s|^primary_slot_name = .*|primary_slot_name = '{slot}'|\" {data}/postgresql.auto.conf; else printf \"primary_slot_name = '%s'\\n\" {slot} >> {data}/postgresql.auto.conf; fi
chown -R postgres:postgres {data}
systemctl start postgresql@18-{cluster}
systemctl enable postgresql@18-{cluster}"
    )
}

/// The PgBouncer `pgbouncer.ini` (port of `pgbouncerIni`, S-DB-11).
#[must_use]
pub fn pgbouncer_ini(
    settings: &PostgresSettings,
    pgbouncer: &PgbouncerSettings,
    database: &str,
    postgres_port: u16,
    listen_addr: &str,
    tls_dir: &str,
) -> String {
    let session_pool = pgbouncer.session_pool_size();
    let mut text = String::from("[databases]\n");
    text.push_str(&format!(
        "{database} = host=127.0.0.1 port={} dbname={}\n",
        postgres_port,
        conn_value(database)
    ));
    text.push_str(&format!(
        "{} = host=127.0.0.1 port={postgres_port} dbname={} pool_mode=session pool_size={session_pool}\n",
        pgbouncer.session_alias,
        conn_value(database)
    ));
    if let Some(sandbox) = &settings.sandbox_database {
        text.push_str(&format!(
            "pgw_sandbox = host=127.0.0.1 port={} dbname={}\npgw_sandbox_session = host=127.0.0.1 port={} dbname={} pool_mode=session pool_size={session_pool}\n",
            postgres_port,
            conn_value(sandbox),
            postgres_port,
            conn_value(sandbox)
        ));
    }
    text.push_str(&format!(
        "\n[pgbouncer]\nlisten_addr = {listen_addr}\nlisten_port = {}\npool_mode = transaction\nserver_tls_sslmode = {}\nserver_tls_ca_file = {tls_dir}/ca.crt\nserver_tls_key_file = {tls_dir}/server.key\nserver_tls_cert_file = {tls_dir}/server.crt\nclient_tls_sslmode = {}\nclient_tls_ca_file = {tls_dir}/ca.crt\nclient_tls_key_file = {tls_dir}/server.key\nclient_tls_cert_file = {tls_dir}/server.crt\nmax_client_conn = {}\ndefault_pool_size = {}\nreserve_pool_size = {}\nreserve_pool_timeout = 5\nserver_lifetime = {}\nserver_idle_timeout = {}\nmax_prepared_statements = {}\nserver_reset_query_always = 0\nignore_startup_parameters = extra_float_digits,search_path\nauth_type = scram-sha-256\nauth_file = /etc/pgbouncer/userlist.txt\n",
        pgbouncer.port,
        pgbouncer.server_tls.as_str(),
        pgbouncer.client_tls.as_str(),
        pgbouncer.max_client_conn,
        pgbouncer.default_pool_size,
        pgbouncer.reserve_pool_size,
        pgbouncer.server_lifetime,
        pgbouncer.server_idle_timeout,
        pgbouncer.max_prepared_statements
    ));
    text
}

/// PgBouncer auth file: SCRAM verifiers generated from the secret store at apply time.
///
/// A plaintext userlist is never written. PgBouncer accepts `"user" "SCRAM-SHA-256$..."`.
#[must_use]
pub fn pgbouncer_userlist(settings: &PostgresSettings) -> (String, Vec<String>) {
    let mut lines =
        vec!["# managed by pgctl: SCRAM-SHA-256 verifiers, resolved at apply time".to_owned()];
    let mut secrets = Vec::new();
    if let Some(name) = secret_name(&settings.owner_password) {
        lines.push(format!(
            "\"{}\" \"{{{{scram:{name}}}}}\"",
            settings.roles.owner
        ));
        secrets.push(name);
    }
    if let Some(name) = secret_name(&settings.app_password) {
        lines.push(format!(
            "\"{}\" \"{{{{scram:{name}}}}}\"",
            settings.roles.app
        ));
        secrets.push(name);
    }
    (lines.join("\n") + "\n", secrets)
}

/// The pgctl-owned PgBouncer unit (overrides the packaged one, chapter 7 §9/§10).
#[must_use]
pub fn pgbouncer_unit() -> String {
    format!(
        "{}[Unit]\nDescription=PgBouncer connection pooler (pgctl-managed)\nDocumentation=man:pgbouncer(1)\nAfter=network-online.target postgresql.service\nWants=network-online.target\n\n[Service]\nType=notify\nUser=postgres\nGroup=postgres\nExecStart=/usr/bin/env pgbouncer /etc/pgbouncer/pgbouncer.ini\nExecReload=/bin/kill -HUP $MAINPID\nKillSignal=SIGINT\nTimeoutStopSec=15s\nRestart=on-failure\nRestartSec=2\nLimitNOFILE=65536\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nProtectHome=true\nReadWritePaths=/var/log/pgbouncer /var/run/postgresql\n\n[Install]\nWantedBy=multi-user.target\n",
        managed_header("pgbouncer")
    )
}

/// Resolve the packaged unit user and converge config ownership.
#[must_use]
pub fn pgbouncer_ownership_script() -> String {
    "set -eu
pgbouncer_owner=\"$(systemctl show -p User --value pgbouncer 2>/dev/null || true)\"
[ -n \"$pgbouncer_owner\" ] || pgbouncer_owner=postgres
id \"$pgbouncer_owner\" >/dev/null 2>&1 || pgbouncer_owner=postgres
install -d -m 0750 /etc/pgbouncer
chown \"$pgbouncer_owner:\" /etc/pgbouncer/pgbouncer.ini /etc/pgbouncer/userlist.txt
chmod 0640 /etc/pgbouncer/pgbouncer.ini
chmod 0600 /etc/pgbouncer/userlist.txt
install -d -m 0750 /etc/pgbouncer/tls
chown -R \"$pgbouncer_owner:\" /etc/pgbouncer/tls
chmod 0600 /etc/pgbouncer/tls/server.key
chmod 0644 /etc/pgbouncer/tls/server.crt /etc/pgbouncer/tls/ca.crt /etc/pgbouncer/tls/crl.pem"
        .to_owned()
}

/// PgBouncer convergence: start if down, restart only for restart-only settings, reload otherwise.
#[must_use]
pub fn pgbouncer_apply_script(
    port: u16,
    changed: bool,
    force: bool,
    upstream_bounced: bool,
) -> String {
    let changed = u8::from(changed);
    let force = u8::from(force);
    let upstream = u8::from(upstream_bounced);
    format!(
        "set -u
if ! systemctl is-active --quiet pgbouncer; then
  systemctl enable pgbouncer >/dev/null 2>&1 || true
  systemctl start pgbouncer
  echo __PG_APPLY__=started
elif [ {force} = 1 ] || [ {upstream} = 1 ] || [ {changed} = 1 ]; then
  systemctl restart pgbouncer
  echo __PG_APPLY__=restarted
else
  echo __PG_APPLY__=unchanged
fi
for i in $(seq 1 30); do pg_isready -h 127.0.0.1 -p {port} >/dev/null 2>&1 && exit 0; sleep 1; done
echo 'PgBouncer did not become ready within 30s' >&2; exit 1"
    )
}

/// Prove a login through the pooler (port of `poolerLoginScript`, password on a private file).
#[must_use]
pub fn pooler_login_script(
    port: u16,
    database: &str,
    user: &str,
    password: &str,
) -> (String, Vec<String>) {
    let placeholder = secret_placeholder(password);
    let client_dir = "/etc/pg/credentials/pg-client";
    let script = format!(
        "set -eu
d=$(mktemp -d) && trap 'rm -rf \"$d\"' EXIT
printf '%s\\n' \"127.0.0.1:{port}:{database}:{user}:{placeholder}\" > \"$d/pgpass\"
chmod 600 \"$d/pgpass\"
ssl_env='PGSSLMODE=require'
if [ -s {client_dir}/{user}.crt ] && [ -s {client_dir}/{user}.key ]; then
  ssl_env=\"PGSSLMODE=verify-ca PGSSLROOTCERT=/etc/pgbouncer/tls/ca.crt PGSSLCERT={client_dir}/{user}.crt PGSSLKEY={client_dir}/{user}.key\"
fi
for i in $(seq 1 45); do
  if env PGPASSFILE=\"$d/pgpass\" $ssl_env psql --no-password -h 127.0.0.1 -p {port} -U {user} -d {database} -tAc 'SELECT 1' >/dev/null 2>\"$d/err\"; then exit 0; fi
  sleep 1
done
echo 'PgBouncer did not accept a login within 45s (client certificate required by client_tls_sslmode=verify-full; issue it with pgctl pki, D4-T02):' >&2
cat \"$d/err\" >&2; exit 1",
    );
    (script, vec![password.to_owned()])
}

/// Redis/Valkey configuration (port of `redisConfigSnippet`, S-SEC-06).
#[must_use]
pub fn redis_conf(
    settings: &RedisSettings,
    private_ip: &str,
    tls_dir: &str,
    acl_path: &str,
) -> String {
    let mut binds = vec![private_ip.to_owned(), "127.0.0.1".to_owned()];
    binds.dedup();
    let bind = binds.join(" ");
    let mut text = managed_header("redis");
    text.push_str(&format!("bind {bind}\nprotected-mode yes\n"));
    if settings.tls {
        text.push_str(&format!(
            "port 0\ntls-port {}\ntls-cert-file {tls_dir}/server.crt\ntls-key-file {tls_dir}/server.key\ntls-ca-cert-file {tls_dir}/ca.crt\ntls-auth-clients yes\ntls-protocols \"TLSv1.2 TLSv1.3\"\ntls-replication yes\n",
            settings.port
        ));
    } else {
        text.push_str(&format!("port {}\n", settings.port));
    }
    text.push_str(&format!(
        "save 3600 1\nmaxmemory {}\nmaxmemory-policy {}\nappendonly {}\nappendfsync {}\ndaemonize no\nsupervised systemd\ndir {}\n",
        settings.maxmemory,
        settings.maxmemory_policy,
        if settings.appendonly { "yes" } else { "no" },
        settings.appendfsync,
        settings.data_dir
    ));
    if settings.acl {
        text.push_str(&format!("aclfile {acl_path}\n"));
    } else if let Some(name) = secret_name(&settings.password) {
        text.push_str(&format!("requirepass {}\n", secret_placeholder(&name)));
    }
    text
}

/// Redis ACL file with three least-privilege users.
#[must_use]
pub fn redis_acl(settings: &RedisSettings) -> (String, Vec<String>) {
    let mut lines = vec![
        "# managed by pgctl: ACL users, passwords resolved at apply time".to_owned(),
        "user default off".to_owned(),
    ];
    let mut secrets = Vec::new();
    let user = |name: &str,
                reference: &Option<String>,
                commands: &str,
                lines: &mut Vec<String>,
                secrets: &mut Vec<String>| {
        let secret = secret_name(reference).unwrap_or_else(|| format!("redis_{name}_password"));
        lines.push(format!(
            "user {name} on >{{{{secret:{secret}}}}} ~* &* {commands}"
        ));
        secrets.push(secret);
    };
    user(
        "core",
        &settings.core_password,
        "+@all -@admin -@dangerous",
        &mut lines,
        &mut secrets,
    );
    user(
        "worker",
        &settings.worker_password,
        "+@all -@admin -@dangerous",
        &mut lines,
        &mut secrets,
    );
    user(
        "backup",
        &settings.backup_password,
        "+@read +@connection +@keyspace -@write -@admin -@dangerous",
        &mut lines,
        &mut secrets,
    );
    (lines.join("\n") + "\n", secrets)
}

/// The Redis unit drop-in: one config path, one state directory, systemd supervision.
#[must_use]
pub fn redis_dropin(engine: RedisEngine) -> String {
    let binary = match engine {
        RedisEngine::Redis => "/usr/bin/redis-server",
        RedisEngine::Valkey => "/usr/bin/valkey-server",
    };
    format!(
        "[Service]\nReadWritePaths=/var/lib/pg-redis\nExecStart=\nExecStart={binary} /etc/pg-redis/redis.conf\n",
    )
}

/// Redis convergence: restart only when the configuration changed; verify with TLS PING.
#[allow(clippy::too_many_arguments)]
#[must_use]
pub fn redis_apply_script(
    unit_hint: &str,
    port: u16,
    tls: bool,
    acl: bool,
    auth_user: &str,
    tls_dir: &str,
    changed: bool,
    force: bool,
) -> String {
    let changed = u8::from(changed);
    let force = u8::from(force);
    let hint_line = if unit_hint.is_empty() {
        String::new()
    } else {
        format!("unit={unit_hint}\n")
    };
    let detect = "for u in redis-server redis valkey; do for d in /etc/systemd/system /usr/lib/systemd/system /lib/systemd/system; do if [ -f \"$d/$u.service\" ] && [ ! -L \"$d/$u.service\" ]; then echo \"$u\"; exit 0; fi; done; done; echo redis-server";
    let tls_args = if tls {
        format!("--tls --cacert {tls_dir}/ca.crt")
    } else {
        String::new()
    };
    let user_args = if acl {
        format!("--user {auth_user}")
    } else {
        String::new()
    };
    let auth = "\"${REDISCLI_AUTH:?REDISCLI_AUTH must be set by the executor}\"";
    format!(
        "set -u
unit=\"$({detect})\"
{hint_line}systemctl daemon-reload
if ! systemctl is-active --quiet \"$unit\"; then
  systemctl enable \"$unit\" >/dev/null 2>&1 || true
  systemctl start \"$unit\"
  echo __PG_APPLY__=started
elif [ {force} = 1 ] || [ {changed} = 1 ]; then
  REDISCLI_AUTH={auth} redis-cli {tls_args} {user_args} -p {port} CONFIG SET save \"\" >/dev/null 2>&1 || true
  systemctl restart \"$unit\"
  echo __PG_APPLY__=restarted
else
  echo __PG_APPLY__=unchanged
fi
for i in $(seq 1 30); do REDISCLI_AUTH={auth} redis-cli {tls_args} {user_args} -p {port} PING 2>/dev/null | grep -qx PONG && exit 0; sleep 1; done
echo 'Redis did not answer PING within 30s' >&2; exit 1"
    )
}

/// `redis-cli` allowlist for the Redis listener (port of `redisFirewallCommands`).
#[must_use]
pub fn redis_firewall_script(sources: &[String], port: u16) -> String {
    let mut lines = vec!["set -u".to_owned()];
    for source in sources {
        lines.push(format!(
            "command -v ufw >/dev/null 2>&1 && ufw allow from {source} to any port {port} proto tcp comment 'redis from core/backup' || true"
        ));
    }
    lines.join("\n")
}

/// Sentinel configuration for one instance (TLS-aware).
#[must_use]
pub fn sentinel_conf(
    settings: &RedisSettings,
    bind_ip: &str,
    redis_host: &str,
    tls_dir: &str,
    sentinel_port: u16,
    monitor_name: &str,
) -> String {
    let auth_user = if settings.acl { "core" } else { "default" };
    let auth_secret = if settings.acl {
        secret_name(&settings.core_password).unwrap_or_else(|| "redis_core_password".to_owned())
    } else {
        secret_name(&settings.password).unwrap_or_else(|| "redis_password".to_owned())
    };
    let mut text = managed_header("sentinel");
    let bind = if bind_ip == "127.0.0.1" {
        "127.0.0.1".to_owned()
    } else {
        format!("{bind_ip} 127.0.0.1")
    };
    text.push_str(&format!(
        "bind {bind}\nprotected-mode yes\ndaemonize no\nsupervised systemd\ndir /var/lib/pg-redis\n"
    ));
    if settings.tls {
        text.push_str(&format!(
            "port 0\ntls-port {sentinel_port}\ntls-cert-file {tls_dir}/server.crt\ntls-key-file {tls_dir}/server.key\ntls-ca-cert-file {tls_dir}/ca.crt\ntls-auth-clients yes\ntls-replication yes\n"
        ));
    } else {
        text.push_str(&format!("port {sentinel_port}\n"));
    }
    text.push_str(&format!(
        "sentinel monitor {monitor_name} {redis_host} {} {}\nsentinel auth-user {monitor_name} {auth_user}\nsentinel auth-pass {monitor_name} {}\nsentinel down-after-milliseconds {monitor_name} 5000\nsentinel failover-timeout {monitor_name} 60000\nsentinel parallel-syncs {monitor_name} 1\n",
        settings.port,
        settings.sentinel_quorum,
        secret_placeholder(&auth_secret)
    ));
    text
}

/// Sentinel unit (`redis-server <conf> --sentinel`).
#[must_use]
pub fn sentinel_unit(engine: RedisEngine, instance: u8) -> String {
    let binary = match engine {
        RedisEngine::Redis => "/usr/bin/redis-server",
        RedisEngine::Valkey => "/usr/bin/valkey-server",
    };
    format!(
        "[Unit]\nDescription=pgctl Redis Sentinel {instance}\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=notify\nExecStart={binary} /etc/pg-redis/sentinel-{instance}.conf --sentinel\nRestart=on-failure\nRestartSec=2\nLimitNOFILE=65536\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nProtectHome=true\nReadWritePaths=/var/lib/pg-redis\n\n[Install]\nWantedBy=multi-user.target\n"
    )
}

/// `clamd.conf` (port of `clamdConfig`): loopback TCP only, at least the 25 MB upload limit.
#[must_use]
pub fn clamd_conf(settings: &ClamavSettings) -> String {
    format!(
        "# managed by pgctl for the KYB document scanner (AUTO-06). Do not edit.\nLogSyslog true\nLogTime true\nLogFacility LOG_LOCAL6\nPidFile /run/clamav/clamd.pid\nDatabaseDirectory /var/lib/clamav\nLocalSocket /run/clamav/clamd.ctl\nLocalSocketMode 660\nFixStaleSocket true\nTCPSocket {}\nTCPAddr 127.0.0.1\nUser clamav\nMaxThreads {}\nMaxQueue 100\nReadTimeout 60\nCommandReadTimeout 30\nSendBufTimeout 200\nStreamMaxLength {}M\nMaxFileSize {}M\nMaxScanSize 128M\nMaxRecursion 16\nMaxFiles 10000\nScanPE yes\nScanELF yes\nScanOLE2 yes\nScanPDF yes\nScanArchive yes\nAlertEncrypted no\nDetectPUA no\n",
        settings.tcp_port, settings.max_threads, settings.stream_max_mb, settings.stream_max_mb
    )
}

/// `clamd` convergence (port of `clamdApplyScript`).
#[must_use]
pub fn clamd_apply_script(changed: bool, port: u16) -> String {
    let changed = u8::from(changed);
    let ready = format!(
        r#"bash -c 'exec 3<>/dev/tcp/127.0.0.1/{port} && printf "zPING\0" >&3 && read -r -t 5 -d "" reply <&3 && [ "$reply" = PONG ]'"#
    );
    format!(
        r#"set -u
has_db() {{ ls /var/lib/clamav/main.c?d >/dev/null 2>&1 || ls /var/lib/clamav/daily.c?d >/dev/null 2>&1; }}
if ! has_db; then
  systemctl stop clamav-freshclam >/dev/null 2>&1 || true
  freshclam --quiet >/dev/null 2>&1 || true
fi
systemctl enable --now clamav-freshclam >/dev/null 2>&1 || true
if ! has_db; then
  echo __PG_CLAMD__=no-database
  exit 0
fi
systemctl disable --now clamav-daemon.socket >/dev/null 2>&1 || true
if ! systemctl is-active --quiet clamav-daemon; then
  systemctl enable clamav-daemon >/dev/null 2>&1 || true
  systemctl start clamav-daemon
  echo __PG_CLAMD__=started
elif [ {changed} = 1 ]; then
  systemctl restart clamav-daemon
  echo __PG_CLAMD__=restarted
else
  echo __PG_CLAMD__=unchanged
fi
for i in $(seq 1 240); do {ready} >/dev/null 2>&1 && exit 0; sleep 1; done
echo 'clamd did not answer PING within 240s' >&2; exit 1"#
    )
}

/// Base audit DDL (verbatim port of `AUDIT_DB_BASE`).
#[must_use]
pub fn audit_ddl(writer: &str) -> String {
    format!("{}\n{}", AUDIT_DB_BASE, audit_runtime_grants(writer))
}

/// Base log DDL (verbatim port of `LOG_DB_BASE`).
#[must_use]
pub fn log_ddl(writer: &str) -> String {
    format!("{}\n{}", LOG_DB_BASE, log_runtime_grants(writer))
}

/// Least-privilege audit writer grants.
#[must_use]
pub fn audit_runtime_grants(role: &str) -> String {
    let writer = sql_ident(role);
    format!(
        "-- Least-privilege runtime privileges for the audit writer
GRANT USAGE ON SCHEMA public TO {writer};
GRANT SELECT, INSERT ON audit_records TO {writer};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO {writer};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT ON TABLES TO {writer};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO {writer};
"
    )
}

/// Least-privilege log writer grants.
#[must_use]
pub fn log_runtime_grants(role: &str) -> String {
    let writer = sql_ident(role);
    format!(
        "-- Least-privilege runtime privileges for the log writer
GRANT USAGE ON SCHEMA public TO {writer};
GRANT SELECT, INSERT ON attempt_step_logs, http_access_logs TO {writer};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO {writer};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT ON TABLES TO {writer};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO {writer};
"
    )
}

/// Monthly partition function and its first call (no clock in the plan: `now()` is evaluated by
/// PostgreSQL, so the same plan is valid on every deploy).
#[must_use]
pub fn ensure_log_partitions_sql(months_ahead: u32, retention_months: u32) -> String {
    format!(
        "CREATE OR REPLACE FUNCTION ensure_log_partitions(months_ahead INT DEFAULT 6, retention_months INT DEFAULT 12)
RETURNS void AS $$
DECLARE
  v_offset INT;
  start_date DATE;
  end_date DATE;
  suffix TEXT;
  cutoff_date DATE;
  partition_name TEXT;
  partition_start DATE;
BEGIN
  FOR v_offset IN 0..months_ahead - 1 LOOP
    start_date := (date_trunc('month', now())::date + (v_offset || ' months')::interval)::date;
    end_date := (start_date + interval '1 month')::date;
    suffix := to_char(start_date, 'YYYY_MM');
    EXECUTE format('CREATE TABLE IF NOT EXISTS attempt_step_logs_%s PARTITION OF attempt_step_logs FOR VALUES FROM (%L) TO (%L)', suffix, start_date, end_date);
    EXECUTE format('CREATE TABLE IF NOT EXISTS http_access_logs_%s PARTITION OF http_access_logs FOR VALUES FROM (%L) TO (%L)', suffix, start_date, end_date);
  END LOOP;
  cutoff_date := (date_trunc('month', now()) - make_interval(months => retention_months))::date;
  FOR partition_name IN
    SELECT child.relname FROM pg_inherits
    JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
    JOIN pg_class child ON child.oid = pg_inherits.inhrelid
    WHERE parent.relname = 'attempt_step_logs' AND child.relname ~ '^attempt_step_logs_[0-9]{{4}}_[0-9]{{2}}$'
  LOOP
    partition_start := to_date(right(partition_name, 7), 'YYYY_MM');
    IF partition_start < cutoff_date THEN EXECUTE format('DROP TABLE IF EXISTS %I', partition_name); END IF;
  END LOOP;
  FOR partition_name IN
    SELECT child.relname FROM pg_inherits
    JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
    JOIN pg_class child ON child.oid = pg_inherits.inhrelid
    WHERE parent.relname = 'http_access_logs' AND child.relname ~ '^http_access_logs_[0-9]{{4}}_[0-9]{{2}}$'
  LOOP
    partition_start := to_date(right(partition_name, 7), 'YYYY_MM');
    IF partition_start < cutoff_date THEN EXECUTE format('DROP TABLE IF EXISTS %I', partition_name); END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

SELECT ensure_log_partitions({months_ahead}, {retention_months});
"
    )
}

const AUDIT_DB_BASE: &str = r#"CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS audit_records (
  seq_no              BIGINT GENERATED BY DEFAULT AS IDENTITY UNIQUE,
  id                  UUID         PRIMARY KEY,
  created_at          TIMESTAMPTZ  NOT NULL,
  ingested_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  actor_id            UUID         NOT NULL,
  actor_email         VARCHAR(191) NULL,
  role                VARCHAR(64)  NOT NULL,
  action              VARCHAR(96)  NOT NULL,
  entity_type         VARCHAR(64)  NOT NULL,
  entity_id           VARCHAR(64)  NOT NULL,
  merchant_id         UUID         NULL,
  approval_request_id UUID         NULL,
  request_id          VARCHAR(64)  NULL,
  client_ip           VARCHAR(45)  NULL,
  user_agent          TEXT         NULL,
  before_json         JSONB        NOT NULL,
  after_json          JSONB        NOT NULL,
  prev_hash           CHAR(64)     NOT NULL,
  row_hash            CHAR(64)     NOT NULL
);

ALTER TABLE audit_records ALTER COLUMN seq_no SET GENERATED BY DEFAULT;

CREATE INDEX IF NOT EXISTS audit_records_entity_idx
  ON audit_records (entity_type, entity_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS audit_records_actor_idx
  ON audit_records (actor_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS audit_records_created_brin_idx
  ON audit_records USING brin (created_at);

CREATE INDEX IF NOT EXISTS audit_records_trgm_search_idx
  ON audit_records USING gin (
    action gin_trgm_ops,
    entity_type gin_trgm_ops,
    entity_id gin_trgm_ops,
    actor_email gin_trgm_ops
  );

CREATE OR REPLACE FUNCTION compute_audit_chain_hash_trg() RETURNS trigger AS $$
DECLARE
  v_prev_hash CHAR(64);
  v_prev_seq BIGINT;
  v_canonical TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(994001);
  SELECT seq_no, row_hash INTO v_prev_seq, v_prev_hash
  FROM audit_records ORDER BY seq_no DESC LIMIT 1;
  NEW.seq_no := COALESCE(v_prev_seq, 0) + 1;
  IF v_prev_hash IS NULL THEN v_prev_hash := repeat('0', 64); END IF;
  NEW.prev_hash := v_prev_hash;
  v_canonical := concat_ws(
    '|', NEW.prev_hash, NEW.id::text,
    to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    NEW.actor_id::text, NEW.action, NEW.entity_type, NEW.entity_id,
    NEW.before_json::text, NEW.after_json::text
  );
  NEW.row_hash := encode(digest(v_canonical, 'sha256'), 'hex');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_chain_compute ON audit_records;
CREATE TRIGGER trg_audit_chain_compute
  BEFORE INSERT ON audit_records
  FOR EACH ROW EXECUTE FUNCTION compute_audit_chain_hash_trg();

CREATE OR REPLACE FUNCTION verify_audit_chain()
RETURNS TABLE(valid BOOLEAN, verified_count BIGINT, first_broken_id UUID) AS $$
DECLARE
  r RECORD;
  previous CHAR(64) := repeat('0', 64);
  expected TEXT;
  verified BIGINT := 0;
BEGIN
  FOR r IN SELECT * FROM audit_records ORDER BY seq_no ASC LOOP
    expected := encode(digest(concat_ws(
      '|', previous, r.id::text,
      to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      r.actor_id::text, r.action, r.entity_type, r.entity_id,
      r.before_json::text, r.after_json::text
    ), 'sha256'), 'hex');
    IF r.prev_hash <> previous OR r.row_hash <> expected THEN
      RETURN QUERY SELECT false, verified, r.id; RETURN;
    END IF;
    previous := r.row_hash;
    verified := verified + 1;
  END LOOP;
  RETURN QUERY SELECT true, verified, NULL::uuid;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION forbid_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AUDIT_TAMPER_PROHIBITED: audit_records is strictly append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_immutable ON audit_records;
CREATE TRIGGER trg_audit_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_records
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();

REVOKE UPDATE, DELETE, TRUNCATE ON audit_records FROM PUBLIC;
"#;

const LOG_DB_BASE: &str = r#"CREATE TABLE IF NOT EXISTS attempt_step_logs (
  id                     UUID         NOT NULL,
  attempt_id             UUID         NOT NULL,
  gateway_version_id     UUID         NOT NULL,
  phase                  VARCHAR(32)  NOT NULL,
  step_id                UUID         NULL,
  step_order             INT          NOT NULL,
  redacted_request_json  JSONB        NOT NULL,
  redacted_response_text TEXT         NOT NULL,
  http_status            INT          NULL,
  duration_ms            INT          NULL,
  outcome                VARCHAR(64)  NOT NULL,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX IF NOT EXISTS attempt_step_logs_attempt_idx
  ON attempt_step_logs (attempt_id, step_order ASC);

CREATE INDEX IF NOT EXISTS attempt_step_logs_created_brin_idx
  ON attempt_step_logs USING brin (created_at);

CREATE TABLE IF NOT EXISTS http_access_logs (
  id             BIGINT GENERATED ALWAYS AS IDENTITY,
  request_id     VARCHAR(64)  NOT NULL,
  channel        VARCHAR(24)  NOT NULL,
  method         VARCHAR(10)  NOT NULL,
  route_pattern  VARCHAR(191) NOT NULL,
  status_code    SMALLINT     NOT NULL,
  duration_ms    INT          NOT NULL,
  db_queries     SMALLINT     NOT NULL DEFAULT 0,
  db_duration_ms INT          NOT NULL DEFAULT 0,
  actor_id       UUID         NULL,
  client_ip      VARCHAR(45)  NULL,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX IF NOT EXISTS http_access_logs_created_brin_idx
  ON http_access_logs USING brin (created_at);
"#;

/// Repository SQL for an audit/log database: owner and writer roles plus the database.
#[must_use]
pub fn tier_repository_sql(
    database: &str,
    owner: &str,
    writer: &str,
    owner_secret: &Option<String>,
    writer_secret: &Option<String>,
) -> (String, Vec<String>) {
    let mut secrets = Vec::new();
    let mut sql = String::from("\\set ON_ERROR_STOP on\n");
    if let Some(name) = secret_name(owner_secret) {
        sql.push_str(&create_login_role_sql(owner, &name));
        secrets.push(name);
    }
    if let Some(name) = secret_name(writer_secret) {
        sql.push_str(&create_login_role_sql(writer, &name));
        secrets.push(name);
    }
    sql.push_str(&format!(
        "SELECT format('CREATE DATABASE %I OWNER %I', {}, {}) WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = {})\\gexec\nALTER DATABASE {} OWNER TO {};\n",
        sql_literal(database),
        sql_literal(owner),
        sql_literal(database),
        sql_ident(database),
        sql_ident(owner)
    ));
    (sql, secrets)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::settings::{
        ClientCertMode, PgRoles, PostgresSettings, RedisEngine, RedisSettings, TlsVerify,
    };

    fn pg() -> PostgresSettings {
        PostgresSettings {
            ram_gb: Some(32),
            roles: PgRoles {
                owner: "gw_core_user".to_owned(),
                app: "pgw_app_login".to_owned(),
                app_group: "pgw_app".to_owned(),
                replication: "gw_replicator".to_owned(),
            },
            owner_password: Some("secret:pg_db_password".to_owned()),
            app_password: Some("secret:pg_app_password".to_owned()),
            replication_password: Some("secret:pg_replication_password".to_owned()),
            ..PostgresSettings::default()
        }
    }

    #[test]
    fn postgres_conf_contains_the_design_settings() {
        let text = postgres_conf(
            &pg(),
            "127.0.0.1,10.0.0.21",
            "/var/lib/postgresql/18/main",
            "/etc/postgresql/18/main/pg_hba.conf",
            5432,
            "/etc/postgresql/18/main/tls",
            &["replica_1".to_owned()],
            false,
        );
        assert!(text.contains("shared_buffers = 8GB"));
        assert!(text.contains("effective_cache_size = 24GB"));
        assert!(text.contains("work_mem = 32MB"));
        assert!(text.contains("io_method = 'worker'"));
        assert!(text.contains("wal_compression = lz4"));
        assert!(text.contains("max_slot_wal_keep_size = '64GB'"));
        assert!(text.contains("idle_in_transaction_session_timeout = '60s'"));
        assert!(text.contains("synchronous_standby_names = 'ANY 1 (replica_1)'"));
        assert!(text.contains("ssl = on"));
        assert!(text.contains("ssl_cert_file = '/etc/postgresql/18/main/tls/server.crt'"));
        assert!(text.contains("password_encryption = 'scram-sha-256'"));
    }

    #[test]
    fn pg_hba_is_hostssl_only_and_replication_is_scoped() {
        let text = pg_hba(
            &pg(),
            &["10.0.0.11".to_owned(), "10.0.0.21".to_owned()],
            &["10.0.0.22".to_owned()],
        );
        assert!(!text.lines().any(|line| line.starts_with("host ")));
        assert!(text.contains("hostssl all             all             10.0.0.11/32"));
        assert!(text.contains("hostssl replication     gw_replicator"));
        assert!(text.contains("clientcert=verify-ca"));
        assert!(!text.contains("10.0.0.99"));
    }

    #[test]
    fn bootstrap_sql_has_no_password_literals() {
        let (sql, secrets) =
            postgres_bootstrap_sql(&pg(), &[("replica_1".to_owned(), "db-2".to_owned())]);
        assert!(sql.contains("PASSWORD :'pg_db_password'"));
        assert!(sql.contains("PASSWORD :'pg_app_password'"));
        assert!(sql.contains("PASSWORD :'pg_replication_password'"));
        assert!(!sql.contains("secret:"));
        assert!(sql.contains("CREATE DATABASE"));
        assert!(sql.contains("pg_create_physical_replication_slot"));
        assert_eq!(secrets.len(), 3);
    }

    #[test]
    fn audit_ddl_keeps_the_chain_and_the_append_only_guard() {
        let ddl = audit_ddl("gw_audit_writer");
        assert!(ddl.contains("compute_audit_chain_hash_trg"));
        assert!(ddl.contains("trg_audit_immutable"));
        assert!(ddl.contains("AUDIT_TAMPER_PROHIBITED"));
        assert!(ddl.contains("GRANT SELECT, INSERT ON audit_records TO \"gw_audit_writer\""));
        assert!(!ddl.contains("GRANT ALL"));
    }

    #[test]
    fn redis_tls_is_tls_only_and_acl_has_no_plaintext() {
        let settings = RedisSettings {
            tls: true,
            acl: true,
            ..RedisSettings::default()
        };
        let text = redis_conf(
            &settings,
            "10.0.0.40",
            "/etc/pg-redis/tls",
            "/etc/pg-redis/users.acl",
        );
        assert!(text.contains("port 0"));
        assert!(text.contains("tls-port 6379"));
        assert!(text.contains("tls-auth-clients yes"));
        assert!(text.contains("maxmemory-policy volatile-ttl"));
        assert!(text.contains("appendonly yes"));
        let (acl, secrets) = redis_acl(&settings);
        assert!(acl.contains(">{{secret:redis_core_password}}"));
        assert!(acl.contains("user default off"));
        assert!(!acl.contains("hunter2"));
        assert_eq!(secrets.len(), 3);
    }

    #[test]
    fn clamd_is_loopback_only_and_accepts_the_upload_limit() {
        let text = clamd_conf(&crate::storage::settings::ClamavSettings::default());
        assert!(text.contains("TCPAddr 127.0.0.1"));
        assert!(text.contains("StreamMaxLength 32M"));
        assert!(!text.contains("TCPAddr 0.0.0.0"));
    }

    #[test]
    fn pgbouncer_unit_is_hardened_and_fast_to_stop() {
        let unit = pgbouncer_unit();
        assert!(unit.contains("KillSignal=SIGINT"));
        assert!(unit.contains("TimeoutStopSec=15s"));
        assert!(!unit.contains("LoadCredential"));
        assert!(unit.contains("ProtectSystem=strict"));
    }

    #[test]
    fn sentinel_and_redis_engine_units_are_rendered() {
        let settings = RedisSettings::default();
        let text = sentinel_conf(
            &settings,
            "10.0.0.40",
            "10.0.0.40",
            "/etc/pg-redis/tls",
            26379,
            "pg-redis",
        );
        assert!(text.contains("sentinel monitor pg-redis 10.0.0.40 6379 2"));
        assert!(text.contains("sentinel auth-pass pg-redis {{secret:redis_core_password}}"));
        assert!(sentinel_unit(RedisEngine::Valkey, 1).contains("valkey-server"));
        assert!(sentinel_unit(RedisEngine::Redis, 1).contains("redis-server"));
        let loopback = sentinel_conf(
            &settings,
            "127.0.0.1",
            "127.0.0.1",
            "/etc/pg-redis/tls",
            26379,
            "pg-redis",
        );
        assert!(loopback.contains("bind 127.0.0.1\n"));
        assert!(!loopback.contains("127.0.0.1 127.0.0.1"));
    }

    #[test]
    fn tls_modes_render_the_expected_sslmode() {
        assert_eq!(TlsVerify::Require.as_str(), "require");
        assert_eq!(TlsVerify::VerifyFull.as_str(), "verify-full");
        assert_eq!(ClientCertMode::Off.hba_suffix(), "");
        assert_eq!(
            ClientCertMode::VerifyFull.hba_suffix(),
            " clientcert=verify-full"
        );
    }
}
