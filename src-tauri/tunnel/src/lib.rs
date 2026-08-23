//! Carries a game's traffic between two Ruyd peers.
//!
//! One side runs a [`Listener`]: it binds the address a player types into their game's
//! *Join by IP* box. The other runs a [`Connector`]: it opens sockets to the game that is
//! actually running. Between them the two exchange [`Frame`]s, and this crate neither
//! knows nor cares how those get across — Ruyd puts them on a WebRTC data channel.
//!
//! Nothing here is privileged. The listener binds a loopback address, which needs no
//! administrator rights, and the connector only ever talks to `127.0.0.1`. Neither side
//! creates a network adapter, adds a route, or touches a firewall rule.

use std::net::{IpAddr, Ipv4Addr};

mod connect;
mod frame;
mod listen;
mod metrics;

pub use connect::Connector;
pub use frame::{Frame, MAX_PAYLOAD};
pub use listen::Listener;
pub use metrics::{Counters, Metrics};

/// How long a datagram session survives without traffic before its socket is released.
/// A game's client port is ephemeral, so without this the map grows for as long as the
/// room lasts.
pub const SESSION_IDLE_SECONDS: u64 = 120;

/// The loopback address presented for the nth remote peer.
///
/// Each peer gets a distinct address so a game's port can stay exactly what the game
/// expects, and so several peers can share one without colliding. `127.71.0.0` and
/// `.0.1` are skipped: the first is a network address and the second is the real
/// loopback, which the game itself is probably already using.
pub fn loopback_address(peer: u8) -> IpAddr {
    IpAddr::V4(Ipv4Addr::new(127, 71, 0, peer.saturating_add(2)))
}
