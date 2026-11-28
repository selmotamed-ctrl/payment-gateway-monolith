//! Host enrolment, service installation, route-table/worker rendering and pushing (D1-T02, D1-T03,
//! D2-T02).
//!
//! Everything that touches a host is a [`Step`] list first: `pgctl` prints the exact steps by
//! default and only opens SSH with `--execute`. Credentials are delivered by systemd
//! `LoadCredential=` (AD-13); the sudo password comes from an environment variable, never argv.

#![forbid(unsafe_code)]

use std::path::{Path, PathBuf};

use pg_deploy_config::{load_toml_file, Host, ImplKind, PgctlConfig};
use pg_deploy_plan::{
    is_provisioner_managed, plan, render_systemd_unit, route_table_json, workers_json,
    writable_path, PlannedService, WorkerTarget,
};

use crate::cli::{
    Cli, EnrolArgs, HostsCommand, PushArgs, RouteTableArgs, ServiceCommand, ServiceInstallArgs,
    WorkersCommand, WorkersHandoverArgs,
};
use crate::commands::{Report, EXIT_OK, EXIT_PRECONDITION};
use crate::ssh::{
    enrol_with, CommandOutput, HostLock, KnownHosts, RemoteRunner, SshTarget, Transport,
};
use crate::util;

/// One remote action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Upload `data` to `remote` with `mode`.
    Upload {
        /// Absolute remote path.
        remote: String,
        /// Mode bits.
        mode: u32,
        /// File content.
        data: Vec<u8>,
    },
    /// Run a bash script.
    Script {
        /// Run through sudo.
        privileged: bool,
        /// Script text.
        script: String,
    },
}

/// One installation/push step.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Step {
    /// Stable step id.
    pub id: String,
    /// Human description.
    pub description: String,
    /// Action.
    pub action: Action,
}

impl Step {
    fn upload(
        id: &str,
        description: impl Into<String>,
        remote: String,
        mode: u32,
        data: Vec<u8>,
    ) -> Self {
        Self {
            id: id.to_owned(),
            description: description.into(),
            action: Action::Upload { remote, mode, data },
        }
    }

    fn script(id: &str, description: impl Into<String>, privileged: bool, script: String) -> Self {
        Self {
            id: id.to_owned(),
            description: description.into(),
            action: Action::Script { privileged, script },
        }
    }

    /// Dry-run rendering of the action.
    #[must_use]
    pub fn render(&self) -> String {
        match &self.action {
            Action::Upload { remote, mode, data } => {
                format!("upload {} ({} bytes, {:04o})", remote, data.len(), mode)
            }
            Action::Script { privileged, script } => {
                format!("{} {}", if *privileged { "sudo" } else { "bash" }, script)
            }
        }
    }
}

/// One host with its ordered steps.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostSteps {
    /// Host name from `hosts[]`.
    pub host: String,
    /// Ordered steps.
    pub steps: Vec<Step>,
}

/// Steps for installing one Rust service.
#[must_use]
pub fn install_steps(service: &PlannedService, unit: &str) -> Vec<Step> {
    let name = &service.name;
    let unit_path = format!("/etc/systemd/system/{}.service", service.systemd_unit);
    let mut steps = vec![
        Step::script(
            "create-config-dir",
            format!("create /etc/pg/{name}"),
            true,
            format!("install -d -m 0750 /etc/pg/{name}"),
        ),
        Step::script(
            "create-credentials-dir",
            format!("create /etc/pg/credentials/{name} (LoadCredential source)"),
            true,
            format!("install -d -m 0700 /etc/pg/credentials/{name}"),
        ),
    ];
    if let Some(writable) = writable_path(name) {
        steps.push(Step::script(
            "create-state-dir",
            format!("create {writable}"),
            true,
            format!("install -d -m 0750 {writable}"),
        ));
    }
    steps.push(Step::upload(
        "upload-unit",
        format!("upload {unit_path}"),
        unit_path,
        0o644,
        unit.as_bytes().to_vec(),
    ));
    steps.push(Step::script(
        "daemon-reload",
        "systemctl daemon-reload",
        true,
        "systemctl daemon-reload".to_owned(),
    ));
    steps.push(Step::script(
        "enable-start",
        format!("systemctl enable --now {}", service.systemd_unit),
        true,
        format!("systemctl enable --now {}", service.systemd_unit),
    ));
    steps.push(Step::script(
        "is-active",
        format!("systemctl is-active --quiet {}", service.systemd_unit),
        true,
        format!("systemctl is-active --quiet {}", service.systemd_unit),
    ));
    steps.push(Step::script(
        "verify-state",
        "read ActiveState/NRestarts",
        true,
        format!(
            "systemctl show --property=ActiveState,NRestarts --value {}",
            service.systemd_unit
        ),
    ));
    steps
}

