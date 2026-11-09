//! Remote serial bridge: share a local serial port over WebSocket, or connect
//! to another Oryx instance's share as if it were a local port.
//!
//! Security model: no TLS. Both sides prove knowledge of a shared 80-bit
//! token via an HMAC challenge-response over fresh nonces, then every frame
//! is sealed with ChaCha20-Poly1305 under per-direction keys derived (HKDF)
//! from the token and both nonces. The token itself never crosses the wire.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chacha20poly1305::aead::{Aead, Generate};
use chacha20poly1305::{ChaCha20Poly1305, KeyInit};
use futures_util::{Sink, SinkExt, Stream, StreamExt};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, mpsc, watch};
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

use crate::serial_manager::{send_data_inner, Payload, SerialState};

pub const SERVICE_TYPE: &str = "_oryx._tcp.local.";
pub const DEFAULT_SHARE_PORT: u16 = 48550;
const PROTO_VERSION: u8 = 1;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(8);
const PING_INTERVAL: Duration = Duration::from_secs(5);
const PEER_SILENCE_LIMIT: Duration = Duration::from_secs(15);
const RECONNECT_INTERVAL: Duration = Duration::from_secs(2);

// Outer frame types (cleartext header byte)
const F_HELLO: u8 = 0x01;
const F_AUTH: u8 = 0x02;
const F_AUTH_OK: u8 = 0x03;
const F_AUTH_FAIL: u8 = 0x04;
const F_BUSY: u8 = 0x05;
const F_SEALED: u8 = 0x10;

// Inner (encrypted) message types
const M_DATA: u8 = 0x01;
const M_INFO: u8 = 0x02;
const M_STATUS: u8 = 0x03;
const M_PING: u8 = 0x04;
const M_PONG: u8 = 0x05;

// 32 symbols, no 0/O/1/I ambiguity — 16 chars = 80 bits, enough that an
// eavesdropper who captures a handshake can't brute-force it offline.
const TOKEN_ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const TOKEN_LEN: usize = 16;

// ─── Token helpers ───────────────────────────────────────────────────────────

fn generate_token() -> String {
    let bytes: [u8; TOKEN_LEN] = Generate::generate();
    bytes.iter().map(|b| TOKEN_ALPHABET[(b & 31) as usize] as char).collect()
}

fn normalize_token(t: &str) -> String {
    t.chars().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_uppercase()).collect()
}

fn is_valid_token(t: &str) -> bool {
    t.len() == TOKEN_LEN && t.bytes().all(|b| TOKEN_ALPHABET.contains(&b))
}

fn format_token(t: &str) -> String {
    t.as_bytes().chunks(4).map(|c| std::str::from_utf8(c).unwrap_or("")).collect::<Vec<_>>().join("-")
}

// ─── Crypto ──────────────────────────────────────────────────────────────────

struct SessionKeys {
    auth: [u8; 32],
    c2s: [u8; 32],
    s2c: [u8; 32],
}

fn derive_keys(token: &str, server_nonce: &[u8; 32], client_nonce: &[u8; 32]) -> SessionKeys {
    let mut salt = [0u8; 64];
    salt[..32].copy_from_slice(server_nonce);
    salt[32..].copy_from_slice(client_nonce);
    let hk = Hkdf::<Sha256>::new(Some(&salt), token.as_bytes());
    let mut keys = SessionKeys { auth: [0; 32], c2s: [0; 32], s2c: [0; 32] };
    hk.expand(b"oryx/v1 auth", &mut keys.auth).expect("32 bytes is a valid HKDF length");
    hk.expand(b"oryx/v1 c2s", &mut keys.c2s).expect("32 bytes is a valid HKDF length");
    hk.expand(b"oryx/v1 s2c", &mut keys.s2c).expect("32 bytes is a valid HKDF length");
    keys
}

fn proof(auth_key: &[u8; 32], label: &[u8]) -> Vec<u8> {
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(auth_key).expect("HMAC accepts any key length");
    mac.update(label);
    mac.finalize().into_bytes().to_vec()
}

fn verify_proof(auth_key: &[u8; 32], label: &[u8], tag: &[u8]) -> bool {
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(auth_key).expect("HMAC accepts any key length");
    mac.update(label);
    mac.verify_slice(tag).is_ok() // constant-time compare
}

