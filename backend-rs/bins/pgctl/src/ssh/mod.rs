//! SSH runner: host-key pinning, sudo over stdin, uploads with SHA-256 verification, timeouts,
//! redaction and a per-host lock (chapter 7 §5, D1-T03).
//!
//! Real connections use russh; tests use a scripted transport. Local mode (`local://` or
//! `ssh_user = "local"`) runs through the same command shape, so nothing in the runner branches on
//! the transport.

#![forbid(unsafe_code)]
// The transport/runner surface is deliberately broader than the commands that use it today:
// D2/D3 reuse `read`, `server_key` and `run_checked`, and the tests exercise them directly.
#![allow(dead_code)]

pub mod local;
pub mod russh_client;
pub mod transport;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use pg_deploy_config::Host;

pub use local::LocalTransport;
pub use russh_client::RusshTransport;
pub use transport::{CommandOutput, CommandSpec, HostKey, Transport, TransportError};

use crate::util;
use transport::shell_quote;

/// A host `pgctl` can connect to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshTarget {
    /// Node id.
    pub name: String,
    /// SSH address, or `local://` for the local machine.
    pub address: String,
    /// SSH port.
    pub port: u16,
    /// SSH account.
    pub user: String,
    /// Private key path (never a key value).
    pub key_path: Option<PathBuf>,
    /// Reference to the sudo password (`secret:<name>`), resolved by the caller.
    pub sudo_reference: Option<String>,
}

impl SshTarget {
    /// Build from a `pgctl.toml` host.
    #[must_use]
    pub fn from_host(host: &Host) -> Self {
        Self {
            name: host.name.clone(),
            address: host.address.clone(),
            port: host.ssh_port,
            user: host.ssh_user.clone(),
            key_path: host.ssh_key.as_ref().map(PathBuf::from),
            sudo_reference: host.sudo_password.clone(),
        }
    }

    #[must_use]
    pub fn is_local(&self) -> bool {
        self.address.starts_with("local://") || self.user == "local"
    }

    /// Address without the `local://` scheme.
    #[must_use]
    pub fn connect_address(&self) -> &str {
        self.address
            .strip_prefix("local://")
            .unwrap_or(&self.address)
    }

    /// `host:port` key of the known-hosts file (`local:<name>` for the local machine).
    #[must_use]
    pub fn endpoint(&self) -> String {
        if self.is_local() {
            return format!("local:{}", self.name);
        }
        format!("{}:{}", self.connect_address(), self.port)
    }
}

/// Pinned host keys: one `host:port SHA256:...` line per host.
#[derive(Debug, Clone)]
pub struct KnownHosts {
    path: PathBuf,
    entries: BTreeMap<String, String>,
}

