use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use igd_next::{search_gateway, PortMappingProtocol, SearchOptions};
use serde::{Deserialize, Serialize};
use std::{io::{BufRead, BufReader, Write}, net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream, UdpSocket}, sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex, OnceLock}, thread, time::Duration};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub struct RoomInfo { code:String, endpoint:String, direct:bool, detail:String }
#[derive(Clone, Serialize)]
#[serde(tag="type", rename_all="snake_case")]
enum UiEvent { PeerJoined{name:String}, Chat{name:String,text:String}, Disconnected{reason:String} }
#[derive(Serialize, Deserialize)]
struct Invite { v:u8, host:String, port:u16, secret:String }
#[derive(Serialize, Deserialize)]
#[serde(tag="type", rename_all="snake_case")]
enum Packet { Join{name:String,secret:String}, Welcome, Chat{name:String,text:String}, PeerJoined{name:String}, Leave }
struct Runtime { active:Arc<AtomicBool>, host:bool, name:String, writers:Arc<Mutex<Vec<TcpStream>>> }
static RUNTIME:OnceLock<Mutex<Option<Runtime>>>=OnceLock::new();
fn runtime()->&'static Mutex<Option<Runtime>>{RUNTIME.get_or_init(||Mutex::new(None))}
fn secret()->Result<String,String>{let mut bytes=[0u8;24];getrandom::fill(&mut bytes).map_err(|e|e.to_string())?;Ok(URL_SAFE_NO_PAD.encode(bytes))}
fn local_ip()->Result<Ipv4Addr,String>{let socket=UdpSocket::bind("0.0.0.0:0").map_err(|e|e.to_string())?;socket.connect("192.0.2.1:9").map_err(|e|e.to_string())?;match socket.local_addr().map_err(|e|e.to_string())?.ip(){IpAddr::V4(ip)=>Ok(ip),_=>Err("IPv4 is required".into())}}
fn write_packet(stream:&mut TcpStream,packet:&Packet)->Result<(),String>{let mut value=serde_json::to_vec(packet).map_err(|e|e.to_string())?;value.push(b'\n');stream.write_all(&value).map_err(|e|e.to_string())}
fn broadcast(writers:&Arc<Mutex<Vec<TcpStream>>>,packet:&Packet){if let Ok(mut list)=writers.lock(){list.retain_mut(|stream|write_packet(stream,packet).is_ok())}}
fn emit(app:&AppHandle,event:UiEvent){let _=app.emit("ruyd-event",event);}

#[tauri::command]
pub fn host_room(app:AppHandle,name:String)->Result<RoomInfo,String>{
 stop_room();
 let listener=TcpListener::bind("0.0.0.0:0").map_err(|e|e.to_string())?;
 listener.set_nonblocking(true).map_err(|e|e.to_string())?;
 let local=local_ip()?;
 let port=listener.local_addr().map_err(|e|e.to_string())?.port();
 let secret=secret()?;
 let active=Arc::new(AtomicBool::new(true));let writers=Arc::new(Mutex::new(Vec::new()));
 *runtime().lock().map_err(|_|"Runtime lock failed")?=Some(Runtime{active:active.clone(),host:true,name:name.clone(),writers:writers.clone()});
 let accept_secret=secret.clone();
 thread::spawn(move||{while active.load(Ordering::Relaxed){match listener.accept(){Ok((stream,_))=>handle_host_peer(stream,&app,&accept_secret,&writers,&active),Err(e)if e.kind()==std::io::ErrorKind::WouldBlock=>thread::sleep(Duration::from_millis(50)),Err(e)=>{emit(&app,UiEvent::Disconnected{reason:e.to_string()});break}}}});
 let options=SearchOptions{timeout:Some(Duration::from_secs(2)),single_search_timeout:Some(Duration::from_secs(2)),..Default::default()};
 let mapped=search_gateway(options)
   .map_err(|error|error.to_string())
   .and_then(|gateway|gateway.get_any_address(PortMappingProtocol::TCP,SocketAddr::new(IpAddr::V4(local),port),7200,"Ruyd room").map_err(|error|error.to_string()));
 let (endpoint,direct,detail)=match mapped{Ok(addr)=>(addr.to_string(),true,"Host is active and waiting for connections. Router mapping is active for internet connections.".into()),Err(_error)=>(format!("{local}:{port}"),false,format!("Host is active and waiting for connections on your local network at {local}:{port}. Automatic internet access is unavailable."))};
 let invite=Invite{v:1,host:endpoint.rsplit_once(':').map(|v|v.0).unwrap_or(&endpoint).to_string(),port:endpoint.rsplit_once(':').and_then(|v|v.1.parse().ok()).unwrap_or(port),secret:secret.clone()};
 let code=format!("RUYD1-{}",URL_SAFE_NO_PAD.encode(serde_json::to_vec(&invite).map_err(|e|e.to_string())?));
 Ok(RoomInfo{code,endpoint,direct,detail})
}
fn handle_host_peer(mut stream:TcpStream,app:&AppHandle,secret:&str,writers:&Arc<Mutex<Vec<TcpStream>>>,active:&Arc<AtomicBool>){
 let _=stream.set_read_timeout(Some(Duration::from_secs(8)));
 let read=match stream.try_clone(){Ok(v)=>v,Err(_)=>return};let mut reader=BufReader::new(read);let mut line=String::new();
 if reader.read_line(&mut line).is_err(){return}
 let name:String=match serde_json::from_str::<Packet>(&line){Ok(Packet::Join{name,secret:given})if given==secret=>name.chars().take(32).collect(),_=>return};
 let _=stream.set_read_timeout(None);if write_packet(&mut stream,&Packet::Welcome).is_err(){return}
 if let Ok(copy)=stream.try_clone(){if let Ok(mut list)=writers.lock(){list.push(copy)}}
 emit(app,UiEvent::PeerJoined{name:name.clone()});broadcast(writers,&Packet::PeerJoined{name:name.clone()});
 let app=app.clone();let writers=writers.clone();let active=active.clone();
 thread::spawn(move||{for line in reader.lines(){if !active.load(Ordering::Relaxed){break}let Ok(line)=line else{break};if let Ok(Packet::Chat{name,text})=serde_json::from_str(&line){let text:String=text.chars().take(500).collect();emit(&app,UiEvent::Chat{name:name.clone(),text:text.clone()});broadcast(&writers,&Packet::Chat{name:name.clone(),text})}}});
}