/// Sealed channel. Each direction has its own key and a monotonically
/// increasing 64-bit counter as nonce — WebSocket delivery is ordered and
/// reliable, so both ends stay in lockstep without sending the counter.
struct Channel {
    seal_cipher: ChaCha20Poly1305,
    open_cipher: ChaCha20Poly1305,
    seal_ctr: u64,
    open_ctr: u64,
}

impl Channel {
    fn new(keys: &SessionKeys, is_server: bool) -> Self {
        let (seal_key, open_key) = if is_server { (&keys.s2c, &keys.c2s) } else { (&keys.c2s, &keys.s2c) };
        Self {
            seal_cipher: ChaCha20Poly1305::new_from_slice(seal_key).expect("32-byte key"),
            open_cipher: ChaCha20Poly1305::new_from_slice(open_key).expect("32-byte key"),
            seal_ctr: 0,
            open_ctr: 0,
        }
    }

    fn nonce(ctr: u64) -> [u8; 12] {
        let mut n = [0u8; 12];
        n[4..].copy_from_slice(&ctr.to_le_bytes());
        n
    }

    fn seal(&mut self, kind: u8, payload: &[u8]) -> Vec<u8> {
        let mut pt = Vec::with_capacity(payload.len() + 1);
        pt.push(kind);
        pt.extend_from_slice(payload);
        let nonce = Self::nonce(self.seal_ctr);
        self.seal_ctr += 1;
        let ct = self.seal_cipher.encrypt(&nonce.into(), pt.as_slice()).expect("ChaCha20Poly1305 encryption cannot fail for in-range sizes");
        let mut frame = Vec::with_capacity(ct.len() + 1);
        frame.push(F_SEALED);
        frame.extend_from_slice(&ct);
        frame
    }

    fn open(&mut self, frame: &[u8]) -> Result<(u8, Vec<u8>), String> {
        if frame.first() != Some(&F_SEALED) {
            return Err("Unexpected cleartext frame".into());
        }
        let nonce = Self::nonce(self.open_ctr);
        self.open_ctr += 1;
        let mut pt = self.open_cipher.decrypt(&nonce.into(), &frame[1..]).map_err(|_| "Frame authentication failed".to_string())?;
        if pt.is_empty() {
            return Err("Empty frame".into());
        }
        let kind = pt.remove(0);
        Ok((kind, pt))
    }
}

// ─── WebSocket helpers ───────────────────────────────────────────────────────

async fn recv_binary<S>(ws: &mut S, limit: Duration) -> Result<Vec<u8>, String>
where
    S: Stream<Item = Result<Message, WsError>> + Unpin,
{
    let fut = async {
        loop {
            match ws.next().await {
                Some(Ok(Message::Binary(b))) => return Ok(b.to_vec()),
                Some(Ok(Message::Close(_))) | None => return Err("Connection closed by peer".to_string()),
                Some(Ok(_)) => continue,
                Some(Err(e)) => return Err(e.to_string()),
            }
        }
    };
    tokio::time::timeout(limit, fut).await.map_err(|_| "Timed out waiting for peer".to_string())?
}

async fn send_binary<S>(ws: &mut S, frame: Vec<u8>) -> Result<(), String>
where
    S: Sink<Message, Error = WsError> + Unpin,
{
    ws.send(Message::Binary(frame.into())).await.map_err(|e| e.to_string())
}

// ─── Shared types ────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
pub struct RemoteInfo {
    pub host: String,
    pub port_name: String,
    pub baud: u64,
    pub serial_connected: bool,
}

#[derive(Serialize, Clone)]
pub struct ShareInfo {
    pub addresses: Vec<String>,
    pub port: u16,
    pub token: String,
    pub discoverable: bool,
}

#[derive(Serialize)]
pub struct ShareStatus {
    pub info: ShareInfo,
    pub client: Option<String>,
    pub bytes_in: u64,
    pub bytes_out: u64,
}

#[derive(Serialize)]
pub struct DiscoveredShare {
    pub name: String,
    pub host: String,
    pub address: String,
    pub serial_port: String,
    pub baud: String,
}