impl KnownHosts {
    /// Load a known-hosts file; a missing file is an empty store.
    pub fn load(path: &Path) -> Result<Self, TransportError> {
        let mut entries = BTreeMap::new();
        match std::fs::read_to_string(path) {
            Ok(text) => {
                for (index, line) in text.lines().enumerate() {
                    let line = line.trim();
                    if line.is_empty() || line.starts_with('#') {
                        continue;
                    }
                    let mut parts = line.split_whitespace();
                    let (Some(endpoint), Some(fingerprint)) = (parts.next(), parts.next()) else {
                        return Err(TransportError::io(
                            format!("{}:{}", path.display(), index + 1),
                            std::io::Error::other("expected 'host:port SHA256:...'"),
                        ));
                    };
                    entries.insert(endpoint.to_owned(), fingerprint.to_owned());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(TransportError::io(path.display(), error)),
        }
        Ok(Self {
            path: path.to_path_buf(),
            entries,
        })
    }

    /// Pinned fingerprint of an endpoint.
    #[must_use]
    pub fn fingerprint(&self, endpoint: &str) -> Option<&str> {
        self.entries.get(endpoint).map(String::as_str)
    }

    /// Pin a fingerprint.
    pub fn insert(&mut self, endpoint: impl Into<String>, fingerprint: impl Into<String>) {
        self.entries.insert(endpoint.into(), fingerprint.into());
    }

    /// Save (0600, atomic). The header lists the format.
    pub fn save(&self) -> Result<(), TransportError> {
        let mut text = String::from("# pgctl known hosts: <host>:<port> <SHA256 fingerprint>\n");
        for (endpoint, fingerprint) in &self.entries {
            text.push_str(endpoint);
            text.push(' ');
            text.push_str(fingerprint);
            text.push('\n');
        }
        util::write_atomic(&self.path, text.as_bytes(), 0o600)
            .map_err(|error| TransportError::io(self.path.display(), error))
    }
}

/// Exclusive per-host lock (`flock`), released when dropped.
#[derive(Debug)]
pub struct HostLock {
    _lock: nix::fcntl::Flock<std::fs::File>,
}

impl HostLock {
    /// Acquire the lock or fail with [`TransportError::Locked`].
    pub fn acquire(directory: &Path, host: &str) -> Result<Self, TransportError> {
        std::fs::create_dir_all(directory)
            .map_err(|error| TransportError::io(directory.display(), error))?;
        let path = directory.join(format!("{}.lock", util::sanitize_component(host)));
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&path)
            .map_err(|error| TransportError::io(path.display(), error))?;
        let lock = nix::fcntl::Flock::lock(file, nix::fcntl::FlockArg::LockExclusiveNonblock)
            .map_err(|_| TransportError::Locked(host.to_owned()))?;
        Ok(Self { _lock: lock })
    }
}

/// Replaces registered secrets in any text that leaves the runner.
#[derive(Debug, Clone, Default)]
pub struct Redactor {
    secrets: Vec<String>,
}

impl Redactor {
    #[must_use]
    pub fn new<I: IntoIterator<Item = String>>(secrets: I) -> Self {
        let mut secrets: Vec<String> = secrets
            .into_iter()
            .filter(|secret| !secret.is_empty())
            .collect();
        // Longest first so a secret that contains another is fully masked.
        secrets.sort_by_key(|secret| std::cmp::Reverse(secret.len()));
        secrets.dedup();
        Self { secrets }
    }

    #[must_use]
    pub fn redact(&self, text: &str) -> String {
        let mut out = text.to_owned();
        for secret in &self.secrets {
            out = out.replace(secret.as_str(), "***");
        }
        crate::redact::redact_line(&out)
    }
}

/// A connected runner bound to one host.
pub struct RemoteRunner {
    transport: Box<dyn Transport>,
    redactor: Redactor,
    sudo_password: Option<String>,
    default_timeout: Duration,
}

impl RemoteRunner {
    /// Connect. The pinned fingerprint comes from `known_hosts`; an unknown host is refused unless
    /// `allow_unpinned` (enrolment only).
    pub fn connect(
        target: &SshTarget,
        known_hosts: &KnownHosts,
        sudo_password: Option<String>,
        allow_unpinned: bool,
    ) -> Result<Self, TransportError> {
        let transport: Box<dyn Transport> = if target.is_local() {
            Box::new(LocalTransport::new())
        } else {
            let expected = known_hosts
                .fingerprint(&target.endpoint())
                .map(str::to_owned);
            Box::new(RusshTransport::connect(target, expected, allow_unpinned)?)
        };
        let redactor = Redactor::new(sudo_password.clone());
        Ok(Self {
            transport,
            redactor,
            sudo_password,
            default_timeout: Duration::from_secs(15 * 60),
        })
    }

    /// Run a plain (non-sudo) bash script.
    pub fn run_script(
        &mut self,
        script: &str,
        timeout: Duration,
    ) -> Result<CommandOutput, TransportError> {
        let spec = CommandSpec::new(
            "bash",
            vec![
                "-euo".to_owned(),
                "pipefail".to_owned(),
                "-c".to_owned(),
                script.to_owned(),
            ],
            timeout,
        );
        self.transport.run(&spec)
    }

    /// Run a bash script through sudo. The password (when configured) is the first stdin line.
    pub fn run_privileged(
        &mut self,
        script: &str,
        timeout: Duration,
    ) -> Result<CommandOutput, TransportError> {
        self.run_privileged_with(script, timeout, &[])
    }