/// Steps for pushing a rendered artefact to every host that consumes it.
pub fn push_steps(
    config: &PgctlConfig,
    artifact: &str,
    content: &[u8],
) -> Result<Vec<HostSteps>, String> {
    let desired = plan(config);
    let mut hosts: Vec<HostSteps> = Vec::new();
    {
        let mut push_for = |service: &PlannedService, file: &str| {
            let host = service.host.clone();
            let remote = format!("/etc/pg/{}/{file}", service.name);
            let mut steps = vec![Step::upload(
                "upload-artefact",
                format!("upload {remote}"),
                remote,
                0o644,
                content.to_vec(),
            )];
            if service.impl_ == ImplKind::Rs {
                steps.push(Step::script(
                    "reload",
                    format!("reload {}", service.systemd_unit),
                    true,
                    format!(
                        "systemctl reload {} || systemctl restart {}",
                        service.systemd_unit, service.systemd_unit
                    ),
                ));
            }
            match hosts.iter_mut().find(|entry| entry.host == host) {
                Some(entry) => entry.steps.extend(steps),
                None => hosts.push(HostSteps { host, steps }),
            }
        };

        match artifact {
            "route-table" => {
                for service in desired
                    .services
                    .iter()
                    .filter(|service| !service.upstreams.is_empty())
                {
                    push_for(service, "route-table.json");
                }
            }
            "workers" => {
                for service in desired.services.iter().filter(|service| {
                    service.name.starts_with("pg-core-back")
                        || service.name.starts_with("pg-core-sandbox")
                }) {
                    push_for(service, "workers.json");
                }
            }
            other => return Err(format!("unknown artefact '{other}' (route-table|workers)")),
        }
    }
    hosts.sort_by(|left, right| left.host.cmp(&right.host));
    Ok(hosts)
}

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn config_home() -> PathBuf {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".config"))
}

fn default_known_hosts() -> PathBuf {
    config_home().join("pgctl/known_hosts")
}

fn state_dir(explicit: &Option<PathBuf>) -> PathBuf {
    explicit.clone().unwrap_or_else(|| {
        std::env::var_os("XDG_STATE_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home().join(".local/state"))
            .join("pgctl")
    })
}

fn load_config(cli: &Cli, file: &Option<PathBuf>) -> Result<PgctlConfig, Report> {
    let path = file
        .clone()
        .or_else(|| cli.config.clone())
        .ok_or_else(|| Report::usage("this command requires --file <pgctl.toml> (or --config)"))?;
    load_toml_file(&path).map_err(|error| Report::failure(error.to_string()))
}

fn find_host<'a>(config: &'a PgctlConfig, name: &str) -> Result<&'a Host, Report> {
    config
        .hosts
        .iter()
        .find(|host| host.name == name)
        .ok_or_else(|| {
            let known: Vec<&str> = config.hosts.iter().map(|host| host.name.as_str()).collect();
            Report::failure(format!(
                "host '{name}' is not in hosts[] (known: {})",
                known.join(", ")
            ))
        })
}

