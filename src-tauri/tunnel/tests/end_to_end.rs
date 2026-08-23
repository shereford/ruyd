//! Drives the whole data path over real sockets.
//!
//! A `Listener` and a `Connector` are wired straight to each other, standing in for the
//! data channel that carries frames in the product. On one side a fake game client sends
//! to the address a player would type in; on the other a fake game receives it and
//! replies. Nothing is mocked but the transport.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use ruyd_tunnel::{loopback_address, Connector, Frame, Listener};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener as TokioTcpListener, TcpStream, UdpSocket};
use tokio::sync::mpsc;

const LOCAL: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);
const FORWARD: u32 = 7;

async fn pump_back(listener: &Listener, mut frames: mpsc::Receiver<Frame>) {
    while let Some(frame) = frames.recv().await {
        listener.deliver(frame).await;
    }
}

#[tokio::test]
async fn a_datagram_reaches_the_game_and_the_reply_comes_back() {
    // The game: echoes with a marker so the reply is distinguishable.
    let game = UdpSocket::bind(SocketAddr::new(LOCAL, 0)).await.unwrap();
    let game_port = game.local_addr().unwrap().port();

    let (listener_out, mut listener_rx) = mpsc::channel(256);
    let (connector_out, connector_rx) = mpsc::channel(256);
    let listener = Arc::new(Listener::bind(FORWARD, LOCAL, 0, listener_out).await.unwrap());
    let address = listener.address();
    let connector = Arc::new(Connector::new(FORWARD, game_port, connector_out));

    {
        let connector = connector.clone();
        tokio::spawn(async move {
            while let Some(frame) = listener_rx.recv().await {
                connector.deliver(frame).await;
            }
        });
    }
    {
        let listener = listener.clone();
        tokio::spawn(async move { pump_back(&listener, connector_rx).await });
    }
    tokio::spawn(async move {
        let mut buffer = vec![0u8; 2048];
        loop {
            let (read, from) = game.recv_from(&mut buffer).await.unwrap();
            let mut reply = b"echo:".to_vec();
            reply.extend_from_slice(&buffer[..read]);
            game.send_to(&reply, from).await.unwrap();
        }
    });

    // The player's game, talking to the address Ruyd told them to use.
    let player = UdpSocket::bind(SocketAddr::new(LOCAL, 0)).await.unwrap();
    player.send_to(b"hello", address).await.unwrap();

    let mut buffer = vec![0u8; 2048];
    let (read, _) = tokio::time::timeout(Duration::from_secs(5), player.recv_from(&mut buffer))
        .await
        .expect("reply timed out")
        .unwrap();
    assert_eq!(&buffer[..read], b"echo:hello");

    let metrics = listener.metrics();
    assert_eq!(metrics.datagrams_out, 1);
    assert_eq!(metrics.datagrams_in, 1);
    assert_eq!(metrics.sessions_opened, 1);
}

#[tokio::test]
async fn two_players_get_separate_sessions_and_their_own_replies() {
    // The game replies with the port it saw, so a crossed reply is detectable.
    let game = UdpSocket::bind(SocketAddr::new(LOCAL, 0)).await.unwrap();
    let game_port = game.local_addr().unwrap().port();

    let (listener_out, mut listener_rx) = mpsc::channel(256);
    let (connector_out, connector_rx) = mpsc::channel(256);
    let listener = Arc::new(Listener::bind(FORWARD, LOCAL, 0, listener_out).await.unwrap());
    let address = listener.address();
    let connector = Arc::new(Connector::new(FORWARD, game_port, connector_out));
    {
        let connector = connector.clone();
        tokio::spawn(async move {
            while let Some(frame) = listener_rx.recv().await {
                connector.deliver(frame).await;
            }
        });
    }
    {
        let listener = listener.clone();
        tokio::spawn(async move { pump_back(&listener, connector_rx).await });
    }
    tokio::spawn(async move {
        let mut buffer = vec![0u8; 2048];
        loop {
            let (read, from) = game.recv_from(&mut buffer).await.unwrap();
            let reply = format!("{}:{}", String::from_utf8_lossy(&buffer[..read]), from.port());
            game.send_to(reply.as_bytes(), from).await.unwrap();
        }
    });

    let first = UdpSocket::bind(SocketAddr::new(LOCAL, 0)).await.unwrap();
    let second = UdpSocket::bind(SocketAddr::new(LOCAL, 0)).await.unwrap();
    first.send_to(b"one", address).await.unwrap();
    second.send_to(b"two", address).await.unwrap();

    let read_one = async {
        let mut buffer = vec![0u8; 2048];
        let (read, _) = first.recv_from(&mut buffer).await.unwrap();
        String::from_utf8_lossy(&buffer[..read]).to_string()
    };
    let read_two = async {
        let mut buffer = vec![0u8; 2048];
        let (read, _) = second.recv_from(&mut buffer).await.unwrap();
        String::from_utf8_lossy(&buffer[..read]).to_string()
    };
    let (one, two) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(read_one, read_two)
    })
    .await
    .expect("replies timed out");

    // Each player got its own reply, and the game saw them as two distinct clients.
    assert!(one.starts_with("one:"), "{one}");
    assert!(two.starts_with("two:"), "{two}");
    let port_of = |reply: &str| reply.split(':').nth(1).unwrap().to_string();
    assert_ne!(port_of(&one), port_of(&two));
    assert_eq!(listener.metrics().sessions_opened, 2);
}