#[tauri::command]
pub fn join_room(app:AppHandle,code:String,name:String)->Result<RoomInfo,String>{
 stop_room();let encoded=code.trim().strip_prefix("RUYD1-").ok_or("Invalid Ruyd connection code")?;
 let invite:Invite=serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).map_err(|_|"Invalid Ruyd connection code")?).map_err(|_|"Invalid Ruyd connection code")?;
 if invite.v!=1{return Err("Unsupported Ruyd connection code".into())}
 let address=format!("{}:{}",invite.host,invite.port).parse::<SocketAddr>().map_err(|_|"Invalid host endpoint")?;
 let mut stream=TcpStream::connect_timeout(&address,Duration::from_secs(10)).map_err(|e|format!("Could not reach the host: {e}"))?;
 write_packet(&mut stream,&Packet::Join{name:name.clone(),secret:invite.secret})?;
 let read=stream.try_clone().map_err(|e|e.to_string())?;let mut reader=BufReader::new(read);let mut line=String::new();reader.read_line(&mut line).map_err(|e|e.to_string())?;
 if !matches!(serde_json::from_str(&line),Ok(Packet::Welcome)){return Err("The host rejected this connection".into())}
 let active=Arc::new(AtomicBool::new(true));let writers=Arc::new(Mutex::new(vec![stream]));
 *runtime().lock().map_err(|_|"Runtime lock failed")?=Some(Runtime{active:active.clone(),host:false,name,writers});
 thread::spawn(move||{for line in reader.lines(){if !active.load(Ordering::Relaxed){break}let Ok(line)=line else{break};match serde_json::from_str(&line){Ok(Packet::Chat{name,text})=>emit(&app,UiEvent::Chat{name,text}),Ok(Packet::PeerJoined{name})=>emit(&app,UiEvent::PeerJoined{name}),_=>{}}}emit(&app,UiEvent::Disconnected{reason:"Host disconnected".into()})});
 Ok(RoomInfo{code,endpoint:address.to_string(),direct:true,detail:"Connected directly to the host.".into()})
}
#[tauri::command]
pub fn send_chat(text:String)->Result<(),String>{let guard=runtime().lock().map_err(|_|"Runtime lock failed")?;let state=guard.as_ref().ok_or("Not connected")?;let text:String=text.trim().chars().take(500).collect();if text.is_empty(){return Ok(())}let packet=Packet::Chat{name:state.name.clone(),text};broadcast(&state.writers,&packet);Ok(())}
#[tauri::command]
pub fn stop_room(){if let Ok(mut guard)=runtime().lock(){if let Some(state)=guard.take(){state.active.store(false,Ordering::Relaxed);broadcast(&state.writers,&Packet::Leave)}}}
