//! Request logger and the bounded access-log sink.
//!
//! Port of `core-back/lib/requestLogger/index.ts`:
//!
//! - terminal line `<ISO> #<6chars> <METHOD padded to 6><path> <status> <duration> [<len>b] [← ip]`;
//! - ANSI colour only on a TTY, 5xx to stderr, 4xx to stderr as warning-equivalent (TS uses
//!   `console.warn`, which is stderr);
//! - the access-log record `{requestId, channel, method, routePattern, statusCode, durationMs,
//!   dbQueries: 0, dbDurationMs: 0, actorId: null, clientIp, createdAt}` batched into the log
//!   database (`http_access_logs`) with a bounded buffer (`STORAGE_LOG_BUFFER_MAX`, flush 250 ms).
//!
//! The logger never fails a request: a closed sink or a database error only drops rows.

#![forbid(unsafe_code)]

use std::io::{IsTerminal, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use tokio::sync::mpsc;
use tracing::warn;

/// Maximum characters of a logged path (the TS formatter does not cap; this is a safety bound).
const MAX_LOGGED_PATH: usize = 2_048;

/// One access-log row for `http_access_logs`.
#[derive(Debug, Clone, PartialEq)]
pub struct AccessLogRecord {
    pub request_id: String,
    pub channel: &'static str,
    pub method: String,
    pub route_pattern: String,
    pub status_code: i32,
    pub duration_ms: f64,
    pub client_ip: Option<String>,
    pub created_at: DateTime<Utc>,
}

/// `accessLogChannel`: which edge channel a core route belongs to.
#[must_use]
pub fn access_log_channel(path: &str) -> &'static str {
    if path.starts_with("/internal/admin") {
        "admin"
    } else if path.starts_with("/internal/merchant") {
        "merchant"
    } else if path.starts_with("/internal/checkout") {
        "checkout"
    } else {
        "webhook"
    }
}

/// `shortId`: `Math.random().toString(36).slice(2, 8)`.
#[must_use]
pub fn short_id() -> String {
    // 6 base36 characters from 32 random bits (the TS value is a float tail, so any 6 base36
    // characters are structurally identical).
    let bytes = pg_domain_auth::api_token::random_bytes();
    let value = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as u64;
    let mut text = String::new();
    let mut remaining = value;
    while text.len() < 6 {
        let digit = (remaining % 36) as u8;
        text.push(if digit < 10 {
            (b'0' + digit) as char
        } else {
            (b'a' + digit - 10) as char
        });
        remaining /= 36;
    }
    text
}

/// `formatDuration`: `123.4ms` below one second, `1.23s` above.
#[must_use]
pub fn format_duration(ms: f64) -> String {
    if ms < 1_000.0 {
        format!("{ms:.1}ms")
    } else {
        format!("{:.2}s", ms / 1_000.0)
    }
}

struct Palette {
    enabled: bool,
}

impl Palette {
    fn new(enabled: bool) -> Self {
        Self { enabled }
    }

    fn paint(&self, code: &str, text: &str) -> String {
        if self.enabled {
            format!("\x1b[{code}m{text}\x1b[0m")
        } else {
            text.to_owned()
        }
    }

    fn dim(&self, text: &str) -> String {
        self.paint("2", text)
    }
}

fn method_colour(method: &str) -> &'static str {
    match method {
        "GET" => "32",
        "POST" => "33",
        "PUT" | "PATCH" => "34",
        "DELETE" => "31",
        _ => "37",
    }
}

fn status_colour(status: u16) -> &'static str {
    match status {
        500.. => "31",
        400..=499 => "33",
        300..=399 => "36",
        200..=299 => "32",
        _ => "37",
    }
}

