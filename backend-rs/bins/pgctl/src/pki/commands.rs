//! `pgctl pki …` command implementations (D4-T01/T02).
//!
//! Everything returns a [`Report`] so the exit-code contract (0 success, 1 failure, 2 usage, 3
//! precondition) is testable without capturing stdout. No secret value is ever logged; private
//! keys are only written to files with mode 0600.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use pg_deploy_config::{load_toml_file, validate, PgctlConfig, Severity};
use serde_json::{json, Value};

use crate::cli::{
    Cli, PkiCommand, PkiDevArgs, PkiInitArgs, PkiInventoryArgs, PkiIssueArgs, PkiRenewArgs,
    PkiRevokeArgs, PkiStorageArgs, PkiVerifyArgs,
};
use crate::commands::{Report, EXIT_FAILURE};
use crate::pki::catalog::{dev_specs, topology_specs, CertKind, CertificateSpec};
use crate::pki::inventory::{self, CertificateStatus};
use crate::pki::issue::{
    create_ca, issue_leaf, load_ca, CaOptions, PkiPaths, DEFAULT_INTERMEDIATE_DAYS,
    DEFAULT_LEAF_DAYS, DEFAULT_ROOT_DAYS,
};
use crate::pki::revocation::{self, RevocationList, RevokeSelector};
use crate::pki::storage;
use crate::pki::timeutil::format_unix_rfc3339;
use crate::pki::verify::{self, VerifyOptions};
use crate::util;

/// Production PKI default (`[tls].pki_dir` in `pgctl.toml`).
pub const DEFAULT_PKI_DIR: &str = "/etc/pg/pki";
/// Development leaf lifetime, matching `core-back/scripts/generate-mtls-certs.ts` (`MTLS_CERT_DAYS=825`).
pub const DEV_LEAF_DAYS: u16 = 825;
/// Default renewal window when neither `--within-days` nor `[tls].renew_within_days` is set.
pub const DEFAULT_RENEW_WITHIN_DAYS: u16 = 30;
/// Hidden staging directory used to build a new CA before swapping it in.
const ROTATION_STAGING: &str = ".pki-rotate";

/// Dispatch a `pgctl pki` subcommand.
#[must_use]
pub fn run(cli: &Cli, command: &PkiCommand) -> Report {
    let outcome = match command {
        PkiCommand::Init(args) => run_init(cli, args),
        PkiCommand::Issue(args) => run_issue(cli, args),
        PkiCommand::Renew(args) => run_renew(cli, args),
        PkiCommand::Revoke(args) => run_revoke(cli, args),
        PkiCommand::Inventory(args) => run_inventory(cli, args),
        PkiCommand::Verify(args) => run_verify(cli, args),
        PkiCommand::Dev(args) => run_dev(cli, args),
        PkiCommand::Storage(args) => run_storage(cli, args),
    };
    outcome.unwrap_or_else(|error| Report::failure(format!("{error:#}")))
}

fn now_unix(value: Option<i64>) -> i64 {
    value.unwrap_or_else(|| i64::try_from(util::now_unix()).unwrap_or(i64::MAX))
}

fn success(cli: &Cli, value: Value, human: Vec<String>) -> Result<Report> {
    if cli.json {
        let text = serde_json::to_string_pretty(&value).context("cannot serialise the result")?;
        Ok(Report::ok(vec![text]))
    } else {
        Ok(Report::ok(human))
    }
}

fn resolve_dir_with(
    cli: &Cli,
    explicit: Option<&Path>,
    config: Option<&PgctlConfig>,
) -> Result<PathBuf> {
    if let Some(dir) = explicit {
        return Ok(util::expand_tilde(dir));
    }
    if let Some(config) = config {
        return Ok(util::expand_tilde(Path::new(&config.tls.pki_dir)));
    }
    if let Some(path) = cli.config.as_deref() {
        let loaded = load_toml_file(path)
            .with_context(|| format!("cannot read the global --config {}", path.display()))?;
        return Ok(util::expand_tilde(Path::new(&loaded.tls.pki_dir)));
    }
    Ok(PathBuf::from(DEFAULT_PKI_DIR))
}

fn resolve_dir(cli: &Cli, explicit: Option<&Path>) -> Result<PathBuf> {
    resolve_dir_with(cli, explicit, None)
}

fn optional_config(cli: &Cli, file: Option<&Path>) -> Result<Option<PgctlConfig>> {
    match file.or(cli.config.as_deref()) {
        Some(path) => Ok(Some(load_toml_file(path).with_context(|| {
            format!("cannot read the configuration {}", path.display())
        })?)),
        None => Ok(None),
    }
}

fn required_config(cli: &Cli, file: Option<&Path>) -> Result<PgctlConfig> {
    optional_config(cli, file)?.context(
        "this command needs --file <pgctl.toml> (or the global --config <PATH>) to know the topology",
    )
}

fn validation_lines(config: &PgctlConfig) -> (Vec<String>, usize) {
    let mut lines = Vec::new();
    let mut errors = 0;
    for problem in validate(config) {
        if problem.severity == Severity::Error {
            errors += 1;
        }
        lines.push(format!(
            "{} [{}] {}: {}",
            if problem.severity == Severity::Error {
                "ERROR"
            } else {
                "WARN"
            },
            problem.code,
            problem.path,
            problem.message
        ));
    }
    (lines, errors)
}

fn any_ca_file_exists(paths: &PkiPaths) -> bool {
    [
        paths.root_cert(),
        paths.root_key(),
        paths.intermediate_cert(),
        paths.intermediate_key(),
        paths.chain(),
    ]
    .iter()
    .any(|file| file.exists())
}

fn ca_statuses(paths: &PkiPaths) -> Result<(CertificateStatus, CertificateStatus)> {
    let root = inventory::inspect_certificate_file(&paths.root_cert(), "internal-ca")?;
    let intermediate =
        inventory::inspect_certificate_file(&paths.intermediate_cert(), "intermediate-ca")?;
    Ok((root, intermediate))
}

