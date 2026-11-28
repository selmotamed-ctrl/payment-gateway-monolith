//! The checkout attempt-status SSE stream.
//!
//! Port of `core-back/api/internal/checkout.ts:1573-1645` (`GET
//! /internal/checkout/pay/:linkKey/logs/:attemptId/status`):
//!
//! - headers `content-type: text/event-stream`, `cache-control: no-cache, no-transform`,
//!   `connection: keep-alive`, `x-accel-buffering: no`;
//! - one frame per status change: `event: status\ndata: {"attemptId","reference","status",
//!   "substatus"}\n\n`;
//! - the stream closes on a terminal status (`SUCCEEDED`, `FAILED`, `EXPIRED`, `CANCELLED`,
//!   `BLOCKED`, `REFUNDED`) and after a ten-minute deadline.
//!
//! **Deviation (documented in `DEVIATIONS.md` through the module doc):** the P3 shell has no
//! realtime bus (the TS code subscribes to `subscribeRealtimeAttempt`). The stream therefore
//! polls the four columns the frame needs every two seconds — exactly the TS polling fallback —
//! instead of also listening on the bus. The frame shape and close rules are the TS ones; when
//! P5 adds the Redis bridge the poll becomes the fallback next to the subscription.

#![forbid(unsafe_code)]

use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};

use ntex::util::{Bytes, Stream};
use serde_json::json;
use sqlx::{PgPool, Row};
use tokio::sync::mpsc;
use tokio::time::{Duration, Instant};
use uuid::Uuid;

/// The statuses that close the stream (`checkout.ts:1582`).
pub(super) const TERMINAL_STATUSES: [&str; 6] = [
    "SUCCEEDED",
    "FAILED",
    "EXPIRED",
    "CANCELLED",
    "BLOCKED",
    "REFUNDED",
];

/// Poll cadence of the TS fallback (`setTimeout(..., 2000)`).
pub(super) const POLL_INTERVAL: Duration = Duration::from_secs(2);

/// Stream deadline (`Date.now() + 10 * 60 * 1000`).
pub(super) const STREAM_DEADLINE: Duration = Duration::from_secs(10 * 60);

/// One SSE connection over a bounded channel; the polling task ends when this is dropped.
pub(super) struct StatusStream {
    receiver: mpsc::Receiver<Bytes>,
}

impl Stream for StatusStream {
    type Item = Result<Bytes, io::Error>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.receiver.poll_recv(cx).map(|frame| frame.map(Ok))
    }
}

/// True when a status closes the stream.
#[must_use]
pub(super) fn is_terminal(status: &str) -> bool {
    TERMINAL_STATUSES.contains(&status)
}

/// One `event: status` frame, byte-for-byte the TS `JSON.stringify` field order.
#[must_use]
pub(super) fn status_frame(
    attempt_id: Uuid,
    reference: &str,
    status: &str,
    substatus: Option<&str>,
) -> Bytes {
    let data = json!({
        "attemptId": attempt_id.to_string(),
        "reference": reference,
        "status": status,
        "substatus": substatus,
    });
    Bytes::from(format!(
        "event: status\ndata: {data}\n\n",
        data = serde_json::to_string(&data).unwrap_or_else(|_| "{}".to_owned())
    ))
}

/// Start the polling task and return the stream response body.
///
/// `initial_status`/`initial_substatus` were read by the handler before the headers were flushed,
/// so the first frame is queued synchronously. `reference` never changes and is not re-read.
pub(super) fn open(
    pool: PgPool,
    attempt_id: Uuid,
    reference: String,
    initial_status: String,
    initial_substatus: Option<String>,
) -> StatusStream {
    open_with(
        pool,
        attempt_id,
        reference,
        initial_status,
        initial_substatus,
        POLL_INTERVAL,
    )
}

/// Test seam: the same stream with a caller-chosen poll cadence.
pub(super) fn open_with(
    pool: PgPool,
    attempt_id: Uuid,
    reference: String,
    initial_status: String,
    initial_substatus: Option<String>,
    poll_interval: Duration,
) -> StatusStream {
    let (sender, receiver) = mpsc::channel(16);
    let initial = status_frame(
        attempt_id,
        &reference,
        &initial_status,
        initial_substatus.as_deref(),
    );
    if sender.try_send(initial).is_err() {
        return StatusStream { receiver };
    }
    let stream = StatusStream { receiver };
    if is_terminal(&initial_status) {
        return stream;
    }
    tokio::spawn(poll_loop(
        pool,
        attempt_id,
        reference,
        initial_status,
        sender,
        poll_interval,
    ));
    stream
}

async fn poll_loop(
    pool: PgPool,
    attempt_id: Uuid,
    reference: String,
    initial_status: String,
    sender: mpsc::Sender<Bytes>,
    poll_interval: Duration,
) {
    let deadline = Instant::now() + STREAM_DEADLINE;
    let mut last_status = initial_status;
    loop {
        if Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(poll_interval).await;
        if sender.is_closed() {
            break;
        }
        let row = sqlx::query(
            "SELECT id, reference, status::text AS status, substatus
               FROM payment_attempts
              WHERE id = $1",
        )
        .bind(attempt_id)
        .fetch_optional(&pool)
        .await;
        let Ok(Some(row)) = row else {
            // A missing row or a database error closes the stream like a vanished attempt.
            break;
        };
        let status: String = match row.try_get("status") {
            Ok(status) => status,
            Err(_) => break,
        };
        if status == last_status {
            continue;
        }
        let substatus: Option<String> = row.try_get("substatus").ok().flatten();
        last_status = status.clone();
        if sender
            .send(status_frame(
                attempt_id,
                &reference,
                &status,
                substatus.as_deref(),
            ))
            .await
            .is_err()
        {
            break;
        }
        if is_terminal(&status) {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_matches_the_ts_shape_and_key_order() {
        let frame = status_frame(
            Uuid::parse_str("018f0000-0000-7000-8000-000000000001").expect("uuid"),
            "PG-123",
            "AWAITING_CUSTOMER",
            None,
        );
        let text = String::from_utf8_lossy(&frame);
        assert_eq!(
            text,
            "event: status\ndata: {\"attemptId\":\"018f0000-0000-7000-8000-000000000001\",\
             \"reference\":\"PG-123\",\"status\":\"AWAITING_CUSTOMER\",\"substatus\":null}\n\n"
        );
    }

    #[test]
    fn terminal_statuses_close_the_stream() {
        for status in [
            "SUCCEEDED",
            "FAILED",
            "EXPIRED",
            "CANCELLED",
            "BLOCKED",
            "REFUNDED",
        ] {
            assert!(is_terminal(status), "{status}");
        }
        for status in ["CREATED", "AUTHORIZING", "VERIFYING", "UNKNOWN"] {
            assert!(!is_terminal(status), "{status}");
        }
    }
}