    fn run_privileged_with(
        &mut self,
        script: &str,
        timeout: Duration,
        extra_stdin: &[u8],
    ) -> Result<CommandOutput, TransportError> {
        let mut stdin = Vec::new();
        let spec = if let Some(password) = &self.sudo_password {
            stdin.extend_from_slice(password.as_bytes());
            stdin.push(b'\n');
            CommandSpec::new(
                "sudo",
                vec![
                    "-S".to_owned(),
                    "-p".to_owned(),
                    String::new(),
                    "--".to_owned(),
                    "bash".to_owned(),
                    "-euo".to_owned(),
                    "pipefail".to_owned(),
                    "-c".to_owned(),
                    script.to_owned(),
                ],
                timeout,
            )
        } else {
            CommandSpec::new(
                "sudo",
                vec![
                    "-n".to_owned(),
                    "--".to_owned(),
                    "bash".to_owned(),
                    "-euo".to_owned(),
                    "pipefail".to_owned(),
                    "-c".to_owned(),
                    script.to_owned(),
                ],
                timeout,
            )
        };
        stdin.extend_from_slice(extra_stdin);
        let spec = if stdin.is_empty() {
            spec
        } else {
            spec.with_stdin(stdin)
        };
        self.transport.run(&spec)
    }

    /// Run a script and fail on a non-zero exit, returning redacted stdout.
    pub fn run_checked(
        &mut self,
        script: &str,
        timeout: Duration,
    ) -> Result<String, TransportError> {
        let output = self.run_script(script, timeout)?;
        self.checked(output)
    }

    /// Run a privileged script and fail on a non-zero exit, returning redacted stdout.
    pub fn run_privileged_checked(
        &mut self,
        script: &str,
        timeout: Duration,
    ) -> Result<String, TransportError> {
        let output = self.run_privileged(script, self.default_timeout.max(timeout))?;
        self.checked(output)
    }

    fn checked(&self, output: CommandOutput) -> Result<String, TransportError> {
        if !output.success() {
            return Err(TransportError::Command {
                status: output.status,
                stderr: self
                    .redactor
                    .redact(String::from_utf8_lossy(&output.stderr).trim_end()),
            });
        }
        Ok(self
            .redactor
            .redact(String::from_utf8_lossy(&output.stdout).trim_end()))
    }

    /// Upload bytes to a remote absolute path, then verify the remote SHA-256.
    pub fn upload(&mut self, remote: &str, mode: u32, data: &[u8]) -> Result<(), TransportError> {
        if data.len() > 64 * 1024 * 1024 {
            return Err(TransportError::Unsupported(format!(
                "upload to {remote} is over the 64 MiB cap"
            )));
        }
        let expected = util::sha256_bytes(data);
        let temp = format!("{remote}.pgctl-{}-tmp", std::process::id());
        let script = format!(
            "umask 077; install -m {mode:04o} /dev/stdin {} && mv {} {}",
            shell_quote(&temp),
            shell_quote(&temp),
            shell_quote(remote)
        );
        let output = self.run_privileged_with(&script, self.default_timeout, data)?;
        if !output.success() {
            return Err(TransportError::Command {
                status: output.status,
                stderr: self
                    .redactor
                    .redact(String::from_utf8_lossy(&output.stderr).trim_end()),
            });
        }
        let remote_hash = self.run_privileged_checked(
            &format!("sha256sum -- {}", shell_quote(remote)),
            Duration::from_secs(120),
        )?;
        let actual = remote_hash.split_whitespace().next().unwrap_or_default();
        if actual != expected {
            return Err(TransportError::Command {
                status: 0,
                stderr: format!("upload hash mismatch for {remote}"),
            });
        }
        Ok(())
    }

    /// Read a remote file with a size cap.
    pub fn read(&mut self, remote: &str, max_bytes: usize) -> Result<Vec<u8>, TransportError> {
        self.transport.download(remote, max_bytes)
    }

    /// The server key (used by `hosts enrol`).
    pub fn server_key(&mut self) -> Result<HostKey, TransportError> {
        self.transport.server_key()
    }

