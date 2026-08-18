use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use igd_next::{search_gateway, Gateway, PortMappingProtocol, SearchOptions};
use serde::{Deserialize, Serialize};
use std::{io::{BufRead, BufReader, Write}, net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream, ToSocketAddrs, UdpSocket}, sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex, OnceLock}, thread, time::Duration};
use tauri::{AppHandle, Emitter};

const HOST_PORT:u16=50177;

#[derive(Clone,Serialize)]
#[serde(rename_all="camelCase")]
pub struct RoomInfo{code:String,endpoint:String,direct:bool,manual:bool,detail:String,host_name:Option<String>}
#[derive(Clone,Serialize)]
#[serde(tag="type",rename_all="snake_case")]
enum UiEvent{PeerJoined{name:String},Chat{name:String,text:String},Disconnected{reason:String}}
#[derive(Serialize,Deserialize)]
struct Invite{v:u8,host:String,port:u16,secret:String}
#[derive(Serialize,Deserialize)]
#[serde(tag="type",rename_all="snake_case")]
enum Packet{Join{name:String,secret:String},Welcome{name:String},Chat{name:String,text:String},PeerJoined{name:String},Leave}
struct Runtime{active:Arc<AtomicBool>,host:bool,name:String,writers:Arc<Mutex<Vec<TcpStream>>>,local_ip:Option<Ipv4Addr>,port:u16,secret:Option<String>,mapping:Option<(Gateway,u16)>}
static RUNTIME:OnceLock<Mutex<Option<Runtime>>>=OnceLock::new();

fn runtime()->&'static Mutex<Option<Runtime>>{RUNTIME.get_or_init(||Mutex::new(None))}
fn display_name(value:String)->Result<String,String>{let value:String=value.trim().chars().take(24).collect();if value.chars().count()<2{Err("Display name must be between 2 and 24 characters".into())}else{Ok(value)}}
fn secret()->Result<String,String>{let mut bytes=[0u8;24];getrandom::fill(&mut bytes).map_err(|e|e.to_string())?;Ok(URL_SAFE_NO_PAD.encode(bytes))}
fn local_ip()->Result<Ipv4Addr,String>{let socket=UdpSocket::bind("0.0.0.0:0").map_err(|e|e.to_string())?;socket.connect("192.0.2.1:9").map_err(|e|e.to_string())?;match socket.local_addr().map_err(|e|e.to_string())?.ip(){IpAddr::V4(ip)=>Ok(ip),_=>Err("IPv4 is required".into())}}

fn is_public_ipv4(ip:Ipv4Addr)->bool{
 let [a,b,c,_]=ip.octets();
 !ip.is_private()&&!ip.is_loopback()&&!ip.is_link_local()&&!ip.is_unspecified()&&!ip.is_broadcast()&&!ip.is_multicast()
 &&!(a==100&&(64..=127).contains(&b))&&!(a==192&&b==0)&&!(a==198&&(b==18||b==19))
 &&!(a==198&&b==51&&c==100)&&!(a==203&&b==0&&c==113)&&a<240
}
fn normalize_public_host(value:String)->Result<String,String>{
 let value=value.trim().trim_end_matches('.').to_ascii_lowercase();
 if value.is_empty()||value.len()>253||value.chars().any(|c|matches!(c,':'|'/'|'\\'|' ')){return Err("Enter a public IPv4 address or DNS hostname without a port".into())}
 if let Ok(ip)=value.parse::<Ipv4Addr>(){return is_public_ipv4(ip).then_some(value).ok_or_else(||"That is not a publicly routable IPv4 address".into())}
 let valid=value.split('.').all(|label|!label.is_empty()&&label.len()<=63&&!label.starts_with('-')&&!label.ends_with('-')&&label.chars().all(|c|c.is_ascii_alphanumeric()||c=='-'));
 if valid&&value.contains('.') {Ok(value)}else{Err("Enter a valid public IPv4 address or DNS hostname".into())}
}
fn invite_code(host:&str,port:u16,secret:&str)->Result<String,String>{let invite=Invite{v:1,host:host.into(),port,secret:secret.into()};Ok(format!("RUYD1-{}",URL_SAFE_NO_PAD.encode(serde_json::to_vec(&invite).map_err(|e|e.to_string())?)))}
fn write_packet(stream:&mut TcpStream,packet:&Packet)->Result<(),String>{let mut value=serde_json::to_vec(packet).map_err(|e|e.to_string())?;value.push(b'\n');stream.write_all(&value).map_err(|e|e.to_string())?;stream.flush().map_err(|e|e.to_string())}
fn broadcast(writers:&Arc<Mutex<Vec<TcpStream>>>,packet:&Packet)->usize{if let Ok(mut list)=writers.lock(){list.retain_mut(|stream|write_packet(stream,packet).is_ok());list.len()}else{0}}
fn emit(app:&AppHandle,event:UiEvent){let _=app.emit("ruyd-event",event);}