fn is_name_revoked(list: &RevocationList, name: &str) -> bool {
    list.entries
        .iter()
        .any(|entry| entry.name.as_deref() == Some(name))
}

/// Specs to reissue after a CA rotation: the inventory when available, otherwise the certificates
/// present on disk. Revoked names are excluded by `leaf_specs`.
fn specs_for_rotation(paths: &PkiPaths) -> Vec<CertificateSpec> {
    match inventory::read_inventory(paths) {
        Ok(Some(inventory)) => inventory.leaf_specs(),
        _ => inventory::scan_leaf_specs(paths, None),
    }
}

fn write_inventory(paths: &PkiPaths, list: &RevocationList) -> Result<inventory::Inventory> {
    let fallback = inventory::read_inventory(paths).ok().flatten();
    let inventory = inventory::build_inventory(paths, fallback.as_ref(), &list.serials())?;
    inventory::write_inventory(paths, &inventory)?;
    Ok(inventory)
}

fn entry_json(paths: &PkiPaths, entry: &inventory::InventoryEntry) -> Value {
    json!({
        "name": &entry.name,
        "kind": entry.kind,
        "serial": &entry.serial,
        "not_after": &entry.not_after,
        "cert": paths.cert_path(&entry.name).display().to_string(),
        "key": paths.key_path(&entry.name).display().to_string(),
    })
}

fn human_entry(label: &str, entry: &inventory::InventoryEntry) -> String {
    format!(
        "{label:<8} {:<34} {:<13} serial {}  expires {}",
        entry.name,
        entry.kind.as_str(),
        entry.serial,
        entry.not_after
    )
}

// ---------------------------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------------------------

fn run_init(cli: &Cli, args: &PkiInitArgs) -> Result<Report> {
    let dir = resolve_dir(cli, args.dir.as_deref())?;
    let paths = PkiPaths::new(dir);
    let now = now_unix(args.now);
    let options = CaOptions {
        root_days: args.root_days.max(1),
        intermediate_days: args.intermediate_days.max(1),
    };
    let mut human = Vec::new();

    if paths.ca_exists() && !args.rotate {
        // Validate both keys as well as the certificates: a half-restored PKI must be reported
        // before a deploy relies on it.
        let _ = load_ca(&paths)?;
        let (root, intermediate) = ca_statuses(&paths)?;
        human.push(format!(
            "CA already initialised in {} (nothing changed; use --rotate to replace it)",
            paths.dir().display()
        ));
        human.push(format!(
            "  internal-ca      serial {}  expires {}",
            root.serial,
            format_unix_rfc3339(root.not_after_unix)
        ));
        human.push(format!(
            "  intermediate-ca  serial {}  expires {}",
            intermediate.serial,
            format_unix_rfc3339(intermediate.not_after_unix)
        ));
        return success(
            cli,
            json!({
                "pki_dir": paths.dir().display().to_string(),
                "created": false,
                "rotated": false,
                "root": {"serial": root.serial, "not_after": format_unix_rfc3339(root.not_after_unix)},
                "intermediate": {"serial": intermediate.serial, "not_after": format_unix_rfc3339(intermediate.not_after_unix)},
            }),
            human,
        );
    }
    if !args.rotate && any_ca_file_exists(&paths) {
        bail!(
            "{} contains a partial or foreign CA (no complete root + intermediate); run 'pgctl pki init --rotate' to replace it",
            paths.dir().display()
        );
    }

    let specs = if args.rotate {
        specs_for_rotation(&paths)
    } else {
        Vec::new()
    };
    let list = revocation::load_list(&paths).unwrap_or_default();

    if args.rotate && any_ca_file_exists(&paths) {
        rotate_ca(&paths, options, now)?;
    } else {
        create_ca(&paths, options, now)?;
    }

    let mut reissued = Vec::new();
    let mut skipped = Vec::new();
    if args.rotate {
        let ca = load_ca(&paths)?;
        for spec in &specs {
            if is_name_revoked(&list, &spec.name) {
                skipped.push(json!({"name": &spec.name, "reason": "revoked"}));
                continue;
            }
            let leaf = issue_leaf(&paths, &ca, spec, now, true, 0)?;
            reissued.push(entry_json(&paths, &leaf.entry));
        }
        // The CRL is signed by the intermediate: after a rotation it must be re-signed by the new
        // one, otherwise PostgreSQL `ssl_crl_file` and the daemons reject it.
        if !list.entries.is_empty() || paths.crl().is_file() {
            revocation::regenerate_crl(&paths, &list, now)?;
        }
    }

    let inventory = write_inventory(&paths, &list)?;
    let (root, intermediate) = ca_statuses(&paths)?;
    human.push(format!("initialised PKI in {}", paths.dir().display()));
    human.push(format!(
        "  internal-ca      serial {}  expires {}",
        root.serial,
        format_unix_rfc3339(root.not_after_unix)
    ));
    human.push(format!(
        "  intermediate-ca  serial {}  expires {}",
        intermediate.serial,
        format_unix_rfc3339(intermediate.not_after_unix)
    ));
    if args.rotate {
        human.push(format!(
            "  rotated the CA and re-issued {} leaf certificate(s){}",
            reissued.len(),
            if skipped.is_empty() {
                String::new()
            } else {
                format!(" ({} revoked name(s) skipped)", skipped.len())
            }
        ));
    }
    human.push(format!(
        "  next: pgctl pki issue --dir {} --config <pgctl.toml>",
        paths.dir().display()
    ));
    success(
        cli,
        json!({
            "pki_dir": paths.dir().display().to_string(),
            "created": true,
            "rotated": args.rotate,
            "root": {"serial": root.serial, "not_after": format_unix_rfc3339(root.not_after_unix), "file": paths.root_cert().display().to_string()},
            "intermediate": {"serial": intermediate.serial, "not_after": format_unix_rfc3339(intermediate.not_after_unix), "file": paths.intermediate_cert().display().to_string()},
            "chain": paths.chain().display().to_string(),
            "reissued": reissued,
            "skipped": skipped,
            "inventory": paths.inventory().display().to_string(),
            "certificates": inventory.certificates.len(),
        }),
        human,
    )
}

