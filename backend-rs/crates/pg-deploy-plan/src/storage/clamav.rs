//! ClamAV `clamd` provisioner plan (D5-T04, AUTO-06).
//!
//! Port of `provisionClamav` (`deploy/provisioners/clamavProvisioner.ts`): one loopback-only
//! `clamd` per core host, `clamav-freshclam` for signatures, Debian's socket-activation unit
//! disabled, `StreamMaxLength` above the 25 MB KYB upload and a `zPING` health check.
//!
//! Modes: `managed` installs and converges the daemon, `external` only records the operator's
//! address (`KYB_CLAMD_ADDRESS`) and `disabled` (the default, matching the TS `eicar`/no-scanner
//! default) plans nothing. A failed first signature download is reported, not a failed deploy: the
//! updater keeps retrying and KYB documents stay PENDING.

#![forbid(unsafe_code)]

use pg_deploy_config::PgctlConfig;

use super::model::{
    codes, ProvisionFinding, ProvisionHost, ProvisionMode, ProvisionPlan, ProvisionStep,
    ProvisionTarget, RestartPolicy, StepKind, VerifyExpect,
};
use super::render::{clamd_apply_script, clamd_conf};
use super::settings::{validate_storage, ClamavMode, StorageSettings, Topology};
use super::steps::{file_step, packages_step, probe_step, script_step, verify_step};
use super::{fingerprint_of, GENERATOR};

/// Build the ClamAV plan.
#[must_use]
pub fn plan_clamav(
    config: &PgctlConfig,
    settings: &StorageSettings,
    topology: &Topology,
    mode: ProvisionMode,
) -> ProvisionPlan {
    let mut plan = ProvisionPlan {
        environment: config.deployment.environment.as_str().to_owned(),
        target: ProvisionTarget::Clamav,
        mode,
        generator: GENERATOR,
        ..ProvisionPlan::default()
    };
    plan.findings = validate_storage(settings, topology, config);
    match settings.clamav.mode {
        ClamavMode::Disabled => {
            plan.notes.push(
                "storage.clamav.mode = disabled: no scanner is installed; KYB documents stay PENDING until an operator configures one"
                    .to_owned(),
            );
        }
        ClamavMode::External => {
            plan.notes.push(format!(
                "storage.clamav.mode = external: pgctl never installs clamd; the core will call {}",
                if settings.clamav.address.is_empty() {
                    "KYB_CLAMD_ADDRESS (not set)"
                } else {
                    &settings.clamav.address
                }
            ));
            plan.notes.push(
                "the external daemon must accept the 25 MB KYB upload (StreamMaxLength >= 32M) and answer zPING"
                    .to_owned(),
            );
        }
        ClamavMode::Managed => {
            if topology.core.is_empty() {
                plan.findings.push(ProvisionFinding::error(
                    codes::HOST_MISSING,
                    "hosts",
                    "managed clamd runs on the core hosts; no host carries the core role",
                ));
                plan.fingerprint = fingerprint_of(&plan);
                return plan;
            }
            plan.notes.push(
                "clamd binds 127.0.0.1 only: a document is scanned on the host it is uploaded to and no firewall rule is needed"
                    .to_owned(),
            );
            plan.notes.push(format!(
                "hosts with less than {} MB of RAM will report memory pressure: ClamAV needs about 1.5 GB for signatures",
                settings.clamav.min_memory_mb
            ));
            for host in &topology.core {
                plan.hosts.push(ProvisionHost {
                    id: host.id.clone(),
                    address: host.address.clone(),
                    role: "clamav".to_owned(),
                    service: "pg-clamav".to_owned(),
                    port: settings.clamav.tcp_port,
                    cluster: None,
                    steps: clamav_steps(settings, &host.id),
                });
            }
        }
    }
    plan.fingerprint = fingerprint_of(&plan);
    plan
}

