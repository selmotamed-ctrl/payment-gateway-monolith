//! Transport abstraction for the SSH runner (D1-T03).
//!
//! The runner talks to a [`Transport`], so unit tests exercise command construction, sudo-over-
//! stdin, upload hashing, timeouts and redaction with a fake, while production uses either
//! [`LocalTransport`](crate::ssh::local::LocalTransport) or the russh client.

#![forbid(unsafe_code)]

use std::fmt;
use std::time::Duration;

/// One command to execute remotely.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandSpec {
    /// Program (no shell).
    pub program: String,
    /// Arguments, never interpolated by `pgctl`.
    pub args: Vec<String>,
    /// Bytes written to stdin (sudo password and/or file content).
    pub stdin: Option<Vec<u8>>,
    /// Hard timeout.
    pub timeout: Duration,
}

impl CommandSpec {
    /// Build a command spec.
    #[must_use]
    pub fn new(program: impl Into<String>, args: Vec<String>, timeout: Duration) -> Self {
        Self {
            program: program.into(),
            args,
            stdin: None,
            timeout,
        }
    }

    /// Attach stdin.
    #[must_use]
    pub fn with_stdin(mut self, stdin: Vec<u8>) -> Self {
        self.stdin = Some(stdin);
        self
    }
}

/// Result of one command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandOutput {
    /// Exit status (`-1` when the server did not report one).
    pub status: i32,
    /// stdout bytes.
    pub stdout: Vec<u8>,
    /// stderr bytes.
    pub stderr: Vec<u8>,
}

impl CommandOutput {
    /// True when the command exited 0.
    #[must_use]
    pub fn success(&self) -> bool {
        self.status == 0
    }
}

/// The server host key, pinned by SHA-256 fingerprint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostKey {
    /// Key algorithm label (`ssh-ed25519`, ...).
    pub algorithm: String,
    /// `SHA256:...` fingerprint.
    pub fingerprint: String,
}

impl HostKey {
    /// Local-mode placeholder: there is no network peer.
    #[must_use]
    pub fn local() -> Self {
        Self {
            algorithm: "local".to_owned(),
            fingerprint: "SHA256:local".to_owned(),
        }
    }
}

/// Transport failures. Messages never contain secret values.
#[derive(Debug)]
pub enum TransportError {
    /// Local IO failed.
    Io {
        /// Path or operation.
        context: String,
        /// Underlying error.
        source: std::io::Error,
    },
    /// The command exceeded its timeout.
    Timeout(Duration),
    /// The server's host key is not pinned yet.
    HostKeyUnknown {
        /// Fingerprint the server presented.
        fingerprint: String,
    },
    /// The server's host key does not match the pinned fingerprint.
    HostKeyMismatch {
        /// Expected fingerprint.
        expected: String,
        /// Presented fingerprint.
        actual: String,
    },
    /// Authentication failed.
    Authentication(String),
    /// The SSH session is not connected.
    NotConnected,
    /// A remote command rejected the operation.
    Command {
        /// Exit status.
        status: i32,
        /// Redacted stderr.
        stderr: String,
    },
    /// The transport does not implement the operation in this build.
    Unsupported(String),
    /// russh/ssh-key error.
    Ssh(String),
    /// Another `pgctl` process holds the host lock.
    Locked(String),
}

impl fmt::Display for TransportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io { context, source } => write!(f, "{context}: {source}"),
            Self::Timeout(duration) => write!(f, "command timed out after {}s", duration.as_secs()),
            Self::HostKeyUnknown { fingerprint } => write!(
                f,
                "host key {fingerprint} is not pinned; run `pgctl hosts enrol` and confirm the fingerprint out of band"
            ),
            Self::HostKeyMismatch { expected, actual } => {
                write!(f, "host key mismatch: pinned {expected}, server presented {actual}")
            }
            Self::Authentication(message) => write!(f, "SSH authentication failed: {message}"),
            Self::NotConnected => write!(f, "SSH transport is not connected"),
            Self::Command { status, stderr } => write!(f, "remote command failed (status {status}): {stderr}"),
            Self::Unsupported(what) => write!(f, "transport does not support {what}"),
            Self::Ssh(message) => write!(f, "SSH: {message}"),
            Self::Locked(host) => write!(f, "another pgctl run holds the lock for {host}"),
        }
    }
}

impl std::error::Error for TransportError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            _ => None,
        }
    }
}

impl TransportError {
    /// Wrap an IO error.
    #[must_use]
    pub fn io(context: impl std::fmt::Display, source: std::io::Error) -> Self {
        Self::Io {
            context: context.to_string(),
            source,
        }
    }
}

/// A connected transport.
pub trait Transport {
    /// Run one command.
    fn run(&mut self, command: &CommandSpec) -> Result<CommandOutput, TransportError>;
    /// Read a remote file, refusing to buffer more than `max_bytes`.
    fn download(&mut self, remote: &str, max_bytes: usize) -> Result<Vec<u8>, TransportError>;
    /// The server host key, when the transport has one.
    fn server_key(&mut self) -> Result<HostKey, TransportError>;
    /// Close the session.
    fn close(&mut self) -> Result<(), TransportError>;
}

/// POSIX single-quote escaping for building an SSH command string.
#[must_use]
pub fn shell_quote(value: &str) -> String {
    if value.is_empty() {
        return "''".to_owned();
    }
    let mut out = String::with_capacity(value.len() + 2);
    out.push('\'');
    for ch in value.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

/// Join a program and its arguments into a shell command string.
#[must_use]
pub fn shell_join(program: &str, args: &[String]) -> String {
    let mut parts = Vec::with_capacity(args.len() + 1);
    parts.push(shell_quote(program));
    for arg in args {
        parts.push(shell_quote(arg));
    }
    parts.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting_is_posix_safe() {
        assert_eq!(shell_quote("plain"), "'plain'");
        assert_eq!(shell_quote(""), "''");
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
        assert_eq!(shell_quote("$(rm -rf /)"), "'$(rm -rf /)'");
        assert_eq!(
            shell_join("sudo", &["-S".to_owned(), "".to_owned()]),
            "'sudo' '-S' ''"
        );
    }
}