#[tokio::test]
async fn a_stream_carries_both_directions_and_closes() {
    let game = TokioTcpListener::bind(SocketAddr::new(LOCAL, 0)).await.unwrap();
    let game_port = game.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let (mut socket, _) = game.accept().await.unwrap();
            tokio::spawn(async move {
                let mut buffer = vec![0u8; 1024];
                while let Ok(read) = socket.read(&mut buffer).await {
                    if read == 0 {
                        break;
                    }
                    let mut reply = b"echo:".to_vec();
                    reply.extend_from_slice(&buffer[..read]);
                    if socket.write_all(&reply).await.is_err() {
                        break;
                    }
                }
            });
        }
    });

    let (listener_out, mut listener_rx) = mpsc::channel(256);
    let (connector_out, connector_rx) = mpsc::channel(256);
    let listener = Arc::new(Listener::bind(FORWARD, LOCAL, 0, listener_out).await.unwrap());
    let address = listener.address();
    let connector = Arc::new(Connector::new(FORWARD, game_port, connector_out));
    {
        let connector = connector.clone();
        tokio::spawn(async move {
            while let Some(frame) = listener_rx.recv().await {
                connector.deliver(frame).await;
            }
        });
    }
    {
        let listener = listener.clone();
        tokio::spawn(async move { pump_back(&listener, connector_rx).await });
    }

    let mut player = TcpStream::connect(address).await.unwrap();
    player.write_all(b"hello").await.unwrap();

    let mut buffer = vec![0u8; 1024];
    let read = tokio::time::timeout(Duration::from_secs(5), player.read(&mut buffer))
        .await
        .expect("reply timed out")
        .unwrap();
    assert_eq!(&buffer[..read], b"echo:hello");
    assert_eq!(listener.metrics().streams_opened, 1);
}

#[tokio::test]
async fn a_stream_to_a_game_that_is_not_running_is_closed_rather_than_left_hanging() {
    // A port nothing is listening on.
    let idle = TokioTcpListener::bind(SocketAddr::new(LOCAL, 0)).await.unwrap();
    let dead_port = idle.local_addr().unwrap().port();
    drop(idle);

    let (connector_out, mut connector_rx) = mpsc::channel(256);
    let connector = Connector::new(FORWARD, dead_port, connector_out);
    connector
        .deliver(Frame::StreamOpen {
            forward: FORWARD,
            stream: 1,
        })
        .await;

    let frame = tokio::time::timeout(Duration::from_secs(5), connector_rx.recv())
        .await
        .expect("no answer")
        .expect("channel closed");
    assert_eq!(
        frame,
        Frame::StreamClose {
            forward: FORWARD,
            stream: 1
        }
    );
}

#[tokio::test]
async fn a_datagram_for_an_unknown_session_is_dropped() {
    let (listener_out, _listener_rx) = mpsc::channel(256);
    let listener = Listener::bind(FORWARD, LOCAL, 0, listener_out).await.unwrap();

    // Replying to a session that was never opened would send a game's traffic to a
    // guessed port. It must be discarded instead.
    listener
        .deliver(Frame::Datagram {
            forward: FORWARD,
            session: 999,
            payload: b"unexpected".to_vec(),
        })
        .await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(listener.metrics().datagrams_in, 0);
}

#[tokio::test]
async fn the_connector_only_ever_targets_loopback() {
    let (out, _rx) = mpsc::channel(1);
    let connector = Connector::new(FORWARD, 25565, out);
    assert!(connector.target().ip().is_loopback());
}

#[test]
fn peers_get_distinct_loopback_addresses_that_avoid_the_real_one() {
    let first = loopback_address(0);
    let second = loopback_address(1);
    assert_ne!(first, second);
    assert!(first.is_loopback() && second.is_loopback());
    assert_ne!(first, IpAddr::V4(Ipv4Addr::LOCALHOST));
    assert_ne!(first, IpAddr::V4(Ipv4Addr::new(127, 71, 0, 0)));
    assert_eq!(loopback_address(0), IpAddr::V4(Ipv4Addr::new(127, 71, 0, 2)));
}

#[tokio::test]
async fn the_bound_address_serves_both_datagrams_and_streams() {
    let (out, _rx) = mpsc::channel(1);
    let listener = Listener::bind(FORWARD, LOCAL, 0, out).await.unwrap();
    let address = listener.address();
    // A game does not know which the tunnel bound, so both must answer on one address.
    assert!(UdpSocket::bind(address).await.is_err());
    assert!(TokioTcpListener::bind(address).await.is_err());
}
