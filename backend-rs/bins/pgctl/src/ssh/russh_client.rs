//! russh 0.65 client transport (chapter 7 §5).
//!
//! - host-key pinning: the handler rejects any key that does not match the pinned SHA-256
//!   fingerprint; enrolment is the only path that accepts an unknown key (and only to display it);
//! - public-key authentication with the per-node key from `pgctl.toml`;
//! - one channel per command, exit status + stdout/stderr, hard timeout;
//! - sudo uses stdin, never argv (the runner builds the command).

#![forbid(unsafe_code)]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client::{self, Config};
use russh::keys::{load_secret_key, HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{ChannelMsg, Disconnect};

use crate::ssh::transport::{
    shell_join, CommandOutput, CommandSpec, HostKey, Transport, TransportError,
};
use crate::ssh::SshTarget;

struct CaptureHandler {
    expected: Option<String>,
    allow_unpinned: bool,
    seen: Arc<Mutex<Option<HostKey>>>,
}

impl client::Handler for CaptureHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let info = host_key_info(server_public_key);
        if let Ok(mut guard) = self.seen.lock() {
            *guard = Some(info.clone());
        }
        match &self.expected {
            Some(expected) => Ok(&info.fingerprint == expected),
            None => Ok(self.allow_unpinned),
        }
    }
}

fn host_key_info(key: &PublicKeyOrCertificate) -> HostKey {
    match key {
        PublicKeyOrCertificate::PublicKey { key, .. } => HostKey {
            algorithm: format!("{:?}", key.algorithm()),
            fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
        },
        PublicKeyOrCertificate::Certificate(cert) => HostKey {
            algorithm: "ssh-cert".to_owned(),
            fingerprint: cert.public_key().fingerprint(HashAlg::Sha256).to_string(),
        },
    }
}

/// A russh-backed transport. Owns a current-thread Tokio runtime; all operations are blocking
/// from the CLI's point of view.
pub struct RusshTransport {
    runtime: tokio::runtime::Runtime,
    session: Option<client::Handle<CaptureHandler>>,
    seen: Arc<Mutex<Option<HostKey>>>,
}

impl std::fmt::Debug for RusshTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RusshTransport")
            .field("connected", &self.session.is_some())
            .finish()
    }
}

impl RusshTransport {
    /// Connect and authenticate. `expected` is the pinned fingerprint; `allow_unpinned` is only
    /// true for `hosts enrol`.
    pub fn connect(
        target: &SshTarget,
        expected: Option<String>,
        allow_unpinned: bool,
    ) -> Result<Self, TransportError> {
        let key_path = target.key_path.clone().ok_or_else(|| {
            TransportError::Authentication(format!(
                "no ssh_key configured for host {} (set hosts[].ssh_key)",
                target.name
            ))
        })?;
        let key = load_secret_key(crate::util::expand_tilde(&key_path), None).map_err(|error| {
            TransportError::Authentication(format!("{}: {error}", key_path.display()))
        })?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| TransportError::io("tokio runtime", error))?;
        let seen = Arc::new(Mutex::new(None));
        let handler = CaptureHandler {
            expected: expected.clone(),
            allow_unpinned,
            seen: Arc::clone(&seen),
        };
        let address = target.address.clone();
        let port = target.port;
        let user = target.user.clone();
        let result = runtime.block_on(async move {
            let mut session = client::connect(
                Arc::new(Config::default()),
                (address.as_str(), port),
                handler,
            )
            .await
            .map_err(|error| TransportError::Ssh(error.to_string()))?;
            let auth = session
                .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), None))
                .await
                .map_err(|error| TransportError::Ssh(error.to_string()))?;
            if !auth.success() {
                return Err(TransportError::Authentication(
                    "the server rejected the public key".to_owned(),
                ));
            }
            Ok::<_, TransportError>(session)
        });
        match result {
            Ok(session) => Ok(Self {
                runtime,
                session: Some(session),
                seen,
            }),
            Err(error) => {
                // Prefer a precise host-key error when the handler saw a key but refused it.
                let captured = seen.lock().ok().and_then(|guard| guard.clone());
                match (&expected, captured) {
                    (None, Some(key)) => Err(TransportError::HostKeyUnknown {
                        fingerprint: key.fingerprint,
                    }),
                    (Some(expected), Some(key)) if &key.fingerprint != expected => {
                        Err(TransportError::HostKeyMismatch {
                            expected: expected.clone(),
                            actual: key.fingerprint,
                        })
                    }
                    _ => Err(error),
                }
            }
        }
    }
}

impl Transport for RusshTransport {
    fn run(&mut self, command: &CommandSpec) -> Result<CommandOutput, TransportError> {
        let session = self.session.as_ref().ok_or(TransportError::NotConnected)?;
        let line = shell_join(&command.program, &command.args);
        let stdin = command.stdin.clone();
        let timeout = command.timeout;
        let outcome = self.runtime.block_on(async {
            tokio::time::timeout(timeout, async {
                let mut channel = session
                    .channel_open_session()
                    .await
                    .map_err(|error| TransportError::Ssh(error.to_string()))?;
                channel
                    .exec(true, line)
                    .await
                    .map_err(|error| TransportError::Ssh(error.to_string()))?;
                if let Some(data) = stdin {
                    channel
                        .data_bytes(data)
                        .await
                        .map_err(|error| TransportError::Ssh(error.to_string()))?;
                }
                channel
                    .eof()
                    .await
                    .map_err(|error| TransportError::Ssh(error.to_string()))?;
                let mut stdout = Vec::new();
                let mut stderr = Vec::new();
                let mut status = -1i32;
                while let Some(message) = channel.wait().await {
                    match message {
                        ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
                        ChannelMsg::ExtendedData { data, .. } => stderr.extend_from_slice(&data),
                        ChannelMsg::ExitStatus { exit_status } => status = exit_status as i32,
                        _ => {}
                    }
                }
                Ok::<CommandOutput, TransportError>(CommandOutput {
                    status,
                    stdout,
                    stderr,
                })
            })
            .await
        });
        match outcome {
            Ok(result) => result,
            Err(_) => Err(TransportError::Timeout(timeout)),
        }
    }

    fn download(&mut self, remote: &str, max_bytes: usize) -> Result<Vec<u8>, TransportError> {
        // Bound the remote read so a huge file cannot exhaust memory.
        let limit = max_bytes.saturating_add(1);
        let command = CommandSpec::new(
            "head",
            vec![
                "-c".to_owned(),
                limit.to_string(),
                "--".to_owned(),
                remote.to_owned(),
            ],
            Duration::from_secs(60),
        );
        let output = self.run(&command)?;
        if output.status != 0 {
            return Err(TransportError::Command {
                status: output.status,
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            });
        }
        if output.stdout.len() > max_bytes {
            return Err(TransportError::Unsupported(format!(
                "{remote} is larger than {max_bytes} bytes"
            )));
        }
        Ok(output.stdout)
    }

    fn server_key(&mut self) -> Result<HostKey, TransportError> {
        self.seen
            .lock()
            .ok()
            .and_then(|guard| guard.clone())
            .ok_or_else(|| TransportError::HostKeyUnknown {
                fingerprint: "unknown".to_owned(),
            })
    }

    fn close(&mut self) -> Result<(), TransportError> {
        if let Some(session) = self.session.take() {
            let _ = self
                .runtime
                .block_on(session.disconnect(Disconnect::ByApplication, "", "en"));
        }
        Ok(())
    }
}

impl Drop for RusshTransport {
    fn drop(&mut self) {
        let _ = self.close();
    }
}
