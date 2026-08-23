//! The joining player's side: binds the address their game connects to.

use std::collections::HashMap;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::AtomicU32;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;

use crate::frame::{Frame, MAX_PAYLOAD};
use crate::metrics::{Counters, Shared};
use crate::SESSION_IDLE_SECONDS;

/// Depth of the queue towards the peer. Short on purpose: a backlog of game packets is
/// worthless, so the queue exists to smooth a hiccup and not to store a history.
const OUTBOUND_QUEUE: usize = 256;
const STREAM_CHUNK: usize = 16 * 1024;

struct Session {
    game: SocketAddr,
    last_seen: Instant,
}

/// One shared game port, bound locally so the player's game can reach it.
pub struct Listener {
    id: u32,
    address: SocketAddr,
    counters: Shared,
    inbound: mpsc::Sender<Frame>,
    tasks: Vec<JoinHandle<()>>,
}

impl Listener {
    /// Binds `ip:port` for both datagrams and streams. The game is told this address.
    ///
    /// Both are bound because which one a game uses is not knowable in advance, and
    /// binding the wrong one produces a failure the player cannot diagnose.
    pub async fn bind(
        id: u32,
        ip: IpAddr,
        port: u16,
        outbound: mpsc::Sender<Frame>,
    ) -> io::Result<Self> {
        let datagrams = Arc::new(UdpSocket::bind(SocketAddr::new(ip, port)).await?);
        let bound = datagrams.local_addr()?;
        // Bind the stream side to whatever the datagram side actually got. With an
        // explicit port these are the same; with port 0 they would otherwise differ, and
        // the address handed to the player would be right for only one of them.
        let streams = TcpListener::bind(bound).await?;
        let counters: Shared = Arc::new(Counters::default());
        let (inbound, inbox) = mpsc::channel(OUTBOUND_QUEUE);

        let sessions: Arc<Mutex<HashMap<u32, Session>>> = Arc::new(Mutex::new(HashMap::new()));
        let by_game: Arc<Mutex<HashMap<SocketAddr, u32>>> = Arc::new(Mutex::new(HashMap::new()));
        let writers: Arc<Mutex<HashMap<u32, mpsc::Sender<Vec<u8>>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let next = Arc::new(AtomicU32::new(1));

        let mut tasks = Vec::new();
        tasks.push(tokio::spawn(datagram_loop(
            id,
            datagrams.clone(),
            outbound.clone(),
            sessions.clone(),
            by_game.clone(),
            next.clone(),
            counters.clone(),
        )));
        tasks.push(tokio::spawn(stream_loop(
            id,
            streams,
            outbound.clone(),
            writers.clone(),
            next.clone(),
            counters.clone(),
        )));
        tasks.push(tokio::spawn(deliver_loop(
            inbox,
            datagrams,
            sessions,
            writers,
            counters.clone(),
        )));

        Ok(Self {
            id,
            address: bound,
            counters,
            inbound,
            tasks,
        })
    }

    pub fn id(&self) -> u32 {
        self.id
    }

    /// The address to type into the game.
    pub fn address(&self) -> SocketAddr {
        self.address
    }

    pub fn metrics(&self) -> crate::Metrics {
        self.counters.snapshot()
    }

    /// Hands a frame from the peer to the local game.
    pub async fn deliver(&self, frame: Frame) {
        let _ = self.inbound.send(frame).await;
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        for task in self.tasks.drain(..) {
            task.abort();
        }
    }
}

async fn datagram_loop(
    forward: u32,
    socket: Arc<UdpSocket>,
    outbound: mpsc::Sender<Frame>,
    sessions: Arc<Mutex<HashMap<u32, Session>>>,
    by_game: Arc<Mutex<HashMap<SocketAddr, u32>>>,
    next: Arc<AtomicU32>,
    counters: Shared,
) {
    let mut buffer = vec![0u8; MAX_PAYLOAD];
    loop {
        let Ok((read, from)) = socket.recv_from(&mut buffer).await else {
            return;
        };
        let session = {
            let mut lookup = by_game.lock().await;
            match lookup.get(&from) {
                Some(existing) => *existing,
                None => {
                    let assigned = next.fetch_add(1, Ordering::Relaxed);
                    lookup.insert(from, assigned);
                    counters.add(&counters.sessions_opened, 1);
                    assigned
                }
            }
        };
        {
            let now = Instant::now();
            let mut open = sessions.lock().await;
            open.insert(
                session,
                Session {
                    game: from,
                    last_seen: now,
                },
            );
            let idle = Duration::from_secs(SESSION_IDLE_SECONDS);
            let expired: Vec<(u32, SocketAddr)> = open
                .iter()
                .filter(|(_, entry)| now.duration_since(entry.last_seen) >= idle)
                .map(|(id, entry)| (*id, entry.game))
                .collect();
            if !expired.is_empty() {
                let mut lookup = by_game.lock().await;
                for (id, game) in expired {
                    open.remove(&id);
                    lookup.remove(&game);
                }
            }
        }
        let frame = Frame::Datagram {
            forward,
            session,
            payload: buffer[..read].to_vec(),
        };
        counters.add(&counters.datagrams_out, 1);
        counters.add(&counters.bytes_out, read as u64);
        // A full queue means the peer is not keeping up. Drop rather than wait: the game
        // has already moved on by the time a delayed packet would arrive.
        if outbound.try_send(frame).is_err() {
            counters.add(&counters.dropped, 1);
        }
    }
}