#[tauri::command]
pub fn host_room(app:AppHandle,name:String)->Result<RoomInfo,String>{
 let name=display_name(name)?;stop_room();
 let listener=TcpListener::bind((Ipv4Addr::UNSPECIFIED,HOST_PORT)).map_err(|e|format!("Could not host on TCP port {HOST_PORT}: {e}. Stop any other Ruyd host and try again."))?;
 listener.set_nonblocking(true).map_err(|e|e.to_string())?;
 let local=local_ip()?;let secret=secret()?;let active=Arc::new(AtomicBool::new(true));let writers=Arc::new(Mutex::new(Vec::new()));
 let accept_secret=secret.clone();let host_name=name.clone();let accept_active=active.clone();let accept_writers=writers.clone();
 thread::spawn(move||while accept_active.load(Ordering::Relaxed){match listener.accept(){
   Ok((stream,_))=>handle_host_peer(stream,&app,&accept_secret,&host_name,&accept_writers,&accept_active),
   Err(e)if e.kind()==std::io::ErrorKind::WouldBlock=>thread::sleep(Duration::from_millis(50)),
   Err(e)=>{emit(&app,UiEvent::Disconnected{reason:e.to_string()});break}
 }});
 let options=SearchOptions{timeout:Some(Duration::from_secs(2)),single_search_timeout:Some(Duration::from_secs(2)),..Default::default()};
 let mapping:Result<(Gateway,IpAddr),String>=search_gateway(options).map_err(|e|e.to_string()).and_then(|gateway|{
   let external=gateway.get_external_ip().map_err(|e|e.to_string())?;
   gateway.add_port(PortMappingProtocol::TCP,HOST_PORT,SocketAddr::new(IpAddr::V4(local),HOST_PORT),0,"Ruyd room").map_err(|e|e.to_string())?;Ok((gateway,external))
 });
 let (endpoint,direct,detail,gateway_mapping)=match mapping{
   Ok((gateway,IpAddr::V4(external)))if is_public_ipv4(external)=>(format!("{external}:{HOST_PORT}"),true,"Internet-ready. The router mapped TCP port 50177 automatically.".into(),Some((gateway,HOST_PORT))),
   Ok((gateway,external))=>{let _=gateway.remove_port(PortMappingProtocol::TCP,HOST_PORT);(format!("{local}:{HOST_PORT}"),false,format!("LAN only at {local}:{HOST_PORT}. The router reported non-public address {external}, which may indicate double NAT or carrier-grade NAT."),None)},
   Err(error)=>(format!("{local}:{HOST_PORT}"),false,format!("LAN only at {local}:{HOST_PORT}. Automatic router mapping failed: {error}. For internet access, forward TCP 50177 and configure a public endpoint below."),None)
 };
 let code=invite_code(endpoint.split(':').next().unwrap_or(&endpoint),HOST_PORT,&secret)?;
 *runtime().lock().map_err(|_|"Runtime lock failed")?=Some(Runtime{active,host:true,name,writers,local_ip:Some(local),port:HOST_PORT,secret:Some(secret),mapping:gateway_mapping});
 Ok(RoomInfo{code,endpoint,direct,manual:false,detail,host_name:None})
}

#[tauri::command]
pub fn set_manual_endpoint(public_host:String)->Result<RoomInfo,String>{
 let public_host=normalize_public_host(public_host)?;let guard=runtime().lock().map_err(|_|"Runtime lock failed")?;let state=guard.as_ref().ok_or("Start hosting before configuring an endpoint")?;
 if !state.host{return Err("Only the host can configure a public endpoint".into())}
 let secret=state.secret.as_deref().ok_or("Host invite is unavailable")?;let local=state.local_ip.ok_or("Local address is unavailable")?;let endpoint=format!("{public_host}:{}",state.port);
 Ok(RoomInfo{code:invite_code(&public_host,state.port,secret)?,endpoint,direct:true,manual:true,detail:format!("Manual internet endpoint configured. Confirm your router forwards TCP {} to {local}:{} and Windows Firewall allows Ruyd.",state.port,state.port),host_name:None})
}