fn clamav_steps(settings: &StorageSettings, host: &str) -> Vec<ProvisionStep> {
    vec![
        probe_step(
            "probe-memory",
            format!(
                "read {host} memory and warn below {} MB",
                settings.clamav.min_memory_mb
            ),
            "awk '/^MemTotal:/ { printf \"%d\", $2 / 1024 }' /proc/meminfo",
        ),
        packages_step(
            "install-clamav",
            "install clamav-daemon and clamav-freshclam",
            &["clamav-daemon", "clamav-freshclam"],
            &["clamav"],
        ),
        file_step(
            "clamd-conf",
            "write /etc/clamav/clamd.conf (loopback TCP, 32M stream limit)",
            StepKind::ConfigFile,
            "/etc/clamav/clamd.conf",
            0o644,
            "root",
            "root",
            clamd_conf(&settings.clamav),
            RestartPolicy::RestartIfChanged,
            Vec::new(),
        ),
        script_step(
            "apply-clamd",
            "converge freshclam/clamd, start only when needed and wait for zPING",
            StepKind::Service,
            true,
            clamd_apply_script(true, settings.clamav.tcp_port),
            RestartPolicy::RestartIfChanged,
            Vec::new(),
        ),
        verify_step(
            "verify-zping",
            format!(
                "clamd answers zPING on 127.0.0.1:{}",
                settings.clamav.tcp_port
            ),
            clamd_ping(settings.clamav.tcp_port),
            VerifyExpect::ExitZero,
        ),
        verify_step(
            "verify-stream-limit",
            "the configured stream limit accepts the 25 MB KYB upload",
            "grep -Eq '^StreamMaxLength ([3-9][0-9]|[0-9]{3,})M$' /etc/clamav/clamd.conf"
                .to_owned(),
            VerifyExpect::ExitZero,
        ),
    ]
}

fn clamd_ping(port: u16) -> String {
    format!(
        "bash -c 'exec 3<>/dev/tcp/127.0.0.1/{port} && printf \"zPING\\0\" >&3 && read -r -t 5 -d \"\" reply <&3 && [ \"$reply\" = PONG ]'"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use pg_deploy_config::{Environment, Host, PgctlConfig, Role};

    fn config() -> PgctlConfig {
        let mut config = PgctlConfig::new(Environment::Test);
        config.hosts = vec![
            Host {
                name: "core-1".to_owned(),
                address: "10.0.0.11".to_owned(),
                private_ip: "10.0.0.11".to_owned(),
                roles: vec![Role::Core],
                ..Host::default()
            },
            Host {
                name: "core-2".to_owned(),
                address: "10.0.0.12".to_owned(),
                private_ip: "10.0.0.12".to_owned(),
                roles: vec![Role::Core],
                ..Host::default()
            },
        ];
        config
    }

    #[test]
    fn managed_clamd_plan_is_loopback_only_and_32m() {
        let config = config();
        let mut settings = StorageSettings::from_config(&config);
        settings.clamav.mode = ClamavMode::Managed;
        let topology = Topology::from_config(&config);
        let plan = plan_clamav(&config, &settings, &topology, ProvisionMode::Fresh);
        assert_eq!(plan.hosts.len(), 2);
        let text = serde_json::to_string(&plan).unwrap_or_default();
        assert!(text.contains("TCPAddr 127.0.0.1"));
        assert!(text.contains("StreamMaxLength 32M"));
        assert!(text.contains("verify-zping"));
        assert!(text.contains("/dev/tcp/127.0.0.1/3310"));
        assert!(!text.contains("0.0.0.0:3310"));
    }

    #[test]
    fn disabled_and_external_modes_plan_nothing() {
        let config = config();
        let settings = StorageSettings::from_config(&config);
        let topology = Topology::from_config(&config);
        let plan = plan_clamav(&config, &settings, &topology, ProvisionMode::Update);
        assert!(plan.hosts.is_empty());
        assert!(plan.notes.iter().any(|note| note.contains("no scanner")));

        let mut external = settings.clone();
        external.clamav.mode = ClamavMode::External;
        external.clamav.address = "10.0.0.90:3310".to_owned();
        let plan = plan_clamav(&config, &external, &topology, ProvisionMode::Update);
        assert!(plan.hosts.is_empty());
        assert!(plan
            .notes
            .iter()
            .any(|note| note.contains("10.0.0.90:3310")));
    }

    #[test]
    fn a_small_stream_limit_is_rejected() {
        let config = config();
        let mut settings = StorageSettings::from_config(&config);
        settings.clamav.mode = ClamavMode::Managed;
        settings.clamav.stream_max_mb = 8;
        let topology = Topology::from_config(&config);
        let plan = plan_clamav(&config, &settings, &topology, ProvisionMode::Update);
        assert!(plan
            .findings
            .iter()
            .any(|finding| finding.code == codes::CLAMAV_STREAM));
    }
}