fn sudo_password(env_name: &str) -> Option<String> {
    std::env::var(env_name)
        .ok()
        .filter(|password| !password.is_empty())
}

fn connect(
    config: &PgctlConfig,
    host_name: &str,
    known_hosts: &Path,
    state: &Path,
    sudo_env: &str,
    allow_unpinned: bool,
) -> Result<(RemoteRunner, HostLock, Host), Report> {
    let host = find_host(config, host_name)?.clone();
    let lock =
        HostLock::acquire(state, host_name).map_err(|error| Report::failure(error.to_string()))?;
    let known =
        KnownHosts::load(known_hosts).map_err(|error| Report::failure(error.to_string()))?;
    let target = SshTarget::from_host(&host);
    let runner = RemoteRunner::connect(&target, &known, sudo_password(sudo_env), allow_unpinned)
        .map_err(|error| Report::failure(error.to_string()))?;
    Ok((runner, lock, host))
}

fn apply(runner: &mut RemoteRunner, steps: &[Step]) -> Result<Vec<CommandOutput>, Report> {
    let mut outputs = Vec::new();
    for step in steps {
        match &step.action {
            Action::Upload { remote, mode, data } => runner
                .upload(remote, *mode, data)
                .map_err(|error| Report::failure(format!("{}: {error}", step.description)))?,
            Action::Script { privileged, script } => {
                let output = if *privileged {
                    runner.run_privileged(script, std::time::Duration::from_secs(15 * 60))
                } else {
                    runner.run_script(script, std::time::Duration::from_secs(15 * 60))
                }
                .map_err(|error| Report::failure(format!("{}: {error}", step.description)))?;
                if !output.success() {
                    return Err(Report::failure(format!(
                        "{} failed (status {})",
                        step.description, output.status
                    )));
                }
                outputs.push(output);
            }
        }
    }
    Ok(outputs)
}

/// `pgctl hosts …`.
#[must_use]
pub fn run_hosts(cli: &Cli, command: &HostsCommand) -> Report {
    match command {
        HostsCommand::Enrol(args) => run_enrol(cli, args),
    }
}

fn run_enrol(cli: &Cli, args: &EnrolArgs) -> Report {
    let config = match load_config(cli, &args.file) {
        Ok(config) => config,
        Err(report) => return report,
    };
    let host = match find_host(&config, &args.host) {
        Ok(host) => host,
        Err(report) => return report,
    };
    let known_path = args.known_hosts.clone().unwrap_or_else(default_known_hosts);
    let mut known = match KnownHosts::load(&known_path) {
        Ok(known) => known,
        Err(error) => return Report::failure(error.to_string()),
    };
    let target = SshTarget::from_host(host);
    let mut transport: Box<dyn Transport> = if target.is_local() {
        Box::new(crate::ssh::LocalTransport::new())
    } else {
        match crate::ssh::RusshTransport::connect(&target, None, true) {
            Ok(transport) => Box::new(transport),
            Err(error) => return Report::failure(error.to_string()),
        }
    };
    match enrol_with(
        transport.as_mut(),
        &mut known,
        &target.endpoint(),
        args.fingerprint.as_deref(),
        args.yes,
    ) {
        Ok(key) => {
            let _ = transport.close();
            Report::ok(vec![
                format!("{} ({})", target.name, target.endpoint()),
                format!("algorithm   {}", key.algorithm),
                format!("fingerprint {}", key.fingerprint),
                format!("pinned in   {}", known_path.display()),
            ])
        }
        Err(crate::ssh::TransportError::HostKeyUnknown { fingerprint }) => {
            let _ = transport.close();
            let mut report = Report {
                exit: EXIT_PRECONDITION,
                stdout: vec![format!("fingerprint {fingerprint}")],
                stderr: vec![
                    "compare this fingerprint with the host console, then re-run with --fingerprint <SHA256:...> or --yes".to_owned(),
                ],
            };
            if cli.json {
                report.stdout = vec![serde_json::json!({
                    "host": target.name,
                    "endpoint": target.endpoint(),
                    "fingerprint": fingerprint,
                    "confirmed": false,
                })
                .to_string()];
            }
            report
        }
        Err(error) => {
            let _ = transport.close();
            Report::failure(error.to_string())
        }
    }
}

