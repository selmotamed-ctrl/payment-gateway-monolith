//! Binary wiring.
//!
//! `pgctl` is the operator-facing entry point of the deploy engine (chapter 7 §3). This build
//! implements the D0 subset: `version`, `config validate|import|schema` and `plan`. Every other
//! documented command parses and exits with code 3 ("precondition failed: not implemented"),
//! so scripts can be written against the final surface today.

#![forbid(unsafe_code)]

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

mod cli;
mod commands;
mod commands_ops;
mod commands_provision;
mod commands_release;
mod pki;
mod redact;
mod release;
mod ssh;
mod state;
mod util;
mod watch;

use clap::Parser;

fn main() -> std::process::ExitCode {
    let cli = cli::Cli::parse();
    if cli.verbose {
        let _ = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::INFO)
            .with_writer(std::io::stderr)
            .try_init();
    }
    let report = commands::execute(&cli);
    let exit = commands::print(&report);
    std::process::ExitCode::from(exit)
}
