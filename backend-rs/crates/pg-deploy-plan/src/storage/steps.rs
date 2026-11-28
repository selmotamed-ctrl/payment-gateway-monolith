//! Step constructors and stable convergence predicates.
//!
//! Every helper computes an idempotency check from the rendered content, so two plans built from
//! the same input carry byte-identical checks and a converged host reports "nothing to do". The
//! executor compares the check with the marker it stores beside the managed file (chapter 7 §9).

#![forbid(unsafe_code)]

use sha2::{Digest, Sha256};

use super::model::{
    FileSpec, ProvisionStep, RestartPolicy, ScriptSpec, SqlSpec, StepApply, StepKind, VerifyExpect,
    VerifySpec,
};

/// `sha256:<hex>` of a byte string.
#[must_use]
pub fn sha256_hex(content: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content);
    let digest = hasher.finalize();
    let mut text = String::with_capacity(7 + digest.len() * 2);
    text.push_str("sha256:");
    for byte in digest {
        text.push_str(&format!("{byte:02x}"));
    }
    text
}

/// A file write step.
#[allow(clippy::too_many_arguments)]
#[must_use]
pub(crate) fn file_step(
    id: &str,
    description: impl Into<String>,
    kind: StepKind,
    path: impl Into<String>,
    mode: u32,
    owner: impl Into<String>,
    group: impl Into<String>,
    content: String,
    restart: RestartPolicy,
    secret_refs: Vec<String>,
) -> ProvisionStep {
    let path = path.into();
    let check = format!("{}:{}", sha256_hex(content.as_bytes()), path);
    ProvisionStep {
        id: id.to_owned(),
        description: description.into(),
        kind,
        sensitive: !secret_refs.is_empty(),
        restart,
        idempotency_check: check,
        apply: StepApply::WriteFile(FileSpec {
            path,
            mode,
            owner: owner.into(),
            group: group.into(),
            content,
            secret_refs,
        }),
    }
}

/// A script step.
#[must_use]
pub(crate) fn script_step(
    id: &str,
    description: impl Into<String>,
    kind: StepKind,
    privileged: bool,
    script: String,
    restart: RestartPolicy,
    secret_refs: Vec<String>,
) -> ProvisionStep {
    let check = format!("{}:{}", sha256_hex(script.as_bytes()), id);
    ProvisionStep {
        id: id.to_owned(),
        description: description.into(),
        kind,
        sensitive: !secret_refs.is_empty(),
        restart,
        idempotency_check: check,
        apply: StepApply::RunScript(ScriptSpec {
            privileged,
            script,
            secret_refs,
        }),
    }
}

/// A SQL step (private 0600 file, removed after the run).
#[allow(clippy::too_many_arguments)]
#[must_use]
pub(crate) fn sql_step(
    id: &str,
    description: impl Into<String>,
    database: impl Into<String>,
    path: impl Into<String>,
    content: String,
    secret_refs: Vec<String>,
) -> ProvisionStep {
    let database = database.into();
    let path = path.into();
    let check = format!("{}:{}:{}", sha256_hex(content.as_bytes()), database, path);
    ProvisionStep {
        id: id.to_owned(),
        description: description.into(),
        kind: StepKind::Sql,
        sensitive: !secret_refs.is_empty(),
        restart: RestartPolicy::None,
        idempotency_check: check,
        apply: StepApply::Sql(SqlSpec {
            database,
            path,
            mode: 0o600,
            content,
            secret_refs,
        }),
    }
}

/// A package step.
#[must_use]
pub(crate) fn packages_step(
    id: &str,
    description: impl Into<String>,
    debian: &[&str],
    arch: &[&str],
) -> ProvisionStep {
    ProvisionStep {
        id: id.to_owned(),
        description: description.into(),
        kind: StepKind::Packages,
        sensitive: false,
        restart: RestartPolicy::None,
        idempotency_check: format!(
            "packages:debian={};arch={}",
            debian.join(","),
            arch.join(",")
        ),
        apply: StepApply::Packages {
            debian: debian.iter().map(|name| (*name).to_owned()).collect(),
            arch: arch.iter().map(|name| (*name).to_owned()).collect(),
        },
    }
}

/// A verification step.
#[must_use]
pub(crate) fn verify_step(
    id: &str,
    description: impl Into<String>,
    command: impl Into<String>,
    expect: VerifyExpect,
) -> ProvisionStep {
    let command = command.into();
    ProvisionStep {
        id: id.to_owned(),
        description: description.into(),
        kind: StepKind::Verify,
        sensitive: false,
        restart: RestartPolicy::None,
        idempotency_check: format!("verify:{}:{}", sha256_hex(command.as_bytes()), id),
        apply: StepApply::Verify(VerifySpec { command, expect }),
    }
}

/// A systemd action step.
#[must_use]
pub(crate) fn systemd_step(
    id: &str,
    description: impl Into<String>,
    unit: impl Into<String>,
    action: super::model::UnitAction,
) -> ProvisionStep {
    let unit = unit.into();
    ProvisionStep {
        id: id.to_owned(),
        description: description.into(),
        kind: StepKind::Service,
        sensitive: false,
        restart: RestartPolicy::None,
        idempotency_check: format!("systemd:{action:?}:{unit}"),
        apply: StepApply::Systemd { unit, action },
    }
}

/// A read-only fact probe.
#[must_use]
pub(crate) fn probe_step(
    id: &str,
    description: impl Into<String>,
    command: impl Into<String>,
) -> ProvisionStep {
    let command = command.into();
    ProvisionStep {
        id: id.to_owned(),
        description: description.into(),
        kind: StepKind::Probe,
        sensitive: false,
        restart: RestartPolicy::None,
        idempotency_check: format!("probe:{}:{id}", sha256_hex(command.as_bytes())),
        apply: StepApply::Verify(VerifySpec {
            command,
            expect: VerifyExpect::ExitZero,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_content_has_identical_idempotency_checks() {
        let one = file_step(
            "config",
            "write config",
            StepKind::ConfigFile,
            "/etc/x.conf",
            0o640,
            "root",
            "root",
            "a = 1\n".to_owned(),
            RestartPolicy::Reload,
            Vec::new(),
        );
        let two = file_step(
            "config",
            "write config",
            StepKind::ConfigFile,
            "/etc/x.conf",
            0o640,
            "root",
            "root",
            "a = 1\n".to_owned(),
            RestartPolicy::Reload,
            Vec::new(),
        );
        let three = file_step(
            "config",
            "write config",
            StepKind::ConfigFile,
            "/etc/x.conf",
            0o640,
            "root",
            "root",
            "a = 2\n".to_owned(),
            RestartPolicy::Reload,
            Vec::new(),
        );
        assert_eq!(one.idempotency_check, two.idempotency_check);
        assert_ne!(one.idempotency_check, three.idempotency_check);
        assert_eq!(sha256_hex(b"").len(), "sha256:".len() + 64);
    }
}