/// `pgctl service …`.
#[must_use]
pub fn run_service(cli: &Cli, command: &ServiceCommand) -> Report {
    match command {
        ServiceCommand::Install(args) => run_service_install(cli, args),
    }
}

fn run_service_install(cli: &Cli, args: &ServiceInstallArgs) -> Report {
    let config = match load_config(cli, &args.file) {
        Ok(config) => config,
        Err(report) => return report,
    };
    let desired = plan(&config);
    let Some(service) = desired.service(&args.name) else {
        let names: Vec<&str> = desired
            .services
            .iter()
            .map(|service| service.name.as_str())
            .collect();
        return Report::failure(format!(
            "service '{}' is not in the plan (known: {})",
            args.name,
            names.join(", ")
        ));
    };
    if service.impl_ != ImplKind::Rs {
        return Report::failure(format!(
            "service '{}' is planned as {}; set impl = \"rs\" before installing a Rust unit",
            args.name,
            service.impl_.as_str()
        ));
    }
    if is_provisioner_managed(&args.name) {
        return Report::failure(format!(
            "service '{}' is provisioner-managed; pgctl does not render its unit",
            args.name
        ));
    }
    let unit = render_systemd_unit(service);
    let steps = install_steps(service, &unit);
    let host = service.host.clone();
    if !args.execute {
        let mut lines = vec![format!(
            "install {} on {} ({} steps, dry run)",
            args.name,
            host,
            steps.len()
        )];
        for step in &steps {
            lines.push(format!("  {:<20} {}", step.id, step.description));
            lines.push(format!("  {:<20} {}", "", step.render()));
        }
        lines.push(format!(
            "note: install the LoadCredential files under /etc/pg/credentials/{}/ before --execute (pki/secrets, D4)",
            args.name
        ));
        return Report::ok(lines);
    }
    let known = args.known_hosts.clone().unwrap_or_else(default_known_hosts);
    let state = state_dir(&args.state_dir);
    let (mut runner, _lock, _host) = match connect(
        &config,
        &host,
        &known,
        &state,
        &args.sudo_password_env,
        false,
    ) {
        Ok(connection) => connection,
        Err(report) => return report,
    };
    let result = apply(&mut runner, &steps);
    let _ = runner.close();
    match result {
        Ok(outputs) => {
            let verify = outputs
                .last()
                .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
                .unwrap_or_default();
            if cli.json {
                Report::ok(vec![serde_json::json!({
                    "service": args.name,
                    "host": host,
                    "steps": steps.len(),
                    "verify": verify,
                    "ok": true,
                })
                .to_string()])
            } else {
                Report::ok(vec![
                    format!("installed {} on {}", args.name, host),
                    format!("verify {verify}"),
                ])
            }
        }
        Err(report) => report,
    }
}

/// `pgctl route-table`.
#[must_use]
pub fn run_route_table(cli: &Cli, args: &RouteTableArgs) -> Report {
    let config = match load_config(cli, &args.file) {
        Ok(config) => config,
        Err(report) => return report,
    };
    let desired = plan(&config);
    let text = match route_table_json(&config, &desired) {
        Ok(text) => text,
        Err(error) => return Report::failure(error.to_string()),
    };
    let out_dir = args.out.clone().unwrap_or_else(|| PathBuf::from("."));
    let path = out_dir.join("route-table.json");
    match util::write_atomic(&path, text.as_bytes(), 0o644) {
        Ok(()) => {
            if cli.json {
                Report::ok(vec![serde_json::json!({
                    "path": path.display().to_string(),
                    "edges": desired.services.iter().filter(|service| !service.upstreams.is_empty()).count(),
                    "pools": desired.core_pools.len(),
                })
                .to_string()])
            } else {
                Report::ok(vec![format!(
                    "wrote {} ({} edge pool(s))",
                    path.display(),
                    desired
                        .services
                        .iter()
                        .filter(|service| !service.upstreams.is_empty())
                        .count()
                )])
            }
        }
        Err(error) => Report::failure(format!("{}: {error}", path.display())),
    }
}

