//! Bridges the tunnel crate to the WebView, which owns the data channels.
//!
//! Frames cross the process boundary in both directions, which is the cost of leaving
//! WebRTC in the WebView for this stage. How they cross matters more than it looks.
//!
//! Tauri's `Channel` is the obvious way to push bytes to a WebView and the wrong one
//! here. Below a 1 KB threshold it serialises the payload to a JSON array of numbers and
//! injects it as JavaScript source for the engine to parse; above it, it performs a whole
//! `invoke` round trip. A game packet lands either side of that line depending on the
//! moment, and neither path is something to do thousands of times a second.
//!
//! So neither direction uses it. The WebView pushes with `tunnel_send`, whose raw request
//! body is bytes already, and pulls with `tunnel_drain`, which holds the call open until
//! there is something to return and answers with a raw response body. Both travel the
//! custom protocol as bytes, and the WebView keeps exactly one drain outstanding.

use std::collections::HashMap;
use std::time::Duration;

use ruyd_tunnel::{loopback_address, Connector, Frame, Listener, Metrics};
use tokio::sync::{mpsc, Mutex};

/// How long a drain waits for the first frame before answering empty. Short enough that
/// the caller is never wedged, long enough that an idle tunnel is not a busy loop.
const DRAIN_WAIT: Duration = Duration::from_millis(250);
/// Frames are coalesced into one answer up to roughly this size, so a burst costs one
/// crossing rather than one per packet.
const DRAIN_BUDGET: usize = 48 * 1024;
const QUEUE_DEPTH: usize = 1024;

/// Identifies one forward on one peer. A room host runs a connector per peer per shared
/// port, because two peers number their sessions independently and would otherwise be
/// indistinguishable.
type Key = (u16, u32);

#[derive(Default)]
struct Endpoints {
    listeners: HashMap<Key, Listener>,
    connectors: HashMap<Key, Connector>,
    /// Ports this side has shared, by forward. A connector is built the first time a peer
    /// actually sends something for one.
    shared: HashMap<u32, u16>,
}

pub struct Tunnel {
    endpoints: Mutex<Endpoints>,
    outbound: mpsc::Sender<Vec<u8>>,
    drain: Mutex<mpsc::Receiver<Vec<u8>>>,
}

impl Tunnel {
    pub fn new() -> Self {
        let (outbound, drain) = mpsc::channel(QUEUE_DEPTH);
        Self {
            endpoints: Mutex::new(Endpoints::default()),
            outbound,
            drain: Mutex::new(drain),
        }
    }
}

impl Default for Tunnel {
    fn default() -> Self {
        Self::new()
    }
}

/// Wraps a frame with the peer it belongs to, so the WebView knows which data channel to
/// put it on. Length-prefixed so several fit in one crossing.
fn envelope(peer: u16, frame: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(6 + frame.len());
    bytes.extend_from_slice(&peer.to_be_bytes());
    bytes.extend_from_slice(&(frame.len() as u32).to_be_bytes());
    bytes.extend_from_slice(frame);
    bytes
}

/// Splits a batch of envelopes. Returns nothing for anything malformed rather than a
/// partial read, so a truncated batch cannot be half-applied.
fn unwrap_envelopes(bytes: &[u8]) -> Option<Vec<(u16, Frame)>> {
    let mut out = Vec::new();
    let mut at = 0usize;
    while at < bytes.len() {
        if at + 6 > bytes.len() {
            return None;
        }
        let peer = u16::from_be_bytes(bytes[at..at + 2].try_into().ok()?);
        let length = u32::from_be_bytes(bytes[at + 2..at + 6].try_into().ok()? ) as usize;
        at += 6;
        if at + length > bytes.len() {
            return None;
        }
        // A peer sent this. A frame it cannot form is dropped, not guessed at.
        if let Some(frame) = Frame::decode(&bytes[at..at + length]) {
            out.push((peer, frame));
        }
        at += length;
    }
    Some(out)
}

/// Forwards one endpoint's frames into the shared queue, tagged with its peer.
fn tag(peer: u16, mut frames: mpsc::Receiver<Frame>, outbound: mpsc::Sender<Vec<u8>>) {
    tauri::async_runtime::spawn(async move {
        while let Some(frame) = frames.recv().await {
            if outbound.try_send(envelope(peer, &frame.encode())).is_err() {
                // The WebView is not draining fast enough. Dropping is correct for a
                // datagram and unavoidable for the rest; the alternative is unbounded
                // memory behind a stalled interface.
                continue;
            }
        }
    });
}

/// Binds the address this player's game connects to, and answers with it.
#[tauri::command]
pub async fn tunnel_open(
    state: tauri::State<'_, Tunnel>,
    peer: u16,
    forward: u32,
    slot: u8,
    port: u16,
) -> Result<String, String> {
    let (frames_tx, frames_rx) = mpsc::channel(QUEUE_DEPTH);
    let listener = Listener::bind(forward, loopback_address(slot), port, frames_tx)
        .await
        .map_err(|error| format!("Could not open {port} for this game: {error}"))?;
    let address = listener.address().to_string();
    tag(peer, frames_rx, state.outbound.clone());
    state
        .endpoints
        .lock()
        .await
        .listeners
        .insert((peer, forward), listener);
    Ok(address)
}