/// Build the new CA in a staging directory, then swap it in, so a failure before the swap leaves
/// the current CA untouched.
fn rotate_ca(paths: &PkiPaths, options: CaOptions, now: i64) -> Result<()> {
    paths.ensure_dir()?;
    let staging_dir = paths.dir().join(ROTATION_STAGING);
    if staging_dir.exists() {
        std::fs::remove_dir_all(&staging_dir)
            .with_context(|| format!("cannot clear {}", staging_dir.display()))?;
    }
    let staging = PkiPaths::new(&staging_dir);
    let result = (|| -> Result<()> {
        create_ca(&staging, options, now)?;
        for (from, to, mode) in [
            (staging.root_key(), paths.root_key(), 0o600),
            (staging.root_cert(), paths.root_cert(), 0o644),
            (staging.intermediate_key(), paths.intermediate_key(), 0o600),
            (
                staging.intermediate_cert(),
                paths.intermediate_cert(),
                0o644,
            ),
            (staging.chain(), paths.chain(), 0o644),
        ] {
            let data =
                std::fs::read(&from).with_context(|| format!("cannot read {}", from.display()))?;
            util::write_atomic(&to, &data, mode)
                .with_context(|| format!("cannot write {}", to.display()))?;
        }
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&staging_dir);
    result
}

// ---------------------------------------------------------------------------------------------
// issue
// ---------------------------------------------------------------------------------------------

fn run_issue(cli: &Cli, args: &PkiIssueArgs) -> Result<Report> {
    let config = optional_config(cli, args.file.as_deref())?;
    let dir = resolve_dir_with(cli, args.dir.as_deref(), config.as_ref())?;
    let paths = PkiPaths::new(dir);
    let now = now_unix(None);
    let leaf_days = args
        .days
        .or_else(|| config.as_ref().map(|config| config.tls.leaf_days))
        .unwrap_or(DEFAULT_LEAF_DAYS)
        .max(1);
    let renew_within = config.as_ref().map_or(DEFAULT_RENEW_WITHIN_DAYS, |config| {
        config.tls.renew_within_days
    });
    let specs = issue_specs(args, config.as_ref(), leaf_days)?;

    if !paths.ca_exists() {
        bail!(
            "no CA in {}; run 'pgctl pki init --dir {}' first",
            paths.dir().display(),
            paths.dir().display()
        );
    }
    let ca = load_ca(&paths)?;
    let list = revocation::load_list(&paths)?;

    let mut issued = Vec::new();
    let mut kept = Vec::new();
    let mut skipped = Vec::new();
    let mut human = Vec::new();
    for spec in &specs {
        if is_name_revoked(&list, &spec.name) {
            skipped.push(json!({"name": &spec.name, "reason": "revoked"}));
            human.push(format!(
                "skipped  {:<34} revoked (remove the entry from {} to re-issue)",
                spec.name,
                paths.revocation_list().display()
            ));
            continue;
        }
        let leaf = issue_leaf(&paths, &ca, spec, now, args.force, renew_within)?;
        if leaf.written {
            human.push(human_entry("issued", &leaf.entry));
            issued.push(entry_json(&paths, &leaf.entry));
        } else {
            human.push(format!(
                "kept     {:<34} valid, outside the {renew_within}-day window",
                spec.name
            ));
            kept.push(json!({"name": &spec.name, "serial": &leaf.entry.serial}));
        }
    }

    let inventory = write_inventory(&paths, &list)?;
    let (_, intermediate) = ca_statuses(&paths)?;
    if let Some(config) = &config {
        let (findings, errors) = validation_lines(config);
        for line in &findings {
            human.push(line.clone());
        }
        if errors > 0 {
            human.push(format!(
                "{errors} configuration error(s): the topology may not be deployable, but the certificates were issued"
            ));
        }
    }
    human.push(format!(
        "inventory: {} ({} certificate(s))",
        paths.inventory().display(),
        inventory.certificates.len()
    ));

    success(
        cli,
        json!({
            "pki_dir": paths.dir().display().to_string(),
            "ca": {
                "root": paths.root_cert().display().to_string(),
                "intermediate": {"file": paths.intermediate_cert().display().to_string(), "serial": intermediate.serial},
                "chain": paths.chain().display().to_string(),
            },
            "leaf_days": leaf_days,
            "renew_within_days": renew_within,
            "issued": issued,
            "kept": kept,
            "skipped": skipped,
            "inventory": paths.inventory().display().to_string(),
            "certificates": inventory.certificates.len(),
        }),
        human,
    )
}

fn issue_specs(
    args: &PkiIssueArgs,
    config: Option<&PgctlConfig>,
    leaf_days: u16,
) -> Result<Vec<CertificateSpec>> {
    let mut catalogue = config.map_or_else(Vec::new, |config| topology_specs(config, leaf_days));
    if let Some(name) = args.name.as_deref() {
        if let Some(mut selected) = catalogue.iter().find(|spec| spec.name == name).cloned() {
            apply_overrides(&mut selected, args, leaf_days)?;
            return Ok(vec![selected]);
        }
        if config.is_some() && args.cn.is_none() {
            let names: Vec<&str> = catalogue.iter().map(|spec| spec.name.as_str()).collect();
            bail!(
                "certificate '{name}' is not in the catalogue; available: {}{}",
                names.join(", "),
                if args.dns.is_empty() && args.ip.is_empty() {
                    ""
                } else {
                    " (or pass --cn to issue a custom leaf)"
                }
            );
        }
        return Ok(vec![ad_hoc_spec(args, leaf_days)?]);
    }
    if args.cn.is_some() {
        return Ok(vec![ad_hoc_spec(args, leaf_days)?]);
    }
    if config.is_none() {
        bail!("issue needs --file <pgctl.toml> (the whole topology), or --name/--cn for one certificate");
    }
    if catalogue.is_empty() {
        bail!("the configuration declares no hosts, so the topology catalogue is empty");
    }
    Ok(std::mem::take(&mut catalogue))
}

fn apply_overrides(spec: &mut CertificateSpec, args: &PkiIssueArgs, leaf_days: u16) -> Result<()> {
    if args.days.is_some() {
        spec.days = leaf_days;
    }
    if let Some(kind) = args.kind.as_deref() {
        spec.kind =
            CertKind::parse(kind).with_context(|| format!("unknown certificate kind '{kind}'"))?;
    }
    if !args.dns.is_empty() {
        spec.dns_sans.extend(args.dns.iter().cloned());
    }
    if !args.ip.is_empty() {
        spec.ip_sans.extend(args.ip.iter().cloned());
    }
    spec.normalize().map_err(anyhow::Error::msg)
}

fn ad_hoc_spec(args: &PkiIssueArgs, leaf_days: u16) -> Result<CertificateSpec> {
    let cn = args
        .cn
        .clone()
        .or_else(|| args.name.clone())
        .context("a custom certificate needs --cn (or --name)")?;
    let name = args
        .name
        .clone()
        .unwrap_or_else(|| util::sanitize_component(&cn));
    let kind = match args.kind.as_deref() {
        Some(value) => {
            CertKind::parse(value).with_context(|| format!("unknown certificate kind '{value}'"))?
        }
        None if !args.dns.is_empty() || !args.ip.is_empty() => CertKind::Server,
        None => CertKind::Client,
    };
    let mut spec = CertificateSpec::new(name, cn, kind, leaf_days);
    spec.dns_sans = args.dns.clone();
    spec.ip_sans = args.ip.clone();
    spec.normalize().map_err(anyhow::Error::msg)?;
    Ok(spec)
}

// ---------------------------------------------------------------------------------------------
// renew
// ---------------------------------------------------------------------------------------------

fn run_renew(cli: &Cli, args: &PkiRenewArgs) -> Result<Report> {
    let config = optional_config(cli, None)?;
    let dir = resolve_dir_with(cli, args.dir.as_deref(), config.as_ref())?;
    let paths = PkiPaths::new(dir);
    let now = now_unix(args.now);
    let within = args
        .within_days
        .or_else(|| config.as_ref().map(|config| config.tls.renew_within_days))
        .unwrap_or(DEFAULT_RENEW_WITHIN_DAYS);

    if within == 0 {
        return success(
            cli,
            json!({"pki_dir": paths.dir().display().to_string(), "within_days": 0, "renewed": [], "kept": []}),
            vec![format!(
                "renewal is disabled (--within-days 0); nothing changed in {}",
                paths.dir().display()
            )],
        );
    }
    if !paths.ca_exists() {
        bail!(
            "no CA in {}; run 'pgctl pki init' first",
            paths.dir().display()
        );
    }
    let ca = load_ca(&paths)?;
    let list = revocation::load_list(&paths)?;

    // Never renew leaves under a CA that is expiring: the fresh leaves would die with it.
    let (root, intermediate) = ca_statuses(&paths)?;
    for (label, status) in [("root", &root), ("intermediate", &intermediate)] {
        let remaining = status.days_remaining(now);
        if remaining <= 0 {
            bail!(
                "the {label} CA expired on {}; run 'pgctl pki init --rotate'",
                format_unix_rfc3339(status.not_after_unix)
            );
        }
        if i64::from(within) > remaining {
            bail!(
                "the {label} CA expires in {remaining} day(s) on {}, inside the {within}-day window; renewing leaves would be useless, run 'pgctl pki init --rotate'",
                format_unix_rfc3339(status.not_after_unix)
            );
        }
    }

    let specs = specs_for_rotation(&paths);
    let mut renewed = Vec::new();
    let mut kept = Vec::new();
    let mut missing = Vec::new();
    let mut human = Vec::new();
    for spec in &specs {
        if is_name_revoked(&list, &spec.name) {
            continue;
        }
        let cert_path = paths.cert_path(&spec.name);
        if !cert_path.is_file() {
            missing.push(json!({"name": &spec.name, "reason": "missing"}));
            human.push(format!(
                "missing  {:<34} no certificate (run 'pgctl pki issue')",
                spec.name
            ));
            continue;
        }
        let status = inventory::inspect_certificate_file(&cert_path, &spec.name)?;
        let remaining = status.days_remaining(now);
        if i64::from(within) > remaining {
            let leaf = issue_leaf(&paths, &ca, spec, now, true, 0)?;
            human.push(human_entry("renewed", &leaf.entry));
            renewed.push(entry_json(&paths, &leaf.entry));
        } else {
            human.push(format!(
                "kept     {:<34} expires in {remaining} day(s)",
                spec.name
            ));
            kept.push(
                json!({"name": &spec.name, "serial": &status.serial, "expires_in_days": remaining}),
            );
        }
    }

    // Only touch inventory.json when something changed (or it never existed): a no-op renew keeps
    // every file byte-identical.
    let inventory_changed = !renewed.is_empty() || inventory::read_inventory(&paths)?.is_none();
    let inventory = if inventory_changed {
        Some(write_inventory(&paths, &list)?)
    } else {
        None
    };
    if renewed.is_empty() {
        human.push(format!(
            "nothing to renew in {} (window {within} day(s))",
            paths.dir().display()
        ));
    }
    success(
        cli,
        json!({
            "pki_dir": paths.dir().display().to_string(),
            "within_days": within,
            "ca": {
                "root_serial": root.serial,
                "intermediate_serial": intermediate.serial,
                "intermediate_not_after": format_unix_rfc3339(intermediate.not_after_unix),
            },
            "renewed": renewed,
            "kept": kept,
            "missing": missing,
            "inventory_written": inventory.is_some(),
        }),
        human,
    )
}

// ---------------------------------------------------------------------------------------------
// revoke
// ---------------------------------------------------------------------------------------------

fn run_revoke(cli: &Cli, args: &PkiRevokeArgs) -> Result<Report> {
    let dir = resolve_dir(cli, args.dir.as_deref())?;
    let paths = PkiPaths::new(dir);
    let now = now_unix(args.now);
    let selector = match (args.name.as_deref(), args.serial.as_deref()) {
        (Some(name), None) => RevokeSelector::Name(name),
        (None, Some(serial)) => RevokeSelector::Serial(serial),
        _ => bail!("pass exactly one of --name <file stem> or --serial <hex>"),
    };
    let outcome = revocation::revoke(&paths, selector, &args.reason, now)?;
    let list = revocation::load_list(&paths)?;
    let inventory = write_inventory(&paths, &list)?;
    let human = vec![
        format!(
            "{} {} (serial {})",
            if outcome.added {
                "revoked"
            } else {
                "already revoked"
            },
            outcome.name.as_deref().unwrap_or("-"),
            outcome.serial
        ),
        format!(
            "revocation list: {} ({} entr{}, CRL number {})",
            paths.revocation_list().display(),
            list.entries.len(),
            if list.entries.len() == 1 { "y" } else { "ies" },
            outcome.crl_number
        ),
        format!(
            "signed CRL: {} (distribute as ssl_crl_file; the Rust daemons take the same file)",
            paths.crl().display()
        ),
        format!("inventory: {} certificate(s)", inventory.certificates.len()),
    ];
    success(
        cli,
        json!({
            "pki_dir": paths.dir().display().to_string(),
            "serial": outcome.serial,
            "name": outcome.name,
            "added": outcome.added,
            "crl_number": outcome.crl_number,
            "revocation_list": paths.revocation_list().display().to_string(),
            "crl": outcome.crl,
            "entries": list.entries,
        }),
        human,
    )
}

// ---------------------------------------------------------------------------------------------
// inventory
// ---------------------------------------------------------------------------------------------

fn run_inventory(cli: &Cli, args: &PkiInventoryArgs) -> Result<Report> {
    let dir = resolve_dir(cli, args.dir.as_deref())?;
    let paths = PkiPaths::new(dir);
    if !paths.dir().is_dir() {
        bail!("the PKI directory {} does not exist", paths.dir().display());
    }
    let list = revocation::load_list(&paths)?;
    let fallback = inventory::read_inventory(&paths).ok().flatten();
    let inventory = inventory::build_inventory(&paths, fallback.as_ref(), &list.serials())?;
    if args.write || !paths.inventory().is_file() {
        inventory::write_inventory(&paths, &inventory)?;
    }
    let mut human = vec![format!(
        "PKI {} ({} certificate(s), {} revoked)",
        paths.dir().display(),
        inventory.certificates.len(),
        inventory
            .certificates
            .iter()
            .filter(|entry| entry.revoked)
            .count()
    )];
    for entry in &inventory.certificates {
        human.push(format!(
            "{:<9} {:<34} {:<13} {:<20} {}",
            if entry.revoked { "REVOKED" } else { "ok" },
            entry.name,
            entry.kind.as_str(),
            entry.not_after,
            entry.serial
        ));
    }
    human.push(format!(
        "inventory file: {} (deterministic, sorted by name; use --write to refresh)",
        paths.inventory().display()
    ));
    success(
        cli,
        json!({
            "pki_dir": paths.dir().display().to_string(),
            "inventory_file": paths.inventory().display().to_string(),
            "revocation_file": paths.revocation_list().display().to_string(),
            "crl_file": paths.crl().display().to_string(),
            "certificates": inventory.certificates,
        }),
        human,
    )
}

// ---------------------------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------------------------

fn run_verify(cli: &Cli, args: &PkiVerifyArgs) -> Result<Report> {
    let config = optional_config(cli, args.file.as_deref())?;
    let dir = resolve_dir_with(cli, args.dir.as_deref(), config.as_ref())?;
    let paths = PkiPaths::new(dir);
    let now = now_unix(args.now);
    let within = args
        .within_days
        .or_else(|| config.as_ref().map(|config| config.tls.renew_within_days))
        .unwrap_or(DEFAULT_RENEW_WITHIN_DAYS);
    let expected = config.map(|config| topology_specs(&config, config.tls.leaf_days.max(1)));
    let report = verify::verify(
        &paths,
        &VerifyOptions {
            within_days: within,
            now,
            expected: expected.as_deref(),
        },
    )?;

    let mut human = vec![format!(
        "PKI {} ({} certificate(s), window {} day(s))",
        report.pki_dir,
        report.certificates.len(),
        report.within_days
    )];
    for row in &report.certificates {
        let expiry = if row.not_after.is_empty() {
            "-".to_owned()
        } else {
            format!(
                "{} ({} day(s))",
                row.not_after,
                row.expires_in_days.unwrap_or_default()
            )
        };
        human.push(format!(
            "{:<10} {:<34} {:<13} {}",
            row.state,
            row.name,
            row.kind.as_str(),
            expiry
        ));
    }
    if report.ok {
        human.push("all certificates, the chain and the file modes are valid".to_owned());
    } else {
        human.push(format!("{} problem(s) found", report.problems.len()));
    }

    let mut result = if cli.json {
        let text = serde_json::to_string_pretty(&report).context("cannot serialise the report")?;
        Report::ok(vec![text])
    } else {
        let mut report_out = Report::ok(human);
        for problem in &report.problems {
            report_out.stderr.push(format!(
                "{} {}: {}",
                problem.code, problem.name, problem.message
            ));
        }
        report_out
    };
    if !report.ok {
        result.exit = EXIT_FAILURE;
    }
    Ok(result)
}

// ---------------------------------------------------------------------------------------------
// dev
// ---------------------------------------------------------------------------------------------

fn dev_default_dir() -> PathBuf {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    for ancestor in cwd.ancestors() {
        if ancestor.join("core-back").is_dir() && ancestor.join("deploy").is_dir() {
            return ancestor.join("core-back").join("certs");
        }
    }
    cwd.join("core-back").join("certs")
}

fn assert_dev_path(dir: &Path) -> Result<()> {
    let absolute =
        std::path::absolute(dir).with_context(|| format!("cannot resolve {}", dir.display()))?;
    for prefix in ["/etc", "/var/lib/pg", "/opt/pg", "/srv/pg"] {
        if absolute.starts_with(prefix) {
            bail!(
                "refusing to write a development PKI under {prefix}; 'pki dev' is for a repository checkout, use 'pki init'/'pki issue' for production paths"
            );
        }
    }
    Ok(())
}

fn run_dev(cli: &Cli, args: &PkiDevArgs) -> Result<Report> {
    let dir = match args.dir.as_deref() {
        Some(dir) => util::expand_tilde(dir),
        None => dev_default_dir(),
    };
    assert_dev_path(&dir)?;
    let paths = PkiPaths::new(dir);
    let now = now_unix(args.now);
    let days = args.days.unwrap_or(DEV_LEAF_DAYS).max(1);
    let options = CaOptions {
        root_days: DEFAULT_ROOT_DAYS,
        intermediate_days: DEFAULT_INTERMEDIATE_DAYS,
    };

    let mut rotated = false;
    if paths.ca_exists() {
        if args.rotate {
            rotate_ca(&paths, options, now)?;
            rotated = true;
        }
    } else if any_ca_file_exists(&paths) {
        if !args.rotate {
            bail!(
                "{} contains a CA that pgctl did not create (no intermediate); pass --rotate to replace this development bundle",
                paths.dir().display()
            );
        }
        for file in [
            paths.root_cert(),
            paths.root_key(),
            paths.intermediate_cert(),
            paths.intermediate_key(),
            paths.chain(),
        ] {
            let _ = std::fs::remove_file(file);
        }
        create_ca(&paths, options, now)?;
        rotated = true;
    } else {
        create_ca(&paths, options, now)?;
        rotated = true;
    }

    let ca = load_ca(&paths)?;
    let list = revocation::load_list(&paths)?;
    let mut issued = Vec::new();
    let mut kept = Vec::new();
    let mut skipped = Vec::new();
    let mut human = vec![format!("development PKI in {}", paths.dir().display())];
    for spec in dev_specs(days) {
        if is_name_revoked(&list, &spec.name) {
            skipped.push(json!({"name": &spec.name, "reason": "revoked"}));
            continue;
        }
        let leaf = issue_leaf(&paths, &ca, &spec, now, rotated || args.force, 0)?;
        if leaf.written {
            human.push(human_entry("issued", &leaf.entry));
            issued.push(entry_json(&paths, &leaf.entry));
        } else {
            human.push(format!("kept     {:<34} existing and valid", spec.name));
            kept.push(json!({"name": &spec.name, "serial": &leaf.entry.serial}));
        }
    }
    if rotated && (!list.entries.is_empty() || paths.crl().is_file()) {
        revocation::regenerate_crl(&paths, &list, now)?;
    }
    let inventory = write_inventory(&paths, &list)?;
    human.push(format!(
        "inventory: {} ({} certificate(s)); re-running is safe and does not rotate the CA",
        paths.inventory().display(),
        inventory.certificates.len()
    ));
    if issued.is_empty() {
        human.push("nothing changed".to_owned());
    }
    success(
        cli,
        json!({
            "pki_dir": paths.dir().display().to_string(),
            "ca": {
                "root": paths.root_cert().display().to_string(),
                "intermediate": paths.intermediate_cert().display().to_string(),
                "chain": paths.chain().display().to_string(),
            },
            "days": days,
            "rotated": rotated,
            "issued": issued,
            "kept": kept,
            "skipped": skipped,
            "inventory": paths.inventory().display().to_string(),
            "certificates": inventory.certificates.len(),
        }),
        human,
    )
}

// ---------------------------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------------------------

fn run_storage(cli: &Cli, args: &PkiStorageArgs) -> Result<Report> {
    let config = required_config(cli, args.file.as_deref())?;
    let dir = args.dir.as_deref().map(util::expand_tilde);
    let plan = storage::plan_for_config(&config, dir.as_deref());
    let mut human = vec![format!(
        "Storage TLS plan (section '{}', PKI directory {})",
        plan.section, plan.dir
    )];
    for (label, endpoints) in [
        ("PostgreSQL", &plan.postgres),
        ("PgBouncer", &plan.pgbouncer),
        ("Redis", &plan.redis),
    ] {
        if endpoints.is_empty() {
            continue;
        }
        human.push(format!("{label}:"));
        for endpoint in endpoints {
            human.push(format!(
                "  {}:{}  cert {}  ({})",
                endpoint.host, endpoint.port, endpoint.certificate, endpoint.server_cert
            ));
            human.push(format!("    SANs: {}", endpoint.sans.join(" ")));
            human.push(format!(
                "    install: server.crt={} server.key={} ca={} crl={}",
                endpoint
                    .install
                    .get("server_cert")
                    .map_or("-", String::as_str),
                endpoint
                    .install
                    .get("server_key")
                    .map_or("-", String::as_str),
                endpoint.install.get("ca_file").map_or("-", String::as_str),
                endpoint.install.get("crl_file").map_or("-", String::as_str),
            ));
            human.push(format!("    client: {}", endpoint.client_settings));
        }
    }
    if plan.is_empty() {
        human.push(
            "no PostgreSQL/PgBouncer/Redis server is planned; the certificates appear once the roles exist"
                .to_owned(),
        );
    }
    human.push("Clients:".to_owned());
    for client in &plan.clients {
        human.push(format!(
            "  {:<24} {} (used by {})",
            client.name,
            client.cert,
            client.used_by.join(", ")
        ));
    }
    human.push("Guidance:".to_owned());
    for line in &plan.guidance {
        human.push(format!("  - {line}"));
    }
    success(cli, serde_json::to_value(&plan)?, human)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::EXIT_OK;
    use clap::Parser;

    fn cli(args: &[&str]) -> Cli {
        Cli::try_parse_from(args).unwrap_or_else(|error| panic!("{args:?}: {error}"))
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pgctl-pki-cli-{}-{}-{tag}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or_default()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn cli_smoke_init_issue_inventory_verify_renew_revoke_dev() {
        let dir = temp_dir("smoke");
        let path = dir.to_str().unwrap_or_default();

        let report = run(
            &cli(&["pgctl", "pki", "init", "--dir", path]),
            &PkiCommand::Init(PkiInitArgs {
                dir: Some(dir.clone()),
                root_days: DEFAULT_ROOT_DAYS,
                intermediate_days: DEFAULT_INTERMEDIATE_DAYS,
                rotate: false,
                now: Some(1_800_000_000),
            }),
        );
        assert_eq!(report.exit, EXIT_OK, "{report:?}");

        let mut spec =
            CertificateSpec::new("core-back", "core-back.internal", CertKind::Server, 90);
        spec.dns_sans = vec!["core-back.internal".to_owned()];
        spec.ip_sans = vec!["127.0.0.1".to_owned()];
        spec.normalize().expect("spec");
        let ca = load_ca(&PkiPaths::new(&dir)).expect("ca");
        issue_leaf(&PkiPaths::new(&dir), &ca, &spec, 1_800_000_000, true, 0).expect("issue");

        let report = run(
            &cli(&["pgctl", "pki", "inventory", "--dir", path, "--json"]),
            &PkiCommand::Inventory(PkiInventoryArgs {
                dir: Some(dir.clone()),
                write: false,
            }),
        );
        assert_eq!(report.exit, EXIT_OK, "{report:?}");
        let parsed: serde_json::Value = serde_json::from_str(&report.stdout[0]).expect("json");
        assert!(parsed["certificates"]
            .as_array()
            .is_some_and(|rows| !rows.is_empty()));

        let report = run(
            &cli(&[
                "pgctl",
                "pki",
                "verify",
                "--dir",
                path,
                "--now",
                "1800000000",
            ]),
            &PkiCommand::Verify(PkiVerifyArgs {
                dir: Some(dir.clone()),
                file: None,
                within_days: Some(30),
                now: Some(1_800_000_000),
            }),
        );
        assert_eq!(report.exit, EXIT_OK, "{report:?}");

        let report = run(
            &cli(&[
                "pgctl",
                "pki",
                "renew",
                "--dir",
                path,
                "--now",
                "1800000000",
            ]),
            &PkiCommand::Renew(PkiRenewArgs {
                dir: Some(dir.clone()),
                within_days: Some(30),
                now: Some(1_800_000_000),
            }),
        );
        assert_eq!(report.exit, EXIT_OK, "{report:?}");

        let report = run(
            &cli(&[
                "pgctl",
                "pki",
                "revoke",
                "--dir",
                path,
                "--name",
                "core-back",
                "--now",
                "1800000000",
            ]),
            &PkiCommand::Revoke(PkiRevokeArgs {
                dir: Some(dir.clone()),
                name: Some("core-back".to_owned()),
                serial: None,
                reason: "key-compromise".to_owned(),
                now: Some(1_800_000_000),
            }),
        );
        assert_eq!(report.exit, EXIT_OK, "{report:?}");
        let report = run(
            &cli(&[
                "pgctl",
                "pki",
                "verify",
                "--dir",
                path,
                "--now",
                "1800000000",
            ]),
            &PkiCommand::Verify(PkiVerifyArgs {
                dir: Some(dir.clone()),
                file: None,
                within_days: Some(30),
                now: Some(1_800_000_000),
            }),
        );
        assert_eq!(report.exit, EXIT_FAILURE, "{report:?}");
        assert!(
            report
                .stderr
                .iter()
                .any(|line| line.contains("REVOKED") || line.contains("KEY_MODE")),
            "{report:?}"
        );

        let dev = temp_dir("dev");
        let report = run(
            &cli(&[
                "pgctl",
                "pki",
                "dev",
                "--dir",
                dev.to_str().unwrap_or_default(),
            ]),
            &PkiCommand::Dev(PkiDevArgs {
                dir: Some(dev.clone()),
                days: Some(30),
                rotate: false,
                force: false,
                now: Some(1_800_000_000),
            }),
        );
        assert_eq!(report.exit, EXIT_OK, "{report:?}");
        assert!(dev.join("internal-ca.crt").is_file());
        assert!(dev.join("core-back.crt").is_file());
        assert!(dev.join("admin-back-client.crt").is_file());

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&dev);
    }

    #[test]
    fn renew_only_touches_leaves_inside_the_window() {
        let dir = temp_dir("renew-window");
        let now = 1_800_000_000;
        let paths = PkiPaths::new(&dir);
        create_ca(&paths, CaOptions::default(), now).expect("ca");
        let ca = load_ca(&paths).expect("ca");
        let mut short = CertificateSpec::new("short", "short", CertKind::Client, 5);
        short.normalize().expect("short");
        let mut long = CertificateSpec::new("long", "long", CertKind::Client, 200);
        long.normalize().expect("long");
        issue_leaf(&paths, &ca, &short, now, true, 0).expect("short");
        issue_leaf(&paths, &ca, &long, now, true, 0).expect("long");
        let list = RevocationList::default();
        write_inventory(&paths, &list).expect("inventory");

        let sha = |path: &std::path::Path| util::sha256_file(path).expect("hash");
        let ca_files: Vec<String> = [
            paths.root_cert(),
            paths.root_key(),
            paths.intermediate_cert(),
            paths.intermediate_key(),
            paths.chain(),
        ]
        .iter()
        .map(|path| sha(path))
        .collect();
        let short_before = sha(&paths.cert_path("short"));
        let long_before = sha(&paths.cert_path("long"));
        let long_key_before = sha(&paths.key_path("long"));

        let report = run(
            &cli(&[
                "pgctl",
                "pki",
                "renew",
                "--dir",
                dir.to_str().unwrap_or_default(),
            ]),
            &PkiCommand::Renew(PkiRenewArgs {
                dir: Some(dir.clone()),
                within_days: Some(30),
                now: Some(now),
            }),
        );
        assert_eq!(report.exit, EXIT_OK, "{report:?}");

        assert_ne!(
            sha(&paths.cert_path("short")),
            short_before,
            "short leaf must renew"
        );
        assert_eq!(
            sha(&paths.cert_path("long")),
            long_before,
            "long leaf must stay byte-identical"
        );
        assert_eq!(
            sha(&paths.key_path("long")),
            long_key_before,
            "long key must stay byte-identical"
        );
        let ca_after: Vec<String> = [
            paths.root_cert(),
            paths.root_key(),
            paths.intermediate_cert(),
            paths.intermediate_key(),
            paths.chain(),
        ]
        .iter()
        .map(|path| sha(path))
        .collect();
        assert_eq!(ca_after, ca_files, "renew must keep the same CA bytes");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn init_rotate_replaces_the_ca_and_reissues_leaves() {
        let dir = temp_dir("rotate");
        let now = 1_800_000_000;
        let paths = PkiPaths::new(&dir);
        create_ca(&paths, CaOptions::default(), now).expect("ca");
        let ca = load_ca(&paths).expect("ca");
        let mut spec =
            CertificateSpec::new("core-back", "core-back.internal", CertKind::Server, 90);
        spec.dns_sans = vec!["core-back.internal".to_owned()];
        spec.normalize().expect("spec");
        let before = issue_leaf(&paths, &ca, &spec, now, true, 0).expect("leaf");
        let old = CertificateSpec::new("old-client", "old-client", CertKind::Client, 90);
        issue_leaf(&paths, &ca, &old, now, true, 0).expect("old leaf");
        write_inventory(&paths, &RevocationList::default()).expect("inventory");
        revocation::revoke(&paths, RevokeSelector::Name("old-client"), "", now).expect("revoke");
        let root_before =
            inventory::inspect_certificate_file(&paths.root_cert(), "internal-ca").expect("root");

        let report = run(
            &cli(&[
                "pgctl",
                "pki",
                "init",
                "--dir",
                dir.to_str().unwrap_or_default(),
                "--rotate",
            ]),
            &PkiCommand::Init(PkiInitArgs {
                dir: Some(dir.clone()),
                root_days: DEFAULT_ROOT_DAYS,
                intermediate_days: DEFAULT_INTERMEDIATE_DAYS,
                rotate: true,
                now: Some(now),
            }),
        );
        assert_eq!(report.exit, EXIT_OK, "{report:?}");
        let root_after =
            inventory::inspect_certificate_file(&paths.root_cert(), "internal-ca").expect("root");
        assert_ne!(root_before.serial, root_after.serial, "root CA must change");
        let after = inventory::inspect_certificate_file(&paths.cert_path("core-back"), "core-back")
            .expect("leaf");
        assert_ne!(before.entry.serial, after.serial, "leaf must be re-issued");
        let intermediate_after =
            inventory::inspect_certificate_file(&paths.intermediate_cert(), "intermediate-ca")
                .expect("intermediate");
        intermediate_after
            .verify_signed_by(&root_after)
            .expect("new intermediate is signed by the new root");
        after
            .verify_signed_by(&intermediate_after)
            .expect("new leaf is signed by the new intermediate");
        revocation::verify_crl_signature(&paths, &intermediate_after, now)
            .expect("the CRL must be re-signed by the new intermediate");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn issue_requires_a_config_or_a_name() {
        let dir = temp_dir("issue-usage");
        let report = run(
            &cli(&[
                "pgctl",
                "pki",
                "issue",
                "--dir",
                dir.to_str().unwrap_or_default(),
            ]),
            &PkiCommand::Issue(PkiIssueArgs {
                dir: Some(dir.clone()),
                file: None,
                name: None,
                cn: None,
                dns: Vec::new(),
                ip: Vec::new(),
                kind: None,
                days: None,
                force: false,
            }),
        );
        assert_eq!(report.exit, EXIT_FAILURE);
        assert!(report.stderr[0].contains("--name/--cn"), "{report:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn verify_json_exits_one_with_problems() {
        let dir = temp_dir("verify-json");
        let report = run(
            &cli(&[
                "pgctl",
                "pki",
                "verify",
                "--dir",
                dir.to_str().unwrap_or_default(),
                "--json",
            ]),
            &PkiCommand::Verify(PkiVerifyArgs {
                dir: Some(dir.clone()),
                file: None,
                within_days: None,
                now: None,
            }),
        );
        assert_eq!(report.exit, EXIT_FAILURE);
        let parsed: serde_json::Value = serde_json::from_str(&report.stdout[0]).expect("json");
        assert_eq!(parsed["ok"], false);
        assert!(parsed["problems"]
            .as_array()
            .is_some_and(|rows| !rows.is_empty()));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