/// `pgctl workers …`.
#[must_use]
pub fn run_workers(cli: &Cli, command: &WorkersCommand) -> Report {
    match command {
        WorkersCommand::Handover(args) => run_workers_handover(cli, args),
    }
}

fn run_workers_handover(cli: &Cli, args: &WorkersHandoverArgs) -> Report {
    let config = match load_config(cli, &args.file) {
        Ok(config) => config,
        Err(report) => return report,
    };
    let Some(target) = WorkerTarget::parse(&args.to) else {
        return Report::usage("--to must be ts or rs");
    };
    let mut scoped = config.clone();
    if !args.workers.is_empty() {
        for worker in &args.workers {
            if !scoped
                .services
                .core
                .workers
                .iter()
                .any(|name| name == worker)
            {
                return Report::failure(format!(
                    "worker '{worker}' is not in services.core.workers"
                ));
            }
        }
        scoped.services.core.workers = args.workers.clone();
    }
    let text = match workers_json(&scoped, target) {
        Ok(text) => text,
        Err(error) => return Report::failure(error.to_string()),
    };
    let out_dir = args.out.clone().unwrap_or_else(|| PathBuf::from("."));
    let path = out_dir.join("workers.json");
    match util::write_atomic(&path, text.as_bytes(), 0o644) {
        Ok(()) => {
            if cli.json {
                Report::ok(vec![serde_json::json!({
                    "path": path.display().to_string(),
                    "target": target.as_str(),
                    "workers": scoped.services.core.workers.len(),
                })
                .to_string()])
            } else {
                Report::ok(vec![format!(
                    "wrote {} ({} worker(s) -> {})",
                    path.display(),
                    scoped.services.core.workers.len(),
                    target.as_str()
                )])
            }
        }
        Err(error) => Report::failure(format!("{}: {error}", path.display())),
    }
}

