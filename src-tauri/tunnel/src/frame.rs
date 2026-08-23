//! Wire format for tunnelled game traffic.
//!
//! Frames are deliberately tiny and fixed-layout. One is emitted per datagram or per
//! chunk of stream, at whatever rate the game produces traffic, so anything clever here
//! is paid for thousands of times a second.
//!
//! Two channels carry them. Datagram frames go on an unordered, unreliable data channel
//! because that is what a game's UDP traffic already assumes; delivering them reliably
//! would add head-of-line blocking to packets whose value expires in milliseconds.
//! Stream frames go on the reliable channel, because a stream that loses a chunk is
//! broken rather than degraded.

/// Largest payload a single frame carries. A UDP datagram cannot exceed this and stream
/// data is chunked to it.
pub const MAX_PAYLOAD: usize = 60_000;

const KIND_DATAGRAM: u8 = 1;
const KIND_STREAM_OPEN: u8 = 2;
const KIND_STREAM_DATA: u8 = 3;
const KIND_STREAM_CLOSE: u8 = 4;

const HEADER: usize = 9;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    /// One datagram. `session` identifies the local socket that produced it, so replies
    /// find their way back to the right one.
    Datagram {
        forward: u32,
        session: u32,
        payload: Vec<u8>,
    },
    /// A game opened a connection. The far side should connect to the game.
    StreamOpen { forward: u32, stream: u32 },
    StreamData {
        forward: u32,
        stream: u32,
        payload: Vec<u8>,
    },
    StreamClose { forward: u32, stream: u32 },
}

impl Frame {
    /// Whether this frame must be delivered. Datagrams must not be: a late one is worse
    /// than a lost one.
    pub fn reliable(&self) -> bool {
        !matches!(self, Frame::Datagram { .. })
    }

    pub fn forward(&self) -> u32 {
        match self {
            Frame::Datagram { forward, .. }
            | Frame::StreamOpen { forward, .. }
            | Frame::StreamData { forward, .. }
            | Frame::StreamClose { forward, .. } => *forward,
        }
    }

    pub fn encode(&self) -> Vec<u8> {
        let (kind, forward, id, payload) = match self {
            Frame::Datagram {
                forward,
                session,
                payload,
            } => (KIND_DATAGRAM, *forward, *session, payload.as_slice()),
            Frame::StreamOpen { forward, stream } => (KIND_STREAM_OPEN, *forward, *stream, &[][..]),
            Frame::StreamData {
                forward,
                stream,
                payload,
            } => (KIND_STREAM_DATA, *forward, *stream, payload.as_slice()),
            Frame::StreamClose { forward, stream } => {
                (KIND_STREAM_CLOSE, *forward, *stream, &[][..])
            }
        };
        let mut bytes = Vec::with_capacity(HEADER + payload.len());
        bytes.push(kind);
        bytes.extend_from_slice(&forward.to_be_bytes());
        bytes.extend_from_slice(&id.to_be_bytes());
        bytes.extend_from_slice(payload);
        bytes
    }