struct ShareHandle {
    shutdown: watch::Sender<bool>,
    info: ShareInfo,
    client: Arc<Mutex<Option<String>>>,
    bytes_in: Arc<AtomicU64>,
    bytes_out: Arc<AtomicU64>,
    mdns: Option<(ServiceDaemon, String)>,
}

struct RemoteHandle {
    tx: mpsc::UnboundedSender<Vec<u8>>,
    shutdown: watch::Sender<bool>,
    connected: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct BridgeState {
    share: Mutex<Option<ShareHandle>>,
    remote: Mutex<Option<RemoteHandle>>,
}

impl BridgeState {
    pub fn is_remote_active(&self) -> bool {
        self.remote.lock().map(|g| g.is_some()).unwrap_or(false)
    }

    /// `Ok(None)` → no remote session, use the local port.
    /// `Ok(Some(tx))` → route TX over the link. `Err` → session exists but link is down.
    pub fn remote_sender(&self) -> Result<Option<mpsc::UnboundedSender<Vec<u8>>>, String> {
        let guard = self.remote.lock().map_err(|e| e.to_string())?;
        match guard.as_ref() {
            None => Ok(None),
            Some(h) if h.connected.load(Ordering::SeqCst) => Ok(Some(h.tx.clone())),
            Some(_) => Err("Remote link is down".into()),
        }
    }

    pub fn stop_remote(&self) {
        if let Some(h) = self.remote.lock().ok().and_then(|mut g| g.take()) {
            let _ = h.shutdown.send(true);
        }
    }

    pub fn stop_share(&self) {
        if let Some(h) = self.share.lock().ok().and_then(|mut g| g.take()) {
            let _ = h.shutdown.send(true);
            if let Some((daemon, fullname)) = h.mdns {
                // Wait briefly so the mDNS goodbye packet actually goes out
                if let Ok(rx) = daemon.unregister(&fullname) {
                    let _ = rx.recv_timeout(Duration::from_millis(500));
                }
                let _ = daemon.shutdown();
            }
        }
    }
}

fn serial_snapshot(serial: &SerialState) -> (String, u64, bool) {
    let name = serial.active_port.lock().ok().and_then(|g| g.clone()).unwrap_or_default();
    let alive = serial.running.load(Ordering::SeqCst) && serial.port.lock().map(|g| g.is_some()).unwrap_or(false);
    (name, serial.active_baud.load(Ordering::SeqCst), alive)
}

fn local_hostname() -> String {
    let raw = gethostname::gethostname().to_string_lossy().to_string();
    let host = raw.trim_end_matches(".local").to_string();
    let clean: String = host.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' }).collect();
    if clean.is_empty() { "oryx".into() } else { clean }
}

fn lan_addresses(port: u16) -> Vec<String> {
    local_ip_address::list_afinet_netifas()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(_, ip)| match ip {
            std::net::IpAddr::V4(v4) if !v4.is_loopback() && !v4.is_link_local() => Some(format!("{v4}:{port}")),
            _ => None,
        })
        .collect()
}

fn register_mdns(port: u16, port_name: &str, baud: u64) -> Option<(ServiceDaemon, String)> {
    let daemon = ServiceDaemon::new().ok()?;
    let host = local_hostname();
    let mut props = HashMap::new();
    props.insert("port".to_string(), port_name.to_string());
    props.insert("baud".to_string(), baud.to_string());
    props.insert("host".to_string(), host.clone());
    props.insert("ver".to_string(), PROTO_VERSION.to_string());
    let info = ServiceInfo::new(SERVICE_TYPE, &format!("{host} ({port})"), &format!("{host}.local."), "", port, props)
        .ok()?
        .enable_addr_auto();
    let fullname = info.get_fullname().to_string();
    daemon.register(info).ok()?;
    Some((daemon, fullname))
}