/// `pgctl push`.
#[must_use]
pub fn run_push(cli: &Cli, args: &PushArgs) -> Report {
    let config = match load_config(cli, &args.file) {
        Ok(config) => config,
        Err(report) => return report,
    };
    let source_dir = args
        .source_dir
        .clone()
        .unwrap_or_else(|| PathBuf::from("."));
    let file_name = format!("{}.json", args.artifact);
    let path = source_dir.join(&file_name);
    let content = match std::fs::read(&path) {
        Ok(content) => content,
        Err(error) => return Report::failure(format!("{}: {error}", path.display())),
    };
    let hosts = match push_steps(&config, &args.artifact, &content) {
        Ok(hosts) => hosts,
        Err(message) => return Report::failure(message),
    };
    if hosts.is_empty() {
        return Report::failure(format!(
            "{} has no target services for this plan",
            args.artifact
        ));
    }
    if !args.execute {
        let mut lines = vec![format!(
            "push {} to {} host(s) (dry run)",
            args.artifact,
            hosts.len()
        )];
        for host in &hosts {
            lines.push(format!("  {}", host.host));
            for step in &host.steps {
                lines.push(format!("    {:<16} {}", step.id, step.description));
            }
        }
        return Report::ok(lines);
    }
    let known = args.known_hosts.clone().unwrap_or_else(default_known_hosts);
    let state = state_dir(&args.state_dir);
    let mut lines = Vec::new();
    for host in &hosts {
        let (mut runner, _lock, _host) = match connect(
            &config,
            &host.host,
            &known,
            &state,
            &args.sudo_password_env,
            false,
        ) {
            Ok(connection) => connection,
            Err(report) => return report,
        };
        let result = apply(&mut runner, &host.steps);
        let _ = runner.close();
        match result {
            Ok(_) => lines.push(format!(
                "{}: {} step(s) applied",
                host.host,
                host.steps.len()
            )),
            Err(report) => return report,
        }
    }
    Report {
        exit: EXIT_OK,
        stdout: lines,
        stderr: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::Cli;
    use clap::Parser;
    use pg_deploy_config::{Environment, Host, Role};

    fn cli(args: &[&str]) -> Cli {
        Cli::try_parse_from(args).unwrap_or_else(|error| panic!("{args:?}: {error}"))
    }

    fn host(name: &str, role: Role, address: &str) -> Host {
        Host {
            name: name.to_owned(),
            address: address.to_owned(),
            roles: vec![role],
            private_ip: address.to_owned(),
            ssh_user: "deploy".to_owned(),
            ssh_key: Some("~/.ssh/id_ed25519".to_owned()),
            ..Host::default()
        }
    }

    fn config() -> PgctlConfig {
        let mut config = PgctlConfig::new(Environment::Development);
        config.hosts = vec![
            host("core-1", Role::Core, "10.0.0.11"),
            host("admin-1", Role::Admin, "10.0.0.30"),
            host("merchant-1", Role::Merchant, "10.0.0.40"),
            host("checkout-1", Role::Checkout, "10.0.0.50"),
        ];
        config.services.core.implementation = ImplKind::Both;
        config.services.object_storage.enabled = true;
        config
    }

    #[test]
    fn install_steps_cover_unit_credentials_and_verification() {
        let config = config();
        let desired = plan(&config);
        let service = desired.service("pg-core-back-rs").expect("rust core");
        let unit = render_systemd_unit(service);
        let steps = install_steps(service, &unit);
        let ids: Vec<&str> = steps.iter().map(|step| step.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "create-config-dir",
                "create-credentials-dir",
                "create-state-dir",
                "upload-unit",
                "daemon-reload",
                "enable-start",
                "is-active",
                "verify-state"
            ]
        );
        assert!(unit
            .contains("LoadCredential=tls-ca:/etc/pg/credentials/pg-core-back-rs/internal-ca.crt"));
        assert!(unit.contains("LoadCredential=kms-master-key"));
        let upload = steps
            .iter()
            .find(|step| step.id == "upload-unit")
            .expect("upload");
        assert!(
            matches!(&upload.action, Action::Upload { remote, mode, .. } if remote == "/etc/systemd/system/pg-core-back-rs.service" && *mode == 0o644)
        );
        assert!(steps.iter().any(|step| step
            .render()
            .contains("systemctl enable --now pg-core-back-rs")));
    }

    #[test]
    fn push_steps_target_the_right_hosts_and_are_deterministic() {
        let config = config();
        let routes = push_steps(&config, "route-table", b"{}").expect("routes");
        assert_eq!(routes.len(), 3);
        assert!(routes.iter().all(|host| host.host != "core-1"));
        let workers = push_steps(&config, "workers", b"{}").expect("workers");
        assert_eq!(workers.len(), 1);
        assert_eq!(workers[0].host, "core-1");
        // Both core impls get a reload in coexistence.
        assert_eq!(
            workers[0].steps.len(),
            3,
            "TS upload + Rust upload + Rust reload"
        );
        let again = push_steps(&config, "route-table", b"{}").expect("routes");
        assert_eq!(routes, again);
        assert!(push_steps(&config, "nope", b"{}").is_err());
    }

    #[test]
    fn push_rejects_an_unknown_plan_target() {
        let mut config = config();
        config.hosts.clear();
        assert!(push_steps(&config, "route-table", b"{}")
            .expect("steps")
            .is_empty());
        assert!(push_steps(&config, "nope", b"{}").is_err());
    }

    #[test]
    fn route_table_and_workers_commands_write_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config_path = dir.path().join("pgctl.toml");
        std::fs::write(
            &config_path,
            toml::to_string_pretty(&config()).expect("toml"),
        )
        .expect("config");
        let out = dir.path().join("out");
        std::fs::create_dir_all(&out).expect("out");
        let report = crate::commands::execute(&cli(&[
            "pgctl",
            "route-table",
            "--file",
            config_path.to_str().unwrap_or_default(),
            "--out",
            out.to_str().unwrap_or_default(),
        ]));
        assert_eq!(report.exit, 0, "{report:?}");
        let routes = std::fs::read_to_string(out.join("route-table.json")).expect("routes");
        assert!(routes.contains("pg-admin-back"));

        let report = crate::commands::execute(&cli(&[
            "pgctl",
            "workers",
            "handover",
            "--file",
            config_path.to_str().unwrap_or_default(),
            "--to",
            "rs",
            "--out",
            out.to_str().unwrap_or_default(),
        ]));
        assert_eq!(report.exit, 0, "{report:?}");
        let workers = std::fs::read_to_string(out.join("workers.json")).expect("workers");
        assert!(workers.contains("\"target\": \"rs\""));
    }

    #[test]
    fn push_is_a_dry_run_and_names_the_edge_hosts() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config_path = dir.path().join("pgctl.toml");
        std::fs::write(
            &config_path,
            toml::to_string_pretty(&config()).expect("toml"),
        )
        .expect("config");
        std::fs::write(dir.path().join("route-table.json"), "{}").expect("artefact");
        let report = crate::commands::execute(&cli(&[
            "pgctl",
            "push",
            "--file",
            config_path.to_str().unwrap_or_default(),
            "--artifact",
            "route-table",
            "--source-dir",
            dir.path().to_str().unwrap_or_default(),
        ]));
        assert_eq!(report.exit, 0, "{report:?}");
        let text = report.stdout.join("\n");
        assert!(text.contains("admin-1"));
        assert!(text.contains("merchant-1"));
        assert!(text.contains("checkout-1"));
        assert!(!text.contains("core-1"));
    }

    #[test]
    fn service_install_prints_steps_without_connecting() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut config = config();
        config.services.object_storage.implementation = ImplKind::Rs;
        config
            .hosts
            .push(host("obj-1", Role::ObjectStorage, "10.0.0.60"));
        let config_path = dir.path().join("pgctl.toml");
        std::fs::write(&config_path, toml::to_string_pretty(&config).expect("toml"))
            .expect("config");
        let report = crate::commands::execute(&cli(&[
            "pgctl",
            "service",
            "install",
            "--file",
            config_path.to_str().unwrap_or_default(),
            "pg-object-storage-daemon",
        ]));
        assert_eq!(report.exit, 0, "{report:?}");
        let text = report.stdout.join("\n");
        assert!(text.contains("create-credentials-dir"));
        assert!(text.contains("LoadCredential"));
        assert!(text.contains("systemctl enable --now pg-object-storage-daemon"));
        assert!(text.contains("dry run"));
    }

    #[test]
    fn service_install_refuses_a_typescript_service() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config_path = dir.path().join("pgctl.toml");
        std::fs::write(
            &config_path,
            toml::to_string_pretty(&config()).expect("toml"),
        )
        .expect("config");
        let report = crate::commands::execute(&cli(&[
            "pgctl",
            "service",
            "install",
            "--file",
            config_path.to_str().unwrap_or_default(),
            "pg-admin-back",
        ]));
        assert_eq!(report.exit, 1);
        assert!(report
            .stderr
            .iter()
            .any(|line| line.contains("impl = \"rs\"")));
    }

    #[test]
    fn the_default_paths_are_xdg_compatible() {
        let known = default_known_hosts();
        assert!(known.ends_with("pgctl/known_hosts"));
        let state = state_dir(&None);
        assert!(state.ends_with("pgctl"));
    }
}
