//! The game host's side: opens sockets to the game that is actually running.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;

use tokio::net::{TcpStream, UdpSocket};
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;

use crate::frame::{Frame, MAX_PAYLOAD};
use crate::listen::pump_stream;
use crate::metrics::{Counters, Shared};

const OUTBOUND_QUEUE: usize = 256;

/// One shared game port, on the machine where the game is running.
///
/// Every socket it opens targets loopback. The connector cannot be asked to reach any
/// other address, so a peer cannot use a room as a way into the host's network.
pub struct Connector {
    id: u32,
    target: SocketAddr,
    counters: Shared,
    inbound: mpsc::Sender<Frame>,
    task: Option<JoinHandle<()>>,
}

impl Connector {
    pub fn new(id: u32, port: u16, outbound: mpsc::Sender<Frame>) -> Self {
        let target = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
        let counters: Shared = Arc::new(Counters::default());
        let (inbound, inbox) = mpsc::channel(OUTBOUND_QUEUE);
        let task = tokio::spawn(serve(id, target, inbox, outbound, counters.clone()));
        Self {
            id,
            target,
            counters,
            inbound,
            task: Some(task),
        }
    }

    pub fn id(&self) -> u32 {
        self.id
    }

    pub fn target(&self) -> SocketAddr {
        self.target
    }

    pub fn metrics(&self) -> crate::Metrics {
        self.counters.snapshot()
    }

    /// Hands a frame from the peer to the local game.
    pub async fn deliver(&self, frame: Frame) {
        let _ = self.inbound.send(frame).await;
    }
}

impl Drop for Connector {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

async fn serve(
    forward: u32,
    target: SocketAddr,
    mut inbox: mpsc::Receiver<Frame>,
    outbound: mpsc::Sender<Frame>,
    counters: Shared,
) {
    let sessions: Arc<Mutex<HashMap<u32, Arc<UdpSocket>>>> = Arc::new(Mutex::new(HashMap::new()));
    let writers: Arc<Mutex<HashMap<u32, mpsc::Sender<Vec<u8>>>>> =
        Arc::new(Mutex::new(HashMap::new()));

    while let Some(frame) = inbox.recv().await {
        match frame {
            Frame::Datagram {
                session, payload, ..
            } => {
                let socket = {
                    let existing = sessions.lock().await.get(&session).cloned();
                    match existing {
                        Some(socket) => Some(socket),
                        None => {
                            // Each remote session gets its own socket, so the game sees
                            // one distinct client per remote client and replies to the
                            // right one.
                            match UdpSocket::bind(SocketAddr::new(
                                IpAddr::V4(Ipv4Addr::LOCALHOST),
                                0,
                            ))
                            .await
                            {
                                Ok(socket) => {
                                    let socket = Arc::new(socket);
                                    sessions.lock().await.insert(session, socket.clone());
                                    counters.add(&counters.sessions_opened, 1);
                                    tokio::spawn(datagram_replies(
                                        forward,
                                        session,
                                        socket.clone(),
                                        outbound.clone(),
                                        counters.clone(),
                                    ));
                                    Some(socket)
                                }
                                Err(_) => None,
                            }
                        }
                    }
                };
                if let Some(socket) = socket {
                    counters.add(&counters.datagrams_in, 1);
                    counters.add(&counters.bytes_in, payload.len() as u64);
                    let _ = socket.send_to(&payload, target).await;
                }
            }
            Frame::StreamOpen { stream, .. } => {
                let Ok(socket) = TcpStream::connect(target).await else {
                    // The game is not listening. Tell the far side rather than leaving
                    // its player watching a connection that never completes.
                    let _ = outbound.send(Frame::StreamClose { forward, stream }).await;
                    continue;
                };
                counters.add(&counters.streams_opened, 1);
                let (writer_tx, writer_rx) = mpsc::channel(OUTBOUND_QUEUE);
                writers.lock().await.insert(stream, writer_tx);
                tokio::spawn(pump_stream(
                    forward,
                    stream,
                    socket,
                    writer_rx,
                    outbound.clone(),
                    writers.clone(),
                    counters.clone(),
                ));
            }
            Frame::StreamData { stream, payload, .. } => {
                let writer = writers.lock().await.get(&stream).cloned();
                if let Some(writer) = writer {
                    let _ = writer.send(payload).await;
                }
            }
            Frame::StreamClose { stream, .. } => {
                writers.lock().await.remove(&stream);
            }
        }
    }
}

async fn datagram_replies(
    forward: u32,
    session: u32,
    socket: Arc<UdpSocket>,
    outbound: mpsc::Sender<Frame>,
    counters: Shared,
) {
    let mut buffer = vec![0u8; MAX_PAYLOAD];
    loop {
        let Ok((read, _)) = socket.recv_from(&mut buffer).await else {
            return;
        };
        counters.add(&counters.datagrams_out, 1);
        counters.add(&counters.bytes_out, read as u64);
        if outbound
            .try_send(Frame::Datagram {
                forward,
                session,
                payload: buffer[..read].to_vec(),
            })
            .is_err()
        {
            counters.add(&counters.dropped, 1);
        }
    }
}