fn handle_host_peer(mut stream:TcpStream,app:&AppHandle,secret:&str,host_name:&str,writers:&Arc<Mutex<Vec<TcpStream>>>,active:&Arc<AtomicBool>){
 let _=stream.set_nodelay(true);if stream.set_read_timeout(Some(Duration::from_secs(8))).is_err(){return}let handshake=match stream.try_clone(){Ok(v)=>v,Err(_)=>return};let mut handshake_reader=BufReader::new(handshake);let mut line=String::new();
 if handshake_reader.read_line(&mut line).is_err(){return}
 let name:String=match serde_json::from_str::<Packet>(&line){Ok(Packet::Join{name,secret:given})if given==secret=>name.chars().take(24).collect(),_=>return};
 if stream.set_read_timeout(None).is_err(){return}drop(handshake_reader);let read=match stream.try_clone(){Ok(v)=>v,Err(_)=>return};let reader=BufReader::new(read);if write_packet(&mut stream,&Packet::Welcome{name:host_name.into()}).is_err(){return}
 if let Ok(copy)=stream.try_clone(){if let Ok(mut list)=writers.lock(){list.push(copy)}}
 emit(app,UiEvent::PeerJoined{name:name.clone()});broadcast(writers,&Packet::PeerJoined{name:name.clone()});
 let app=app.clone();let writers=writers.clone();let active=active.clone();
 thread::spawn(move||for line in reader.lines(){if !active.load(Ordering::Relaxed){break}let Ok(line)=line else{break};if let Ok(Packet::Chat{name,text})=serde_json::from_str(&line){let text:String=text.chars().take(500).collect();emit(&app,UiEvent::Chat{name:name.clone(),text:text.clone()});broadcast(&writers,&Packet::Chat{name,text})}});
}

#[tauri::command]
pub fn join_room(app:AppHandle,code:String,name:String)->Result<RoomInfo,String>{
 let name=display_name(name)?;stop_room();let encoded=code.trim().strip_prefix("RUYD1-").ok_or("Invalid Ruyd connection code")?;
 let invite:Invite=serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).map_err(|_|"Invalid Ruyd connection code")?).map_err(|_|"Invalid Ruyd connection code")?;
 if invite.v!=1{return Err("Unsupported Ruyd connection code".into())}
 let addresses:Vec<SocketAddr>=(invite.host.as_str(),invite.port).to_socket_addrs().map_err(|e|format!("Could not resolve the host endpoint: {e}"))?.collect();
 if addresses.is_empty(){return Err("The host endpoint did not resolve to an address".into())}
 let mut connected=None;let mut last_error=None;
 for address in addresses{match TcpStream::connect_timeout(&address,Duration::from_secs(10)){Ok(stream)=>{connected=Some((stream,address));break},Err(e)=>last_error=Some(e)}}
 let (mut stream,address)=connected.ok_or_else(||format!("Could not reach {}:{}. Confirm the host is online, Windows Firewall allows Ruyd, and TCP port {} is forwarded. {}",invite.host,invite.port,invite.port,last_error.map(|e|e.to_string()).unwrap_or_default()))?;
 let _=stream.set_nodelay(true);stream.set_read_timeout(Some(Duration::from_secs(8))).map_err(|e|format!("Could not configure the host handshake: {e}"))?;
 write_packet(&mut stream,&Packet::Join{name:name.clone(),secret:invite.secret})?;
 let handshake=stream.try_clone().map_err(|e|e.to_string())?;let mut handshake_reader=BufReader::new(handshake);let mut line=String::new();handshake_reader.read_line(&mut line).map_err(|e|e.to_string())?;
 let host_name=match serde_json::from_str(&line){Ok(Packet::Welcome{name})=>name.chars().take(24).collect::<String>(),_=>return Err("The host rejected this connection".into())};
 stream.set_read_timeout(None).map_err(|e|format!("Could not finish the host handshake: {e}"))?;drop(handshake_reader);let read=stream.try_clone().map_err(|e|e.to_string())?;let reader=BufReader::new(read);
 let active=Arc::new(AtomicBool::new(true));let writers=Arc::new(Mutex::new(vec![stream]));
 *runtime().lock().map_err(|_|"Runtime lock failed")?=Some(Runtime{active:active.clone(),host:false,name,writers,local_ip:None,port:invite.port,secret:None,mapping:None});
 thread::spawn(move||{for line in reader.lines(){if !active.load(Ordering::Relaxed){break}let Ok(line)=line else{break};match serde_json::from_str(&line){Ok(Packet::Chat{name,text})=>emit(&app,UiEvent::Chat{name,text}),Ok(Packet::PeerJoined{name})=>emit(&app,UiEvent::PeerJoined{name}),_=>{}}}if active.load(Ordering::Relaxed){emit(&app,UiEvent::Disconnected{reason:"Host disconnected".into()})}});
 Ok(RoomInfo{code,endpoint:address.to_string(),direct:true,manual:false,detail:format!("Connected directly to {host_name}."),host_name:Some(host_name)})
}
#[tauri::command]
pub fn send_chat(text:String)->Result<usize,String>{let guard=runtime().lock().map_err(|_|"Runtime lock failed")?;let state=guard.as_ref().ok_or("Not connected")?;let text:String=text.trim().chars().take(500).collect();if text.is_empty(){return Ok(0)}let recipients=broadcast(&state.writers,&Packet::Chat{name:state.name.clone(),text});if recipients==0{Err("Message was not sent because no peer connection is available".into())}else{Ok(recipients)}}
#[tauri::command]
pub fn stop_room(){if let Ok(mut guard)=runtime().lock(){if let Some(state)=guard.take(){state.active.store(false,Ordering::Relaxed);broadcast(&state.writers,&Packet::Leave);if let Some((gateway,port))=state.mapping{thread::spawn(move||{let _=gateway.remove_port(PortMappingProtocol::TCP,port);});}}}}