// ─── Share (server) side ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn start_share(
    listen_port: Option<u16>,
    token: Option<String>,
    discoverable: bool,
    app: AppHandle,
    bridge: State<'_, BridgeState>,
    serial: State<'_, SerialState>,
) -> Result<ShareInfo, String> {
    if bridge.share.lock().map_err(|e| e.to_string())?.is_some() {
        return Err("Already sharing".into());
    }
    if bridge.is_remote_active() {
        return Err("Cannot share while connected to a remote share".into());
    }
    let (port_name, baud, _) = serial_snapshot(&serial);
    if port_name.is_empty() {
        return Err("Open a serial port before sharing".into());
    }

    let token = token.map(|t| normalize_token(&t)).filter(|t| is_valid_token(t)).unwrap_or_else(generate_token);
    let listener = TcpListener::bind(("0.0.0.0", listen_port.unwrap_or(DEFAULT_SHARE_PORT)))
        .await
        .map_err(|e| format!("Cannot listen: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();

    let mdns = if discoverable { register_mdns(port, &port_name, baud) } else { None };
    let info = ShareInfo {
        addresses: lan_addresses(port),
        port,
        token: format_token(&token),
        discoverable: mdns.is_some(),
    };

    let (shutdown, shutdown_rx) = watch::channel(false);
    let client = Arc::new(Mutex::new(None));
    let bytes_in = Arc::new(AtomicU64::new(0));
    let bytes_out = Arc::new(AtomicU64::new(0));

    tauri::async_runtime::spawn(accept_loop(
        listener, token, app, client.clone(), bytes_in.clone(), bytes_out.clone(), shutdown_rx,
    ));

    *bridge.share.lock().map_err(|e| e.to_string())? = Some(ShareHandle {
        shutdown, info: info.clone(), client, bytes_in, bytes_out, mdns,
    });
    Ok(info)
}

#[tauri::command]
pub fn stop_share(bridge: State<'_, BridgeState>) -> Result<(), String> {
    bridge.stop_share();
    Ok(())
}

#[tauri::command]
pub fn get_share_status(bridge: State<'_, BridgeState>) -> Result<Option<ShareStatus>, String> {
    let guard = bridge.share.lock().map_err(|e| e.to_string())?;
    Ok(guard.as_ref().map(|h| ShareStatus {
        info: h.info.clone(),
        client: h.client.lock().ok().and_then(|c| c.clone()),
        bytes_in: h.bytes_in.load(Ordering::Relaxed),
        bytes_out: h.bytes_out.load(Ordering::Relaxed),
    }))
}

async fn accept_loop(
    listener: TcpListener,
    token: String,
    app: AppHandle,
    client: Arc<Mutex<Option<String>>>,
    bytes_in: Arc<AtomicU64>,
    bytes_out: Arc<AtomicU64>,
    mut shutdown: watch::Receiver<bool>,
) {
    loop {
        tokio::select! {
            _ = shutdown.changed() => break,
            accepted = listener.accept() => {
                let Ok((stream, addr)) = accepted else { continue };
                tauri::async_runtime::spawn(serve_client(
                    stream, addr.to_string(), token.clone(), app.clone(),
                    client.clone(), bytes_in.clone(), bytes_out.clone(), shutdown.clone(),
                ));
            }
        }
    }
}

/// HELLO → AUTH → AUTH_OK. Returns the sealed channel only once the client
/// proved the token and the single client slot was claimed.
async fn server_handshake<S>(ws: &mut S, token: &str, peer: String, client_slot: &Mutex<Option<String>>) -> Option<Channel>
where
    S: Stream<Item = Result<Message, WsError>> + Sink<Message, Error = WsError> + Unpin,
{
    let server_nonce: [u8; 32] = Generate::generate();
    let mut hello = vec![F_HELLO, PROTO_VERSION];
    hello.extend_from_slice(&server_nonce);
    send_binary(ws, hello).await.ok()?;

    let auth = recv_binary(ws, HANDSHAKE_TIMEOUT).await.ok()?;
    if auth.len() != 65 || auth[0] != F_AUTH {
        return None;
    }
    let client_nonce: [u8; 32] = auth[1..33].try_into().expect("length checked");
    let keys = derive_keys(token, &server_nonce, &client_nonce);
    if !verify_proof(&keys.auth, b"client", &auth[33..]) {
        // Slow down guessing; the token is long enough that this is belt-and-braces
        tokio::time::sleep(Duration::from_secs(1)).await;
        let _ = send_binary(ws, vec![F_AUTH_FAIL]).await;
        return None;
    }

    // Single client in v1 — claim the slot only after auth so a stranger
    // can't lock out the real user just by connecting
    let claimed = match client_slot.lock() {
        Ok(mut slot) if slot.is_none() => { *slot = Some(peer); true }
        _ => false,
    };
    if !claimed {
        let _ = send_binary(ws, vec![F_BUSY]).await;
        return None;
    }

    let mut ok = vec![F_AUTH_OK];
    ok.extend_from_slice(&proof(&keys.auth, b"server"));
    if send_binary(ws, ok).await.is_err() {
        if let Ok(mut slot) = client_slot.lock() { *slot = None; }
        return None;
    }
    Some(Channel::new(&keys, true))
}

#[allow(clippy::too_many_arguments)]
async fn serve_client(
    stream: tokio::net::TcpStream,
    peer: String,
    token: String,
    app: AppHandle,
    client_slot: Arc<Mutex<Option<String>>>,
    bytes_in: Arc<AtomicU64>,
    bytes_out: Arc<AtomicU64>,
    mut shutdown: watch::Receiver<bool>,
) {
    let Ok(Ok(mut ws)) = tokio::time::timeout(HANDSHAKE_TIMEOUT, tokio_tungstenite::accept_async(stream)).await else { return };
    let Some(mut ch) = server_handshake(&mut ws, &token, peer, &client_slot).await else {
        let _ = ws.close(None).await;
        return;
    };
    let serial = app.state::<SerialState>();
    let mut rx = serial.rx_tap.subscribe();

    let (name, baud, mut alive) = serial_snapshot(&serial);
    let info = RemoteInfo { host: local_hostname(), port_name: name, baud, serial_connected: alive };
    let info_json = serde_json::to_vec(&info).unwrap_or_default();
    if send_binary(&mut ws, ch.seal(M_INFO, &info_json)).await.is_ok() {
        // ── Session ──
        let mut tick = tokio::time::interval(Duration::from_millis(250));
        let mut last_seen = Instant::now();
        loop {
            tokio::select! {
                _ = shutdown.changed() => break,
                r = rx.recv() => match r {
                    Ok(bytes) => {
                        bytes_out.fetch_add(bytes.len() as u64, Ordering::Relaxed);
                        if send_binary(&mut ws, ch.seal(M_DATA, &bytes)).await.is_err() { break; }
                    }
                    // Client too slow for the serial stream — drop the backlog rather than the session
                    Err(broadcast::error::RecvError::Lagged(n)) => eprintln!("share: client lagged, dropped {n} chunks"),
                    Err(broadcast::error::RecvError::Closed) => break,
                },
                m = ws.next() => match m {
                    Some(Ok(Message::Binary(b))) => {
                        last_seen = Instant::now();
                        let Ok((kind, payload)) = ch.open(&b) else { break };
                        match kind {
                            M_DATA => {
                                bytes_in.fetch_add(payload.len() as u64, Ordering::Relaxed);
                                // Same path as local TX so flow control / RS-485 keying apply
                                if let Err(e) = send_data_inner(payload, &serial).await {
                                    eprintln!("share: remote TX failed: {e}");
                                }
                            }
                            M_PING => { if send_binary(&mut ws, ch.seal(M_PONG, &[])).await.is_err() { break; } }
                            _ => {}
                        }
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(_)) => last_seen = Instant::now(),
                },
                _ = tick.tick() => {
                    if last_seen.elapsed() > PEER_SILENCE_LIMIT { break; }
                    let (_, _, now_alive) = serial_snapshot(&serial);
                    if now_alive != alive {
                        alive = now_alive;
                        if send_binary(&mut ws, ch.seal(M_STATUS, &[alive as u8])).await.is_err() { break; }
                    }
                }
            }
        }
    }
    let _ = ws.close(None).await;
    if let Ok(mut slot) = client_slot.lock() { *slot = None; }
}

// ─── Connect (client) side ───────────────────────────────────────────────────

#[derive(Serialize)]
pub struct RemoteConnectResult {
    pub address: String,
    pub info: RemoteInfo,
}

fn normalize_address(input: &str) -> String {
    let s = input.trim().trim_start_matches("ws://").trim_end_matches('/');
    // Append the default port unless one is present (bare IPv6 has several ':')
    match s.rsplit_once(':') {
        Some((host, p)) if !host.contains(':') && p.parse::<u16>().is_ok() => s.to_string(),
        _ => format!("{s}:{DEFAULT_SHARE_PORT}"),
    }
}

type ClientWs = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn client_handshake(address: &str, token: &str) -> Result<(ClientWs, Channel, RemoteInfo), String> {
    let (mut ws, _) = tokio::time::timeout(HANDSHAKE_TIMEOUT, tokio_tungstenite::connect_async(format!("ws://{address}")))
        .await
        .map_err(|_| "Connection timed out".to_string())?
        .map_err(|e| format!("Cannot reach {address}: {e}"))?;

    let hello = recv_binary(&mut ws, HANDSHAKE_TIMEOUT).await?;
    if hello.len() != 34 || hello[0] != F_HELLO {
        return Err("Not an Oryx share".into());
    }
    if hello[1] != PROTO_VERSION {
        return Err(format!("Protocol version mismatch (remote v{}, local v{PROTO_VERSION}) — update both apps", hello[1]));
    }
    let server_nonce: [u8; 32] = hello[2..34].try_into().expect("length checked");
    let client_nonce: [u8; 32] = Generate::generate();
    let keys = derive_keys(token, &server_nonce, &client_nonce);

    let mut auth = vec![F_AUTH];
    auth.extend_from_slice(&client_nonce);
    auth.extend_from_slice(&proof(&keys.auth, b"client"));
    send_binary(&mut ws, auth).await?;

    let reply = recv_binary(&mut ws, HANDSHAKE_TIMEOUT).await?;
    match reply.first() {
        Some(&F_AUTH_OK) if verify_proof(&keys.auth, b"server", &reply[1..]) => {}
        Some(&F_AUTH_OK) => return Err("Remote failed to prove the token — possible impostor".into()),
        Some(&F_AUTH_FAIL) => return Err("Invalid token".into()),
        Some(&F_BUSY) => return Err("Share is busy — another client is connected".into()),
        _ => return Err("Unexpected handshake reply".into()),
    }

    let mut ch = Channel::new(&keys, false);
    let frame = recv_binary(&mut ws, HANDSHAKE_TIMEOUT).await?;
    let (kind, payload) = ch.open(&frame)?;
    if kind != M_INFO {
        return Err("Expected share info".into());
    }
    let info: RemoteInfo = serde_json::from_slice(&payload).map_err(|e| e.to_string())?;
    Ok((ws, ch, info))
}

#[tauri::command]
pub async fn connect_remote(
    address: String,
    token: String,
    app: AppHandle,
    bridge: State<'_, BridgeState>,
    serial: State<'_, SerialState>,
) -> Result<RemoteConnectResult, String> {
    if serial.port.lock().map_err(|e| e.to_string())?.is_some() || serial.reconnecting.load(Ordering::SeqCst) {
        return Err("Close the local serial port first".into());
    }
    if bridge.is_remote_active() {
        return Err("Already connected to a remote share".into());
    }
    let token = normalize_token(&token);
    if !is_valid_token(&token) {
        return Err(format!("Token must be {TOKEN_LEN} characters (e.g. ABCD-EFGH-JKLM-NPQR)"));
    }
    let address = normalize_address(&address);
    let (ws, ch, info) = client_handshake(&address, &token).await?;

    let (tx, rx) = mpsc::unbounded_channel();
    let (shutdown, shutdown_rx) = watch::channel(false);
    let connected = Arc::new(AtomicBool::new(info.serial_connected));
    *bridge.remote.lock().map_err(|e| e.to_string())? = Some(RemoteHandle { tx, shutdown, connected: connected.clone() });

    tauri::async_runtime::spawn(remote_supervisor(app, address.clone(), token, ws, ch, rx, shutdown_rx, connected));
    Ok(RemoteConnectResult { address, info })
}

enum SessionEnd {
    Shutdown,
    Dropped,
}

#[allow(clippy::too_many_arguments)]
async fn remote_supervisor(
    app: AppHandle,
    address: String,
    token: String,
    mut ws: ClientWs,
    mut ch: Channel,
    mut rx: mpsc::UnboundedReceiver<Vec<u8>>,
    mut shutdown: watch::Receiver<bool>,
    connected: Arc<AtomicBool>,
) {
    loop {
        if let SessionEnd::Shutdown = run_session(&app, &mut ws, &mut ch, &mut rx, &mut shutdown, &connected).await {
            return;
        }
        connected.store(false, Ordering::SeqCst);
        app.emit("serial-disconnected", ()).ok();

        // Same contract as the local serial reconnect loop: keep retrying until
        // reconnected or the frontend calls close_port (→ shutdown).
        loop {
            tokio::select! {
                _ = shutdown.changed() => return,
                _ = tokio::time::sleep(RECONNECT_INTERVAL) => {}
            }
            while rx.try_recv().is_ok() {} // drop TX queued while the link was down
            if let Ok((new_ws, new_ch, info)) = client_handshake(&address, &token).await {
                ws = new_ws;
                ch = new_ch;
                if info.serial_connected {
                    connected.store(true, Ordering::SeqCst);
                    // Empty payload so the frontend doesn't overwrite its local port selection
                    app.emit("serial-reconnected", "").ok();
                }
                break;
            }
        }
    }
}

async fn run_session(
    app: &AppHandle,
    ws: &mut ClientWs,
    ch: &mut Channel,
    rx: &mut mpsc::UnboundedReceiver<Vec<u8>>,
    shutdown: &mut watch::Receiver<bool>,
    connected: &AtomicBool,
) -> SessionEnd {
    let mut ping = tokio::time::interval(PING_INTERVAL);
    let mut last_seen = Instant::now();
    loop {
        tokio::select! {
            _ = shutdown.changed() => {
                let _ = ws.close(None).await;
                return SessionEnd::Shutdown;
            }
            data = rx.recv() => {
                let Some(data) = data else {
                    let _ = ws.close(None).await;
                    return SessionEnd::Shutdown;
                };
                if send_binary(ws, ch.seal(M_DATA, &data)).await.is_err() { return SessionEnd::Dropped; }
            }
            m = ws.next() => match m {
                Some(Ok(Message::Binary(b))) => {
                    last_seen = Instant::now();
                    let Ok((kind, payload)) = ch.open(&b) else { return SessionEnd::Dropped };
                    match kind {
                        M_DATA => { app.emit("serial-data", Payload { data: payload }).ok(); }
                        M_STATUS => {
                            let alive = payload.first() == Some(&1);
                            connected.store(alive, Ordering::SeqCst);
                            if alive { app.emit("serial-reconnected", "").ok(); } else { app.emit("serial-disconnected", ()).ok(); }
                        }
                        M_PING => { if send_binary(ws, ch.seal(M_PONG, &[])).await.is_err() { return SessionEnd::Dropped; } }
                        _ => {}
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return SessionEnd::Dropped,
                Some(Ok(_)) => last_seen = Instant::now(),
            },
            _ = ping.tick() => {
                if last_seen.elapsed() > PEER_SILENCE_LIMIT { return SessionEnd::Dropped; }
                if send_binary(ws, ch.seal(M_PING, &[])).await.is_err() { return SessionEnd::Dropped; }
            }
        }
    }
}

// ─── Discovery ───────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn discover_shares() -> Result<Vec<DiscoveredShare>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let daemon = ServiceDaemon::new().map_err(|e| e.to_string())?;
        let events = daemon.browse(SERVICE_TYPE).map_err(|e| e.to_string())?;
        let deadline = Instant::now() + Duration::from_millis(2500);
        let mut found: HashMap<String, DiscoveredShare> = HashMap::new();
        while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
            let Ok(event) = events.recv_timeout(remaining) else { break };
            if let ServiceEvent::ServiceResolved(svc) = event {
                let Some(ip) = svc.get_addresses().iter().find(|a| a.is_ipv4()) else { continue };
                let prop = |k: &str| svc.get_property_val_str(k).unwrap_or("").to_string();
                found.insert(svc.get_fullname().to_string(), DiscoveredShare {
                    name: svc.get_fullname().trim_end_matches(SERVICE_TYPE).trim_end_matches('.').to_string(),
                    host: prop("host"),
                    address: format!("{}:{}", ip, svc.port),
                    serial_port: prop("port"),
                    baud: prop("baud"),
                });
            }
        }
        let _ = daemon.shutdown();
        Ok(found.into_values().collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_roundtrip() {
        let t = generate_token();
        assert!(is_valid_token(&t));
        assert_eq!(normalize_token(&format_token(&t).to_lowercase()), t);
    }

    #[test]
    fn handshake_and_channel() {
        let token = generate_token();
        let (sn, cn): ([u8; 32], [u8; 32]) = (Generate::generate(), Generate::generate());
        let server = derive_keys(&token, &sn, &cn);
        let client = derive_keys(&token, &sn, &cn);
        assert!(verify_proof(&server.auth, b"client", &proof(&client.auth, b"client")));
        assert!(!verify_proof(&derive_keys("WRONG", &sn, &cn).auth, b"client", &proof(&client.auth, b"client")));

        let mut s = Channel::new(&server, true);
        let mut c = Channel::new(&client, false);
        for msg in [&b"hello"[..], &[0u8, 255, 13, 10][..], &[][..]] {
            let (k, p) = c.open(&s.seal(M_DATA, msg)).unwrap();
            assert_eq!((k, p.as_slice()), (M_DATA, msg));
            let (k, p) = s.open(&c.seal(M_DATA, msg)).unwrap();
            assert_eq!((k, p.as_slice()), (M_DATA, msg));
        }
        // Replayed/reordered frame must fail
        let f1 = s.seal(M_DATA, b"a");
        let _ = s.seal(M_DATA, b"b");
        assert!(c.open(&f1).is_ok());
        assert!(c.open(&f1).is_err());
    }

    /// Real WebSocket over loopback: server handshake + INFO, then the actual
    /// client_handshake, data both ways, wrong token, and the busy slot.
    #[tokio::test]
    async fn wire_protocol_over_loopback() {
        let token = generate_token();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let slot = Arc::new(Mutex::new(None));

        let (srv_token, srv_slot) = (token.clone(), slot.clone());
        tokio::spawn(async move {
            loop {
                let (stream, peer) = listener.accept().await.unwrap();
                let (token, slot) = (srv_token.clone(), srv_slot.clone());
                tokio::spawn(async move {
                    let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
                    let Some(mut ch) = server_handshake(&mut ws, &token, peer.to_string(), &slot).await else { return };
                    let info = RemoteInfo { host: "h".into(), port_name: "/dev/ttyTEST".into(), baud: 115200, serial_connected: true };
                    send_binary(&mut ws, ch.seal(M_INFO, &serde_json::to_vec(&info).unwrap())).await.unwrap();
                    // Echo DATA back so the client can verify both directions
                    while let Ok(frame) = recv_binary(&mut ws, Duration::from_secs(5)).await {
                        let (kind, payload) = ch.open(&frame).unwrap();
                        if kind == M_DATA {
                            send_binary(&mut ws, ch.seal(M_DATA, &payload)).await.unwrap();
                        }
                    }
                });
            }
        });

        let (mut ws, mut ch, info) = client_handshake(&addr, &token).await.unwrap();
        assert_eq!(info.port_name, "/dev/ttyTEST");
        assert_eq!(info.baud, 115200);

        let burst: Vec<u8> = (0..=255u8).cycle().take(64 * 1024).collect();
        send_binary(&mut ws, ch.seal(M_DATA, &burst)).await.unwrap();
        let (kind, echoed) = ch.open(&recv_binary(&mut ws, Duration::from_secs(5)).await.unwrap()).unwrap();
        assert_eq!(kind, M_DATA);
        assert_eq!(echoed, burst);

        let wrong = generate_token();
        assert_eq!(client_handshake(&addr, &wrong).await.err().unwrap(), "Invalid token");

        // First client still holds the slot
        assert!(client_handshake(&addr, &token).await.err().unwrap().contains("busy"));
    }

    /// Needs multicast on the host network — run with `cargo test -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn mdns_announce_and_discover() {
        let (daemon, fullname) = register_mdns(47999, "/dev/ttyMDNS", 9600).expect("register");
        let found = discover_shares().await.unwrap();
        let _ = daemon.unregister(&fullname);
        let _ = daemon.shutdown();
        let share = found.iter().find(|s| s.serial_port == "/dev/ttyMDNS").expect("own share discovered");
        assert!(share.address.ends_with(":47999"));
        assert_eq!(share.baud, "9600");
    }

    #[test]
    fn address_normalization() {
        assert_eq!(normalize_address("192.168.1.5"), format!("192.168.1.5:{DEFAULT_SHARE_PORT}"));
        assert_eq!(normalize_address("ws://host:9000/"), "host:9000");
    }
}
