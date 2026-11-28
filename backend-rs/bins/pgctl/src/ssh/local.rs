//! Local-mode transport (`local://` or `ssh_user = "local"`).
//!
//! Commands run through the same program/args shape as SSH, with the same timeout and stdin
//! semantics, so the runner is identical in local and remote mode (chapter 7 §5).

#![forbid(unsafe_code)]

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::transport::{CommandOutput, CommandSpec, HostKey, Transport, TransportError};

/// Executes commands on this machine.
#[derive(Debug, Default)]
pub struct LocalTransport;

impl LocalTransport {
    #[must_use]
    pub fn new() -> Self {
        Self
    }
}

impl Transport for LocalTransport {
    fn run(&mut self, command: &CommandSpec) -> Result<CommandOutput, TransportError> {
        let mut child = Command::new(&command.program)
            .args(&command.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| TransportError::io(format!("spawn {}", command.program), error))?;
        if let Some(stdin) = &command.stdin {
            if let Some(mut pipe) = child.stdin.take() {
                pipe.write_all(stdin)
                    .map_err(|error| TransportError::io("write stdin", error))?;
            }
        }
        drop(child.stdin.take());
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| TransportError::io("stdout", std::io::Error::other("no stdout pipe")))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| TransportError::io("stderr", std::io::Error::other("no stderr pipe")))?;
        let out_reader = std::thread::spawn(move || {
            let mut buffer = Vec::new();
            let mut reader = stdout;
            let _ = reader.read_to_end(&mut buffer);
            buffer
        });
        let err_reader = std::thread::spawn(move || {
            let mut buffer = Vec::new();
            let mut reader = stderr;
            let _ = reader.read_to_end(&mut buffer);
            buffer
        });

        let deadline = Instant::now() + command.timeout;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if Instant::now() >= deadline => {
                    kill(child.id());
                    let _ = child.wait();
                    return Err(TransportError::Timeout(command.timeout));
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(20)),
                Err(error) => return Err(TransportError::io("wait", error)),
            }
        };
        let stdout = out_reader.join().unwrap_or_default();
        let stderr = err_reader.join().unwrap_or_default();
        Ok(CommandOutput {
            status: status.code().unwrap_or(-1),
            stdout,
            stderr,
        })
    }

    fn download(&mut self, remote: &str, max_bytes: usize) -> Result<Vec<u8>, TransportError> {
        let path = expand_home(remote);
        let metadata = std::fs::metadata(&path)
            .map_err(|error| TransportError::io(format!("stat {}", path.display()), error))?;
        if metadata.len() > max_bytes as u64 {
            return Err(TransportError::Unsupported(format!(
                "{} is {} bytes, over the {max_bytes} byte cap",
                path.display(),
                metadata.len()
            )));
        }
        std::fs::read(&path)
            .map_err(|error| TransportError::io(format!("read {}", path.display()), error))
    }

    fn server_key(&mut self) -> Result<HostKey, TransportError> {
        Ok(HostKey::local())
    }

    fn close(&mut self) -> Result<(), TransportError> {
        Ok(())
    }
}

fn kill(pid: u32) {
    if let Ok(raw) = i32::try_from(pid) {
        let _ = nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(raw),
            nix::sys::signal::Signal::SIGKILL,
        );
    }
}

fn expand_home(path: &str) -> std::path::PathBuf {
    crate::util::expand_tilde(std::path::Path::new(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(program: &str, args: &[&str]) -> CommandSpec {
        CommandSpec::new(
            program,
            args.iter().map(|arg| (*arg).to_owned()).collect(),
            Duration::from_secs(5),
        )
    }

    #[test]
    fn runs_a_command_and_captures_both_streams() {
        let mut transport = LocalTransport::new();
        let output = transport
            .run(&spec("sh", &["-c", "printf out; printf err >&2; exit 3"]))
            .expect("run");
        assert_eq!(output.status, 3);
        assert_eq!(output.stdout, b"out");
        assert_eq!(output.stderr, b"err");
    }

    #[test]
    fn passes_stdin() {
        let mut transport = LocalTransport::new();
        let spec = spec("sh", &["-c", "cat"]).with_stdin(b"payload".to_vec());
        let output = transport.run(&spec).expect("run");
        assert_eq!(output.stdout, b"payload");
    }

    #[test]
    fn enforces_the_timeout() {
        let mut transport = LocalTransport::new();
        let spec = CommandSpec::new(
            "sh",
            vec!["-c".to_owned(), "sleep 5".to_owned()],
            Duration::from_millis(100),
        );
        let error = transport.run(&spec).expect_err("timeout");
        assert!(matches!(error, TransportError::Timeout(_)));
    }

    #[test]
    fn download_is_capped() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("file");
        std::fs::write(&path, b"1234567890").expect("write");
        let mut transport = LocalTransport::new();
        assert_eq!(
            transport
                .download(path.to_str().unwrap_or_default(), 10)
                .expect("read"),
            b"1234567890"
        );
        assert!(transport
            .download(path.to_str().unwrap_or_default(), 9)
            .is_err());
    }
}