#[cfg(test)]
mod tests{
 use super::*;
 #[test]fn rejects_private_manual_addresses(){assert!(normalize_public_host("192.168.1.20".into()).is_err());assert!(normalize_public_host("100.64.1.1".into()).is_err())}
 #[test]fn accepts_public_addresses_and_dns_names(){assert_eq!(normalize_public_host("8.8.8.8".into()).unwrap(),"8.8.8.8");assert_eq!(normalize_public_host("Chat.Example.com.".into()).unwrap(),"chat.example.com")}
 #[test]fn invite_round_trip_preserves_endpoint(){let code=invite_code("chat.example.com",HOST_PORT,"secret").unwrap();let encoded=code.strip_prefix("RUYD1-").unwrap();let invite:Invite=serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).unwrap()).unwrap();assert_eq!(invite.host,"chat.example.com");assert_eq!(invite.port,HOST_PORT);assert_eq!(invite.secret,"secret")}
 #[test]
 fn chat_reader_survives_handshake_timeout(){
  let listener=TcpListener::bind((Ipv4Addr::LOCALHOST,0)).unwrap();let address=listener.local_addr().unwrap();
  let server=thread::spawn(move||{let (mut stream,_)=listener.accept().unwrap();stream.set_read_timeout(Some(Duration::from_millis(50))).unwrap();let mut handshake_reader=BufReader::new(stream.try_clone().unwrap());let mut line=String::new();handshake_reader.read_line(&mut line).unwrap();assert!(matches!(serde_json::from_str::<Packet>(&line),Ok(Packet::Join{..})));stream.set_read_timeout(None).unwrap();drop(handshake_reader);let mut reader=BufReader::new(stream.try_clone().unwrap());write_packet(&mut stream,&Packet::Welcome{name:"host".into()}).unwrap();line.clear();assert!(reader.read_line(&mut line).unwrap()>0);assert!(matches!(serde_json::from_str::<Packet>(&line),Ok(Packet::Chat{name,text})if name=="client"&&text=="hello"));write_packet(&mut stream,&Packet::Chat{name:"host".into(),text:"hi".into()}).unwrap();});
  let mut client=TcpStream::connect(address).unwrap();write_packet(&mut client,&Packet::Join{name:"client".into(),secret:"secret".into()}).unwrap();let mut reader=BufReader::new(client.try_clone().unwrap());let mut line=String::new();reader.read_line(&mut line).unwrap();assert!(matches!(serde_json::from_str::<Packet>(&line),Ok(Packet::Welcome{..})));thread::sleep(Duration::from_millis(150));write_packet(&mut client,&Packet::Chat{name:"client".into(),text:"hello".into()}).unwrap();line.clear();assert!(reader.read_line(&mut line).unwrap()>0);assert!(matches!(serde_json::from_str::<Packet>(&line),Ok(Packet::Chat{name,text})if name=="host"&&text=="hi"));server.join().unwrap();
 }
}
