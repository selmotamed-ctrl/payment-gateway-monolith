//! Server-Sent Events hub. Every rail call, injected fault and webhook delivery is broadcast to
//! every connected tester dashboard. Ported from `api/portal/eventHub.ts`.

#![forbid(unsafe_code)]

use std::pin::Pin;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use ntex::util::{Bytes, Stream};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio::time::{Duration, Sleep};

#[derive(Debug, Clone, Serialize)]
pub struct PortalEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub at: String,
    pub payload: Value,
}

impl PortalEvent {
    #[must_use]
    pub fn frame(&self) -> Bytes {
        let data = serde_json::to_string(self).unwrap_or_else(|_| "{}".to_owned());
        Bytes::from(format!("event: {}\ndata: {data}\n\n", self.event_type))
    }
}

type Client = (u64, mpsc::Sender<PortalEvent>);

#[derive(Clone)]
pub struct Hub {
    clients: Arc<Mutex<Vec<Client>>>,
    counter: Arc<AtomicU64>,
    client_count: Arc<AtomicUsize>,
}

impl std::fmt::Debug for Hub {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Hub")
            .field("clients", &self.client_count())
            .finish()
    }
}

impl Default for Hub {
    fn default() -> Self {
        Self::new()
    }
}

impl Hub {
    #[must_use]
    pub fn new() -> Self {
        Self {
            clients: Arc::new(Mutex::new(Vec::new())),
            counter: Arc::new(AtomicU64::new(1)),
            client_count: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub fn broadcast(&self, event_type: &str, payload: Value) {
        let event = PortalEvent {
            event_type: event_type.to_owned(),
            at: crate::db::now_iso(),
            payload,
        };
        let Ok(mut clients) = self.clients.lock() else {
            return;
        };
        clients.retain(|(_, sender)| match sender.try_send(event.clone()) {
            Ok(()) => true,
            Err(mpsc::error::TrySendError::Full(_)) => true,
            Err(mpsc::error::TrySendError::Closed(_)) => false,
        });
    }

    #[must_use]
    pub fn subscribe(&self) -> SseStream {
        let (sender, receiver) = mpsc::channel(256);
        let id = self.counter.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut clients) = self.clients.lock() {
            clients.push((id, sender));
        }
        self.client_count.fetch_add(1, Ordering::SeqCst);
        SseStream {
            receiver,
            clients: self.clients.clone(),
            client_count: self.client_count.clone(),
            id,
            ready_pending: true,
            heartbeat: Box::pin(tokio::time::sleep(Duration::from_secs(15))),
        }
    }

    #[must_use]
    pub fn client_count(&self) -> usize {
        self.client_count.load(Ordering::SeqCst)
    }
}

/// One SSE connection: the `ready` frame, then every broadcast event and a 15 s keepalive
/// comment.
pub struct SseStream {
    receiver: mpsc::Receiver<PortalEvent>,
    clients: Arc<Mutex<Vec<Client>>>,
    client_count: Arc<AtomicUsize>,
    id: u64,
    ready_pending: bool,
    heartbeat: Pin<Box<Sleep>>,
}

impl Stream for SseStream {
    type Item = Result<Bytes, std::io::Error>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if self.ready_pending {
            self.ready_pending = false;
            let ready = PortalEvent {
                event_type: "ready".to_owned(),
                at: crate::db::now_iso(),
                payload: json!({"type": "ready", "at": crate::db::now_iso()}),
            };
            return Poll::Ready(Some(Ok(ready.frame())));
        }
        match self.receiver.poll_recv(cx) {
            Poll::Ready(Some(event)) => Poll::Ready(Some(Ok(event.frame()))),
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => {
                if let Poll::Ready(()) = std::future::Future::poll(self.heartbeat.as_mut(), cx) {
                    self.heartbeat = Box::pin(tokio::time::sleep(Duration::from_secs(15)));
                    let ping = Bytes::from(format!(
                        ": ping {}\n\n",
                        chrono::Utc::now().timestamp_millis()
                    ));
                    return Poll::Ready(Some(Ok(ping)));
                }
                Poll::Pending
            }
        }
    }
}

impl Drop for SseStream {
    fn drop(&mut self) {
        if let Ok(mut clients) = self.clients.lock() {
            clients.retain(|(id, _)| *id != self.id);
        }
        self.client_count.fetch_sub(1, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn poll_once<S: Stream + Unpin>(stream: &mut S) -> Option<S::Item> {
        let mut context = Context::from_waker(std::task::Waker::noop());
        match Pin::new(stream).poll_next(&mut context) {
            Poll::Ready(item) => item,
            Poll::Pending => None,
        }
    }

    #[tokio::test]
    async fn ready_frame_and_broadcast_frames() {
        let hub = Hub::new();
        let mut stream = hub.subscribe();
        let ready = poll_once(&mut stream).expect("ready").expect("bytes");
        assert!(String::from_utf8_lossy(&ready).starts_with("event: ready\ndata: "));
        hub.broadcast("rail.request", json!({"phase": "INITIATE"}));
        let event = poll_once(&mut stream).expect("event").expect("bytes");
        let text = String::from_utf8_lossy(&event);
        assert!(text.starts_with("event: rail.request\ndata: "));
        assert!(text.contains("\"phase\":\"INITIATE\""));
        assert_eq!(hub.client_count(), 1);
    }

    #[tokio::test]
    async fn frame_shape_matches_the_ts_event_hub() {
        let hub = Hub::new();
        let mut stream = hub.subscribe();
        let _ = poll_once(&mut stream);
        hub.broadcast("scenario.updated", json!({"railCode": "edfali"}));
        let frame = poll_once(&mut stream).expect("frame").expect("bytes");
        let text = String::from_utf8_lossy(&frame);
        assert!(text.contains("\"type\":\"scenario.updated\""));
        assert!(text.contains("\"at\":\""));
        assert!(text.ends_with("\n\n"));
    }

    #[tokio::test]
    async fn dropped_clients_are_removed_on_broadcast() {
        let hub = Hub::new();
        let stream = hub.subscribe();
        assert_eq!(hub.client_count(), 1);
        drop(stream);
        assert_eq!(hub.client_count(), 0);
        hub.broadcast("noop", json!({}));
        assert!(hub
            .clients
            .lock()
            .map(|clients| clients.is_empty())
            .unwrap_or(false));
    }
}
