//! Counters for the tunnel.
//!
//! The architecture chosen for this stage sends every packet across a process boundary,
//! and was chosen on the understanding that the decision to keep or change it would be
//! made against measurements rather than a hunch. These are those measurements, so they
//! are not optional instrumentation to be added later.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

#[derive(Debug, Default)]
pub struct Counters {
    pub datagrams_out: AtomicU64,
    pub datagrams_in: AtomicU64,
    pub bytes_out: AtomicU64,
    pub bytes_in: AtomicU64,
    /// Frames dropped because the peer could not be sent to fast enough. A datagram is
    /// dropped rather than queued: a game would rather lose a packet than receive a
    /// stale one.
    pub dropped: AtomicU64,
    pub streams_opened: AtomicU64,
    pub sessions_opened: AtomicU64,
}

/// A point-in-time copy, safe to hand to the interface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Metrics {
    pub datagrams_out: u64,
    pub datagrams_in: u64,
    pub bytes_out: u64,
    pub bytes_in: u64,
    pub dropped: u64,
    pub streams_opened: u64,
    pub sessions_opened: u64,
}

impl Counters {
    pub fn snapshot(&self) -> Metrics {
        let get = |value: &AtomicU64| value.load(Ordering::Relaxed);
        Metrics {
            datagrams_out: get(&self.datagrams_out),
            datagrams_in: get(&self.datagrams_in),
            bytes_out: get(&self.bytes_out),
            bytes_in: get(&self.bytes_in),
            dropped: get(&self.dropped),
            streams_opened: get(&self.streams_opened),
            sessions_opened: get(&self.sessions_opened),
        }
    }

    pub(crate) fn add(&self, counter: &AtomicU64, amount: u64) {
        counter.fetch_add(amount, Ordering::Relaxed);
    }
}

pub(crate) type Shared = Arc<Counters>;