/// One terminal request line.
#[derive(Debug, Clone, Copy)]
pub struct RequestLine<'a> {
    pub started_at: DateTime<Utc>,
    pub short: &'a str,
    pub method: &'a str,
    pub path: &'a str,
    pub status: u16,
    pub duration_ms: f64,
    pub content_length: Option<u64>,
    pub client_ip: Option<&'a str>,
    pub colour: bool,
}

/// Format the terminal line exactly like the TS logger (ANSI only when `colour` is enabled).
#[must_use]
pub fn format_request_line(line: &RequestLine<'_>) -> String {
    let palette = Palette::new(line.colour);
    let started = line
        .started_at
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    // `${method.padEnd(6)}${requestPath}` — no separator after the padded method.
    let mut output = format!(
        "{} {}{} {} {}",
        palette.dim(&format!("{started} #{}", line.short)),
        palette.paint(method_colour(line.method), &format!("{:<6}", line.method)),
        line.path,
        palette.paint(status_colour(line.status), &line.status.to_string()),
        palette.dim(&format_duration(line.duration_ms)),
    );
    if let Some(length) = line.content_length {
        output.push_str(&format!(" {}", palette.dim(&format!("{length}b"))));
    }
    if let Some(ip) = line.client_ip {
        output.push_str(&format!(" {}", palette.dim(&format!("← {ip}"))));
    }
    output
}

/// Write one request line to stdout/stderr, matching the TS channel choice.
pub fn emit_request_line(status: u16, line: &str) {
    let colour = std::io::stdout().is_terminal();
    let line = if colour {
        line.to_owned()
    } else {
        strip_ansi(line)
    };
    if status >= 400 {
        let mut stderr = std::io::stderr().lock();
        let _ = writeln!(stderr, "{line}");
    } else {
        let mut stdout = std::io::stdout().lock();
        let _ = writeln!(stdout, "{line}");
    }
}

fn strip_ansi(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(character) = chars.next() {
        if character == '\x1b' {
            for next in chars.by_ref() {
                if next == 'm' {
                    break;
                }
            }
        } else {
            output.push(character);
        }
    }
    output
}

/// Bounded access-log sink writing to the log database.
#[derive(Debug)]
pub struct AccessLogSink {
    sender: mpsc::Sender<AccessLogRecord>,
    dropped: AtomicU64,
}

impl AccessLogSink {
    /// Spawn the flush task for a log pool. Returns `None` when no log database is configured.
    #[must_use]
    pub fn spawn(pool: sqlx::PgPool, buffer_max: usize, flush_interval_ms: u64) -> Arc<Self> {
        let capacity = buffer_max.max(1);
        let (sender, mut receiver) = mpsc::channel::<AccessLogRecord>(capacity);
        let sink = Arc::new(Self {
            sender,
            dropped: AtomicU64::new(0),
        });
        tokio::spawn(async move {
            let mut batch: Vec<AccessLogRecord> = Vec::with_capacity(capacity);
            let mut ticker =
                tokio::time::interval(Duration::from_millis(flush_interval_ms.max(10)));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tokio::select! {
                    _ = ticker.tick() => {
                        if !batch.is_empty() {
                            flush(&pool, &mut batch).await;
                        }
                    }
                    record = receiver.recv() => {
                        match record {
                            Some(record) => {
                                batch.push(record);
                                if batch.len() >= capacity {
                                    flush(&pool, &mut batch).await;
                                }
                            }
                            None => {
                                if !batch.is_empty() {
                                    flush(&pool, &mut batch).await;
                                }
                                break;
                            }
                        }
                    }
                }
            }
        });
        sink
    }

    /// Queue one record. A full buffer drops the row (the TS sink does the same at its bound).
    pub fn write(&self, record: AccessLogRecord) {
        if self.sender.try_send(record).is_err() {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Rows dropped because the buffer was full.
    #[must_use]
    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }
}