async fn stream_loop(
    forward: u32,
    listener: TcpListener,
    outbound: mpsc::Sender<Frame>,
    writers: Arc<Mutex<HashMap<u32, mpsc::Sender<Vec<u8>>>>>,
    next: Arc<AtomicU32>,
    counters: Shared,
) {
    loop {
        let Ok((socket, _)) = listener.accept().await else {
            return;
        };
        let stream = next.fetch_add(1, Ordering::Relaxed);
        counters.add(&counters.streams_opened, 1);
        let (writer_tx, writer_rx) = mpsc::channel(OUTBOUND_QUEUE);
        writers.lock().await.insert(stream, writer_tx);
        let _ = outbound.send(Frame::StreamOpen { forward, stream }).await;
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
}

/// Moves one accepted connection in both directions until either end closes.
pub(crate) async fn pump_stream(
    forward: u32,
    stream: u32,
    socket: TcpStream,
    mut writes: mpsc::Receiver<Vec<u8>>,
    outbound: mpsc::Sender<Frame>,
    writers: Arc<Mutex<HashMap<u32, mpsc::Sender<Vec<u8>>>>>,
    counters: Shared,
) {
    let (mut reader, mut writer) = socket.into_split();
    let reading = {
        let outbound = outbound.clone();
        let counters = counters.clone();
        tokio::spawn(async move {
            let mut buffer = vec![0u8; STREAM_CHUNK];
            loop {
                match reader.read(&mut buffer).await {
                    Ok(0) | Err(_) => break,
                    Ok(read) => {
                        counters.add(&counters.bytes_out, read as u64);
                        if outbound
                            .send(Frame::StreamData {
                                forward,
                                stream,
                                payload: buffer[..read].to_vec(),
                            })
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                }
            }
        })
    };

    while let Some(chunk) = writes.recv().await {
        counters.add(&counters.bytes_in, chunk.len() as u64);
        if writer.write_all(&chunk).await.is_err() {
            break;
        }
    }

    reading.abort();
    let _ = writer.shutdown().await;
    writers.lock().await.remove(&stream);
    let _ = outbound.send(Frame::StreamClose { forward, stream }).await;
}

async fn deliver_loop(
    mut inbox: mpsc::Receiver<Frame>,
    datagrams: Arc<UdpSocket>,
    sessions: Arc<Mutex<HashMap<u32, Session>>>,
    writers: Arc<Mutex<HashMap<u32, mpsc::Sender<Vec<u8>>>>>,
    counters: Shared,
) {
    while let Some(frame) = inbox.recv().await {
        match frame {
            Frame::Datagram {
                session, payload, ..
            } => {
                let target = sessions.lock().await.get(&session).map(|entry| entry.game);
                // A datagram for a session that has expired or never existed is dropped.
                // Replying to a guess would send a game's traffic to an arbitrary port.
                if let Some(game) = target {
                    counters.add(&counters.datagrams_in, 1);
                    counters.add(&counters.bytes_in, payload.len() as u64);
                    let _ = datagrams.send_to(&payload, game).await;
                }
            }
            Frame::StreamData { stream, payload, .. } => {
                let writer = writers.lock().await.get(&stream).cloned();
                if let Some(writer) = writer {
                    let _ = writer.send(payload).await;
                }
            }
            Frame::StreamClose { stream, .. } => {
                if let Some(writer) = writers.lock().await.remove(&stream) {
                    drop(writer);
                }
            }
            // A listener never receives an open: it is the side that accepts them.
            Frame::StreamOpen { .. } => {}
        }
    }
}