    /// Parses a frame. Returns `None` for anything malformed: these arrive from a peer
    /// and a peer is not trusted to send well-formed input.
    pub fn decode(bytes: &[u8]) -> Option<Frame> {
        if bytes.len() < HEADER || bytes.len() - HEADER > MAX_PAYLOAD {
            return None;
        }
        let forward = u32::from_be_bytes(bytes[1..5].try_into().ok()?);
        let id = u32::from_be_bytes(bytes[5..9].try_into().ok()?);
        let payload = bytes[HEADER..].to_vec();
        match bytes[0] {
            KIND_DATAGRAM => Some(Frame::Datagram {
                forward,
                session: id,
                payload,
            }),
            // A frame that carries no payload must not arrive with one.
            KIND_STREAM_OPEN if payload.is_empty() => Some(Frame::StreamOpen {
                forward,
                stream: id,
            }),
            KIND_STREAM_DATA => Some(Frame::StreamData {
                forward,
                stream: id,
                payload,
            }),
            KIND_STREAM_CLOSE if payload.is_empty() => Some(Frame::StreamClose {
                forward,
                stream: id,
            }),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip(frame: Frame) {
        assert_eq!(Frame::decode(&frame.encode()), Some(frame));
    }

    #[test]
    fn every_frame_survives_a_round_trip() {
        round_trip(Frame::Datagram {
            forward: 1,
            session: 2,
            payload: b"payload".to_vec(),
        });
        round_trip(Frame::StreamOpen {
            forward: 3,
            stream: 4,
        });
        round_trip(Frame::StreamData {
            forward: 5,
            stream: 6,
            payload: b"chunk".to_vec(),
        });
        round_trip(Frame::StreamClose {
            forward: 7,
            stream: 8,
        });
    }

    #[test]
    fn an_empty_datagram_is_still_a_datagram() {
        // Some games use zero-length datagrams as keepalives.
        round_trip(Frame::Datagram {
            forward: 1,
            session: 1,
            payload: Vec::new(),
        });
    }

    #[test]
    fn large_identifiers_are_not_truncated() {
        round_trip(Frame::Datagram {
            forward: u32::MAX,
            session: u32::MAX - 1,
            payload: vec![0xAB; 32],
        });
    }

    #[test]
    fn only_datagrams_are_carried_unreliably() {
        // Game traffic is the only thing that would rather be lost than late.
        assert!(!Frame::Datagram {
            forward: 1,
            session: 1,
            payload: Vec::new()
        }
        .reliable());
        assert!(Frame::StreamOpen {
            forward: 1,
            stream: 1
        }
        .reliable());
        assert!(Frame::StreamData {
            forward: 1,
            stream: 1,
            payload: Vec::new()
        }
        .reliable());
        assert!(Frame::StreamClose {
            forward: 1,
            stream: 1
        }
        .reliable());
    }

    #[test]
    fn anything_malformed_is_refused() {
        // These arrive from a peer, which is not trusted to send well-formed input.
        assert_eq!(Frame::decode(&[]), None);
        assert_eq!(Frame::decode(&[1, 2, 3]), None);
        let mut short = Frame::Datagram {
            forward: 1,
            session: 1,
            payload: Vec::new(),
        }
        .encode();
        short.pop();
        assert_eq!(Frame::decode(&short), None);

        let mut unknown = Frame::StreamOpen {
            forward: 1,
            stream: 1,
        }
        .encode();
        unknown[0] = 99;
        assert_eq!(Frame::decode(&unknown), None);
    }

    #[test]
    fn a_payload_free_frame_may_not_arrive_with_one() {
        let mut smuggled = Frame::StreamOpen {
            forward: 1,
            stream: 1,
        }
        .encode();
        smuggled.extend_from_slice(b"not allowed");
        assert_eq!(Frame::decode(&smuggled), None);

        let mut closed = Frame::StreamClose {
            forward: 1,
            stream: 1,
        }
        .encode();
        closed.extend_from_slice(b"not allowed");
        assert_eq!(Frame::decode(&closed), None);
    }

    #[test]
    fn an_oversized_frame_is_refused_rather_than_allocated() {
        let mut huge = vec![KIND_DATAGRAM];
        huge.extend_from_slice(&1u32.to_be_bytes());
        huge.extend_from_slice(&1u32.to_be_bytes());
        huge.extend_from_slice(&vec![0u8; MAX_PAYLOAD + 1]);
        assert_eq!(Frame::decode(&huge), None);
    }

    #[test]
    fn the_forward_is_readable_without_matching_on_the_kind() {
        assert_eq!(
            Frame::StreamData {
                forward: 42,
                stream: 1,
                payload: Vec::new()
            }
            .forward(),
            42
        );
    }
}