async fn flush(pool: &sqlx::PgPool, batch: &mut Vec<AccessLogRecord>) {
    if batch.is_empty() {
        return;
    }
    let rows = std::mem::take(batch);
    let mut builder: sqlx::QueryBuilder<sqlx::Postgres> = sqlx::QueryBuilder::new(
        "INSERT INTO http_access_logs (request_id, channel, method, route_pattern, status_code, duration_ms, db_queries, db_duration_ms, actor_id, client_ip, created_at) ",
    );
    builder.push_values(&rows, |mut bind, row| {
        bind.push_bind(row.request_id.as_str())
            .push_bind(row.channel)
            .push_bind(row.method.as_str())
            .push_bind(&row.route_pattern)
            .push_bind(i16::try_from(row.status_code).unwrap_or(0))
            .push_bind(i32::try_from(row.duration_ms.round() as i64).unwrap_or(i32::MAX))
            .push_bind(0_i16)
            .push_bind(0_i32)
            .push_bind(Option::<uuid::Uuid>::None)
            .push_bind(row.client_ip.as_deref())
            .push_bind(row.created_at);
    });
    if let Err(error) = builder.build().execute(pool).await {
        warn!(error = %error, rows = rows.len(), "access-log flush failed");
    }
}

/// Clamp a path before logging (a hostile request line must not flood the log).
#[must_use]
pub fn logged_path(path: &str) -> &str {
    if path.len() <= MAX_LOGGED_PATH {
        path
    } else {
        &path[..MAX_LOGGED_PATH]
    }
}

/// Wall-clock start instant used by the logger.
#[derive(Debug, Clone, Copy)]
pub struct Started {
    pub at: DateTime<Utc>,
    pub instant: Instant,
}

impl Started {
    #[must_use]
    pub fn now() -> Self {
        Self {
            at: Utc::now(),
            instant: Instant::now(),
        }
    }

    #[must_use]
    pub fn elapsed_ms(&self) -> f64 {
        self.instant.elapsed().as_secs_f64() * 1_000.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_id_is_six_base36_characters() {
        for _ in 0..20 {
            let id = short_id();
            assert_eq!(id.len(), 6);
            assert!(id
                .chars()
                .all(|character| character.is_ascii_digit() || character.is_ascii_lowercase()));
        }
    }

    #[test]
    fn durations_match_the_ts_format() {
        assert_eq!(format_duration(12.34), "12.3ms");
        assert_eq!(format_duration(999.99), "1000.0ms");
        assert_eq!(format_duration(1_234.0), "1.23s");
    }

    #[test]
    fn channel_is_derived_from_the_path() {
        assert_eq!(access_log_channel("/internal/admin/merchants"), "admin");
        assert_eq!(access_log_channel("/internal/merchant/wallets"), "merchant");
        assert_eq!(access_log_channel("/internal/checkout/pay"), "checkout");
        assert_eq!(access_log_channel("/api/public/links"), "webhook");
    }

    #[test]
    fn request_line_has_the_documented_shape() {
        let started = DateTime::parse_from_rfc3339("2026-11-28T10:00:00Z")
            .expect("date")
            .with_timezone(&Utc);
        let line = format_request_line(&RequestLine {
            started_at: started,
            short: "abc123",
            method: "GET",
            path: "/internal/admin/health",
            status: 200,
            duration_ms: 12.34,
            content_length: Some(42),
            client_ip: Some("127.0.0.1"),
            colour: false,
        });
        assert_eq!(
            line,
            "2026-11-28T10:00:00.000Z #abc123 GET   /internal/admin/health 200 12.3ms 42b ← 127.0.0.1"
        );
    }

    #[test]
    fn ansi_is_stripped_and_reapplied() {
        let painted = Palette::new(true).paint("32", "GET");
        assert_eq!(strip_ansi(&painted), "GET");
    }

    #[test]
    fn long_paths_are_clamped() {
        let path = "a".repeat(MAX_LOGGED_PATH + 10);
        assert_eq!(logged_path(&path).len(), MAX_LOGGED_PATH);
    }
}