    pub fn close(&mut self) -> Result<(), TransportError> {
        self.transport.close()
    }
}

/// Enrolment needs an out-of-band confirmation: `yes` (or a matching `expected`) pins the key.
pub fn enrol_with(
    transport: &mut dyn Transport,
    known_hosts: &mut KnownHosts,
    endpoint: &str,
    expected: Option<&str>,
    yes: bool,
) -> Result<HostKey, TransportError> {
    let key = transport.server_key()?;
    if let Some(expected) = expected {
        if expected != key.fingerprint {
            return Err(TransportError::HostKeyMismatch {
                expected: expected.to_owned(),
                actual: key.fingerprint,
            });
        }
    } else if !yes {
        return Err(TransportError::HostKeyUnknown {
            fingerprint: key.fingerprint,
        });
    }
    known_hosts.insert(endpoint.to_owned(), key.fingerprint.clone());
    known_hosts.save()?;
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    type CommandLog = std::sync::Arc<std::sync::Mutex<Vec<CommandSpec>>>;

    struct ScriptedTransport {
        outputs: VecDeque<CommandOutput>,
        log: CommandLog,
        key: Option<HostKey>,
    }

    impl ScriptedTransport {
        fn with_outputs(outputs: Vec<CommandOutput>, log: CommandLog) -> Self {
            Self {
                outputs: outputs.into(),
                log,
                key: Some(HostKey {
                    algorithm: "ssh-ed25519".to_owned(),
                    fingerprint: "SHA256:test".to_owned(),
                }),
            }
        }

        fn push(&mut self, status: i32, stdout: &str) {
            self.outputs.push_back(CommandOutput {
                status,
                stdout: stdout.as_bytes().to_vec(),
                stderr: Vec::new(),
            });
        }
    }

    impl Transport for ScriptedTransport {
        fn run(&mut self, command: &CommandSpec) -> Result<CommandOutput, TransportError> {
            if let Ok(mut log) = self.log.lock() {
                log.push(command.clone());
            }
            Ok(self.outputs.pop_front().unwrap_or(CommandOutput {
                status: 0,
                stdout: Vec::new(),
                stderr: Vec::new(),
            }))
        }

        fn download(
            &mut self,
            _remote: &str,
            _max_bytes: usize,
        ) -> Result<Vec<u8>, TransportError> {
            Ok(b"remote".to_vec())
        }

        fn server_key(&mut self) -> Result<HostKey, TransportError> {
            self.key
                .clone()
                .ok_or_else(|| TransportError::HostKeyUnknown {
                    fingerprint: "none".to_owned(),
                })
        }

        fn close(&mut self) -> Result<(), TransportError> {
            Ok(())
        }
    }

    fn scripted_runner(
        transport: ScriptedTransport,
        sudo: Option<&str>,
    ) -> (RemoteRunner, SshTarget) {
        let target = SshTarget {
            name: "core-1".to_owned(),
            address: "10.0.0.11".to_owned(),
            port: 22,
            user: "deploy".to_owned(),
            key_path: Some(PathBuf::from("/home/deploy/.ssh/id_ed25519")),
            sudo_reference: Some("secret:core_sudo".to_owned()),
        };
        let runner = RemoteRunner {
            transport: Box::new(transport),
            redactor: Redactor::new(sudo.map(str::to_owned)),
            sudo_password: sudo.map(str::to_owned),
            default_timeout: Duration::from_secs(5),
        };
        (runner, target)
    }

    #[test]
    fn sudo_password_goes_to_stdin_never_argv() {
        let log: CommandLog = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut transport =
            ScriptedTransport::with_outputs(Vec::new(), std::sync::Arc::clone(&log));
        transport.push(0, "ok");
        let (mut runner, _) = scripted_runner(transport, Some("S3cret!"));
        runner
            .run_privileged("systemctl is-active pg-core-back", Duration::from_secs(5))
            .expect("run");
        let commands = log.lock().expect("log");
        let command = &commands[0];
        assert_eq!(command.program, "sudo");
        assert!(command.args.contains(&"-S".to_owned()));
        assert!(!command.args.iter().any(|arg| arg.contains("S3cret")));
        assert_eq!(command.stdin.as_deref(), Some(b"S3cret!\n".as_slice()));
    }

    #[test]
    fn upload_verifies_the_remote_hash_and_masks_the_password() {
        let log: CommandLog = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut transport =
            ScriptedTransport::with_outputs(Vec::new(), std::sync::Arc::clone(&log));
        transport.push(0, "");
        transport.push(0, "abc123  /etc/pg/x\n");
        let (mut runner, _) = scripted_runner(transport, Some("pw"));
        // Wrong hash for the data: the runner must reject it.
        let error = runner
            .upload("/etc/pg/x", 0o600, b"payload")
            .expect_err("hash mismatch");
        assert!(matches!(error, TransportError::Command { .. }));
        assert!(error.to_string().contains("hash mismatch"));

        let log: CommandLog = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut transport =
            ScriptedTransport::with_outputs(Vec::new(), std::sync::Arc::clone(&log));
        let expected = util::sha256_bytes(b"payload");
        transport.push(0, "");
        transport.push(0, &format!("{expected}  /etc/pg/x\n"));
        let (mut runner, _) = scripted_runner(transport, Some("pw"));
        runner
            .upload("/etc/pg/x", 0o600, b"payload")
            .expect("upload");
        let commands = log.lock().expect("log");
        assert_eq!(commands.len(), 2);
        assert!(commands[0]
            .stdin
            .as_deref()
            .is_some_and(|stdin| stdin.starts_with(b"pw\n")));
        assert!(commands[0]
            .stdin
            .as_deref()
            .is_some_and(|stdin| stdin.ends_with(b"payload")));
        assert!(commands[0]
            .args
            .iter()
            .any(|arg| arg.contains("install -m 0600")));
        assert!(!commands[0].args.iter().any(|arg| arg.contains("pw\n")));
    }

    #[test]
    fn command_failures_are_redacted() {
        let log: CommandLog = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut transport = ScriptedTransport::with_outputs(Vec::new(), log);
        transport.push(1, "");
        // stderr carries the secret; the runner must mask it.
        transport.outputs[0].stderr = b"failed with S3cret!".to_vec();
        let (mut runner, _) = scripted_runner(transport, Some("S3cret!"));
        let error = runner
            .run_checked("true", Duration::from_secs(5))
            .expect_err("failure");
        let text = error.to_string();
        assert!(text.contains("***"), "{text}");
        assert!(!text.contains("S3cret!"), "{text}");
    }

    #[test]
    fn known_hosts_round_trip_and_mode() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("pgctl.known_hosts");
        let mut hosts = KnownHosts::load(&path).expect("load");
        assert!(hosts.fingerprint("10.0.0.11:22").is_none());
        hosts.insert("10.0.0.11:22", "SHA256:abc");
        hosts.save().expect("save");
        let loaded = KnownHosts::load(&path).expect("reload");
        assert_eq!(loaded.fingerprint("10.0.0.11:22"), Some("SHA256:abc"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).expect("meta").permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn enrolment_requires_confirmation_or_a_matching_fingerprint() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("known_hosts");
        let mut hosts = KnownHosts::load(&path).expect("load");
        let log: CommandLog = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut transport = ScriptedTransport::with_outputs(Vec::new(), log);
        let error =
            enrol_with(&mut transport, &mut hosts, "h:22", None, false).expect_err("confirm");
        assert!(matches!(error, TransportError::HostKeyUnknown { .. }));
        assert!(hosts.fingerprint("h:22").is_none());

        let error = enrol_with(
            &mut transport,
            &mut hosts,
            "h:22",
            Some("SHA256:other"),
            true,
        )
        .expect_err("mismatch");
        assert!(matches!(error, TransportError::HostKeyMismatch { .. }));

        let key = enrol_with(&mut transport, &mut hosts, "h:22", None, true).expect("enrol");
        assert_eq!(key.fingerprint, "SHA256:test");
        assert_eq!(hosts.fingerprint("h:22"), Some("SHA256:test"));
        assert!(path.is_file());
    }

    #[test]
    fn the_per_host_lock_is_exclusive() {
        let dir = tempfile::tempdir().expect("tempdir");
        let first = HostLock::acquire(dir.path(), "core-1").expect("first");
        let error = HostLock::acquire(dir.path(), "core-1").expect_err("second");
        assert!(matches!(error, TransportError::Locked(_)));
        drop(first);
        let _third = HostLock::acquire(dir.path(), "core-1").expect("third");
        assert!(dir.path().join("core-1.lock").is_file());
    }
}