/// Records that a game on this machine is reachable through the room.
#[tauri::command]
pub async fn tunnel_share(
    state: tauri::State<'_, Tunnel>,
    forward: u32,
    port: u16,
) -> Result<(), String> {
    state.endpoints.lock().await.shared.insert(forward, port);
    Ok(())
}

/// Releases a forward, or with no forward every endpoint for that peer.
#[tauri::command]
pub async fn tunnel_close(
    state: tauri::State<'_, Tunnel>,
    peer: u16,
    forward: Option<u32>,
) -> Result<(), String> {
    let mut endpoints = state.endpoints.lock().await;
    match forward {
        Some(forward) => {
            endpoints.listeners.remove(&(peer, forward));
            endpoints.connectors.remove(&(peer, forward));
            endpoints.shared.remove(&forward);
        }
        None => {
            endpoints.listeners.retain(|(owner, _), _| *owner != peer);
            endpoints.connectors.retain(|(owner, _), _| *owner != peer);
        }
    }
    Ok(())
}

/// Releases everything. Called when a room ends, so a stopped room leaves no bound port.
#[tauri::command]
pub async fn tunnel_reset(state: tauri::State<'_, Tunnel>) -> Result<(), String> {
    let mut endpoints = state.endpoints.lock().await;
    endpoints.listeners.clear();
    endpoints.connectors.clear();
    endpoints.shared.clear();
    Ok(())
}

/// Takes frames the WebView received from peers. The raw request body is already bytes.
#[tauri::command]
pub async fn tunnel_send(
    state: tauri::State<'_, Tunnel>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let batch = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => unwrap_envelopes(bytes),
        _ => return Err("tunnel_send expects bytes".into()),
    };
    let Some(batch) = batch else {
        return Err("malformed frame batch".into());
    };

    let mut endpoints = state.endpoints.lock().await;
    for (peer, frame) in batch {
        let forward = frame.forward();
        let key = (peer, forward);
        if let Some(listener) = endpoints.listeners.get(&key) {
            listener.deliver(frame).await;
            continue;
        }
        if let Some(connector) = endpoints.connectors.get(&key) {
            connector.deliver(frame).await;
            continue;
        }
        // First traffic from this peer for a port this machine shares: stand up its
        // connector now. A forward nobody shared is ignored, so a peer cannot ask this
        // machine to open a socket to a port that was never offered.
        let Some(port) = endpoints.shared.get(&forward).copied() else {
            continue;
        };
        let (frames_tx, frames_rx) = mpsc::channel(QUEUE_DEPTH);
        let connector = Connector::new(forward, port, frames_tx);
        tag(peer, frames_rx, state.outbound.clone());
        connector.deliver(frame).await;
        endpoints.connectors.insert(key, connector);
    }
    Ok(())
}

/// Answers with frames bound for peers, waiting briefly rather than returning empty.
#[tauri::command]
pub async fn tunnel_drain(state: tauri::State<'_, Tunnel>) -> Result<tauri::ipc::Response, String> {
    let mut drain = state.drain.lock().await;
    let mut batch = Vec::new();
    if let Ok(Some(first)) = tokio::time::timeout(DRAIN_WAIT, drain.recv()).await {
        batch.extend_from_slice(&first);
        while batch.len() < DRAIN_BUDGET {
            match drain.try_recv() {
                Ok(next) => batch.extend_from_slice(&next),
                Err(_) => break,
            }
        }
    }
    Ok(tauri::ipc::Response::new(batch))
}

/// What the tunnel has actually carried. The architecture for this stage was chosen on
/// the understanding that keeping or changing it is decided against these.
#[tauri::command]
pub async fn tunnel_metrics(state: tauri::State<'_, Tunnel>) -> Result<Metrics, String> {
    let endpoints = state.endpoints.lock().await;
    let mut total = Metrics::default();
    let parts = endpoints
        .listeners
        .values()
        .map(|listener| listener.metrics())
        .chain(endpoints.connectors.values().map(|c| c.metrics()));
    for part in parts {
        total.datagrams_out += part.datagrams_out;
        total.datagrams_in += part.datagrams_in;
        total.bytes_out += part.bytes_out;
        total.bytes_in += part.bytes_in;
        total.dropped += part.dropped;
        total.streams_opened += part.streams_opened;
        total.sessions_opened += part.sessions_opened;
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelopes_round_trip_in_a_batch() {
        let first = Frame::Datagram {
            forward: 1,
            session: 2,
            payload: b"one".to_vec(),
        };
        let second = Frame::StreamOpen {
            forward: 3,
            stream: 4,
        };
        let mut batch = envelope(7, &first.encode());
        batch.extend_from_slice(&envelope(9, &second.encode()));
        assert_eq!(
            unwrap_envelopes(&batch),
            Some(vec![(7, first), (9, second)])
        );
    }

    #[test]
    fn a_truncated_batch_is_refused_rather_than_half_applied() {
        let frame = Frame::Datagram {
            forward: 1,
            session: 1,
            payload: b"payload".to_vec(),
        };
        let mut batch = envelope(1, &frame.encode());
        batch.pop();
        assert_eq!(unwrap_envelopes(&batch), None);
        assert_eq!(unwrap_envelopes(&[0, 1]), None);
    }

    #[test]
    fn an_empty_batch_is_valid_and_empty() {
        assert_eq!(unwrap_envelopes(&[]), Some(Vec::new()));
    }
}
