use tauri::{AppHandle, Emitter, State};
use serialport::SerialPort;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use std::thread;
use std::io::{Read, Write};
use crate::remote_bridge::BridgeState;

// ─── State ───────────────────────────────────────────────────────────────────

pub struct SerialState {
    pub port: Arc<Mutex<Option<Box<dyn SerialPort>>>>,
    pub running: Arc<AtomicBool>,
    pub reconnecting: Arc<AtomicBool>,
    pub active_port: Arc<Mutex<Option<String>>>,
    pub flow_mode: Arc<Mutex<FlowMode>>,
    pub rts: Arc<AtomicBool>,
    pub dtr: Arc<AtomicBool>,
    /// Set once the user manually toggles RTS/DTR via set_rts/set_dtr. Until
    /// then, those lines are left at whatever the driver defaults them to —
    /// forcing DTR low unconditionally on every open pulses many Arduino/ESP-
    /// style boards' auto-reset circuit (DTR -> cap -> RESET), which for
    /// native-USB boards can cascade into an endless reset/reconnect loop.
    pub rts_touched: Arc<AtomicBool>,
    pub dtr_touched: Arc<AtomicBool>,
    pub tx_paused: Arc<AtomicBool>,
    /// Many USB-UART chips (FTDI's RTS#/DTR# included) drive these pins
    /// active-low in hardware — asserting RTS in software pulls the physical
    /// pin low, not high. These flags flip the level written to the wire so
    /// the app's notion of "asserted" can be made to match what external
    /// circuitry (e.g. an RS-485 transceiver's DE pin) actually expects.
    pub invert_rts: Arc<AtomicBool>,
    pub invert_dtr: Arc<AtomicBool>,
    /// Same active-low convention applies to the input status lines
    /// (CTS#/DSR#/DCD#/RI# on FTDI/CP210x/Prolific) — invert to correct.
    pub invert_cts: Arc<AtomicBool>,
    pub invert_dsr: Arc<AtomicBool>,
    pub invert_cd: Arc<AtomicBool>,
    pub invert_ri: Arc<AtomicBool>,
    /// RS-485: how long to wait after driving RTS/DE high before writing
    /// data, so the transceiver has time to switch into transmit mode.
    pub rs485_pre_delay_ms: Arc<AtomicU64>,
    /// RS-485: optional extra hold on RTS/DE after `send_data` already waits
    /// for the OS-reported TX queue to drain (see `drain_tx`) — covers
    /// latency the OS can't see, like a USB-serial bridge's own onboard
    /// buffer. Most setups can leave this at 0.
    pub rs485_post_delay_ms: Arc<AtomicU64>,
    /// Half-duplex: extra settle time after the CTS handshake grants the
    /// channel but before writing — the handshake confirms the peer is
    /// ready, but some PTT/VOX-keyed radios still need physical ramp-up
    /// time beyond that before they're actually transmitting cleanly.
    pub half_duplex_pre_delay_ms: Arc<AtomicU64>,
    /// Half-duplex: optional extra hold on RTS after `send_data` already
    /// waits for the OS-reported TX queue to drain (see `drain_tx`) — covers
    /// latency the OS can't see. Most setups can leave this at 0.
    pub half_duplex_post_delay_ms: Arc<AtomicU64>,
    /// Serializes the RTS-keyed critical section (RS-485/Half-Duplex only):
    /// raise RTS (if not already held) → pre-delay → write → drain. Without
    /// this, two `send_data` calls close together (rapid sends, a macro
    /// firing while a manual send is in flight) could race — one dropping
    /// RTS out from under the other's still-in-progress write, or both
    /// raising/writing concurrently and interleaving bytes on the wire.
    pub tx_key_lock: Arc<tokio::sync::Mutex<()>>,
    /// True while RTS/DE is being held asserted across a possible burst of
    /// back-to-back sends. A send that finds this already true skips
    /// re-raising RTS and re-running the pre-delay — it just extends the
    /// existing hold instead of dropping and re-keying between messages.
    pub tx_keyed: Arc<AtomicBool>,
    /// Bumped by every keyed send as it begins. After finishing its own
    /// write/drain/post-delay, a send only drops RTS if this still matches
    /// the value it recorded — i.e. nobody newer started while it was
    /// finishing up. Otherwise it leaves RTS asserted for that newer send,
    /// which will make the same check itself once it's done. This makes the
    /// *last* send in a burst the one responsible for the final drop.
    pub tx_key_epoch: Arc<AtomicU64>,
    /// Copy of every RX chunk for the remote-share bridge. Survives
    /// reconnects; a send with no subscribers is a cheap no-op.
    pub rx_tap: tokio::sync::broadcast::Sender<Vec<u8>>,
    pub active_baud: Arc<AtomicU64>,
}

/// Desired RTS/DTR levels + XOFF gate, shared with the read/reconnect threads
/// so line states survive auto-reconnect.
#[derive(Clone)]
pub struct LineCtl {
    pub rts: Arc<AtomicBool>,
    pub dtr: Arc<AtomicBool>,
    pub rts_touched: Arc<AtomicBool>,
    pub dtr_touched: Arc<AtomicBool>,
    pub tx_paused: Arc<AtomicBool>,
    pub invert_rts: Arc<AtomicBool>,
    pub invert_dtr: Arc<AtomicBool>,
}

#[derive(Clone, Copy, PartialEq)]
pub enum FlowMode {
    None,
    Hardware,
    Software,
    /// Driver RTS/CTS + app-level XON/XOFF (the serialport crate cannot enable both natively)
    Combined,
    ManualHardware,
    ManualSoftware,
    ManualCombined,
    /// Per TX: wait DCD clear, raise RTS, wait CTS, send, drop RTS
    HalfDuplex,
    /// RTS keys the transceiver direction: high during TX only
    Rs485,
}

impl FlowMode {
    fn driver_flow(self) -> serialport::FlowControl {
        match self {
            FlowMode::Hardware | FlowMode::Combined => serialport::FlowControl::Hardware,
            FlowMode::Software => serialport::FlowControl::Software,
            _ => serialport::FlowControl::None,
        }
    }
    /// App scans RX for XOFF/XON and gates TX on it
    fn soft_gated(self) -> bool {
        matches!(self, FlowMode::Combined | FlowMode::ManualSoftware | FlowMode::ManualCombined)
    }
    /// TX waits for CTS high before sending
    fn waits_cts(self) -> bool {
        matches!(self, FlowMode::ManualHardware | FlowMode::ManualCombined)
    }
    /// RTS is asserted at open time to signal "ready to receive"
    fn asserts_rts_on_open(self) -> bool {
        matches!(self, FlowMode::ManualHardware | FlowMode::ManualCombined)
    }
    /// RTS is keyed per transmission and idles low
    fn keys_rts(self) -> bool {
        matches!(self, FlowMode::HalfDuplex | FlowMode::Rs485)
    }
}

#[derive(Clone)]
pub struct RawParams {
    pub port_name: String,
    pub baud_rate: u32,
    pub data_bits: u8,
    pub stop_bits: u8,
    pub parity: String,
    pub flow_control: String,
}

#[derive(serde::Serialize, Clone)]
pub(crate) struct Payload {
    pub(crate) data: Vec<u8>,
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn parse_data_bits(v: u8) -> Result<serialport::DataBits, String> {
    match v {
        5 => Ok(serialport::DataBits::Five),
        6 => Ok(serialport::DataBits::Six),
        7 => Ok(serialport::DataBits::Seven),
        8 => Ok(serialport::DataBits::Eight),
        _ => Err("Invalid data bits. Must be 5, 6, 7, or 8".to_string()),
    }
}

fn parse_stop_bits(v: u8) -> Result<serialport::StopBits, String> {
    match v {
        1 => Ok(serialport::StopBits::One),
        2 => Ok(serialport::StopBits::Two),
        _ => Err("Invalid stop bits. Must be 1 or 2".to_string()),
    }
}

fn parse_parity(v: &str) -> Result<serialport::Parity, String> {
    match v.to_lowercase().as_str() {
        "none" => Ok(serialport::Parity::None),
        "odd"  => Ok(serialport::Parity::Odd),
        "even" => Ok(serialport::Parity::Even),
        _ => Err("Invalid parity. Must be 'none', 'odd', or 'even'".to_string()),
    }
}

fn parse_flow_mode(v: &str) -> Result<FlowMode, String> {
    match v.to_lowercase().as_str() {
        "none"            => Ok(FlowMode::None),
        "software"        => Ok(FlowMode::Software),
        "hardware"        => Ok(FlowMode::Hardware),
        "combined"        => Ok(FlowMode::Combined),
        "manual_hardware" => Ok(FlowMode::ManualHardware),
        "manual_software" => Ok(FlowMode::ManualSoftware),
        "manual_combined" => Ok(FlowMode::ManualCombined),
        "half_duplex"     => Ok(FlowMode::HalfDuplex),
        "rs485"           => Ok(FlowMode::Rs485),
        _ => Err(format!("Invalid flow control mode: '{}'", v)),
    }
}

fn open_serial(params: &RawParams, mode: FlowMode) -> Result<Box<dyn SerialPort>, String> {
    let db = parse_data_bits(params.data_bits)?;
    let sb = parse_stop_bits(params.stop_bits)?;
    let pa = parse_parity(&params.parity)?;

    let port = serialport::new(&params.port_name, params.baud_rate)
        .timeout(Duration::from_millis(10))
        .data_bits(db)
        .stop_bits(sb)
        .parity(pa)
        .flow_control(mode.driver_flow())
        .open()
        .map_err(|e| e.to_string())?;

    // Discard whatever the driver buffered while the port was closed —
    // otherwise a (re)connect dumps the whole stale backlog into the terminal.
    let _ = port.clear(serialport::ClearBuffer::Input);

    Ok(port)
}

/// Apply DTR and RTS to a freshly opened port. Lines the user has never
/// manually touched are left alone entirely (no write call at all) so the
/// driver's own default — which many boards rely on for correct boot
/// behavior — is undisturbed. Driver-managed RTS modes (Hardware/Combined)
/// leave RTS alone; keyed modes idle it low; manual handshake modes assert
/// it; otherwise the user's desired level is applied only once touched.
fn apply_line_states(port: &mut Box<dyn SerialPort>, mode: FlowMode, lines: &LineCtl) {
    let inv_rts = lines.invert_rts.load(Ordering::SeqCst);
    let inv_dtr = lines.invert_dtr.load(Ordering::SeqCst);

    if lines.dtr_touched.load(Ordering::SeqCst) {
        let _ = port.write_data_terminal_ready(lines.dtr.load(Ordering::SeqCst) != inv_dtr);
    }

    if mode.driver_flow() == serialport::FlowControl::Hardware {
        return;
    }

    if mode.asserts_rts_on_open() {
        lines.rts.store(true, Ordering::SeqCst);
        let _ = port.write_request_to_send(true != inv_rts);
    } else if mode.keys_rts() {
        lines.rts.store(false, Ordering::SeqCst);
        let _ = port.write_request_to_send(false != inv_rts);
    } else if lines.rts_touched.load(Ordering::SeqCst) {
        let _ = port.write_request_to_send(lines.rts.load(Ordering::SeqCst) != inv_rts);
    }
}

// ─── Read thread + Rust-side reconnect ───────────────────────────────────────

fn spawn_read_thread(
    mut read_port: Box<dyn SerialPort>,
    app: AppHandle,
    running: Arc<AtomicBool>,
    reconnecting: Arc<AtomicBool>,
    port_arc: Arc<Mutex<Option<Box<dyn SerialPort>>>>,
    active_port_arc: Arc<Mutex<Option<String>>>,
    params: RawParams,
    lines: LineCtl,
    flow_mode: Arc<Mutex<FlowMode>>,
    rx_tap: tokio::sync::broadcast::Sender<Vec<u8>>,
) {
    thread::spawn(move || {
        let mut buf = vec![0u8; 1000];

        loop {
            if !running.load(Ordering::SeqCst) {
                break;
            }

            match read_port.read(buf.as_mut_slice()) {
                Ok(n) if n > 0 => {
                    // Read live so a flow-control change while connected takes
                    // effect on the next chunk instead of needing a reconnect.
                    let soft_gated = flow_mode.lock().map(|m| m.soft_gated()).unwrap_or(false);
                    let chunk: Vec<u8> = if soft_gated {
                        // Intercept flow-control bytes: XOFF pauses TX, XON resumes.
                        // They are stripped from the displayed stream.
                        let mut filtered = Vec::with_capacity(n);
                        for &b in &buf[..n] {
                            match b {
                                0x13 => lines.tx_paused.store(true, Ordering::SeqCst),
                                0x11 => lines.tx_paused.store(false, Ordering::SeqCst),
                                _ => filtered.push(b),
                            }
                        }
                        filtered
                    } else {
                        buf[..n].to_vec()
                    };

                    if !chunk.is_empty() {
                        if rx_tap.receiver_count() > 0 {
                            let _ = rx_tap.send(chunk.clone());
                        }
                        if app.emit("serial-data", Payload { data: chunk }).is_err() {
                            break; // Window closed
                        }
                    }
                }
                Ok(_) => {}
                Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {
                    // Expected — just check running flag again
                }
                Err(_) => {
                    // Unexpected disconnect
                    if running.load(Ordering::SeqCst) {
                        running.store(false, Ordering::SeqCst);

                        // Clear stale port from mutex
                        if let Ok(mut g) = port_arc.lock() { *g = None; }

                        // Signal reconnecting state and notify frontend
                        reconnecting.store(true, Ordering::SeqCst);
                        app.emit("serial-disconnected", ()).ok();

                        // Spawn Rust-side fast reconnect thread (200ms polling, no IPC)
                        thread::spawn({
                            let reconnecting    = reconnecting.clone();
                            let running         = running.clone();
                            let port_arc        = port_arc.clone();
                            let active_port_arc = active_port_arc.clone();
                            let params          = params.clone();
                            let app             = app.clone();
                            let lines           = lines.clone();
                            let flow_mode       = flow_mode.clone();
                            let rx_tap          = rx_tap.clone();
                            move || reconnect_loop(reconnecting, running, port_arc, active_port_arc, params, app, lines, flow_mode, rx_tap)
                        });
                    }
                    break;
                }
            }
        }
    });
}

fn reconnect_loop(
    reconnecting: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
    port_arc: Arc<Mutex<Option<Box<dyn SerialPort>>>>,
    active_port_arc: Arc<Mutex<Option<String>>>,
    params: RawParams,
    app: AppHandle,
    lines: LineCtl,
    flow_mode: Arc<Mutex<FlowMode>>,
    rx_tap: tokio::sync::broadcast::Sender<Vec<u8>>,
) {
    loop {
        // Check for abort before sleeping
        if !reconnecting.load(Ordering::SeqCst) { break; }

        thread::sleep(Duration::from_millis(200));

        // Check for abort after sleeping (user may have clicked Stop)
        if !reconnecting.load(Ordering::SeqCst) { break; }

        // Re-read the live mode — a flow-control change made while
        // disconnected must survive the reconnect rather than reverting to
        // whatever was in effect when the port first opened.
        let mode = flow_mode.lock().map(|m| *m).unwrap_or(FlowMode::None);

        // Try to open the serial port directly — cheap single syscall
        match open_serial(&params, mode) {
            Ok(mut new_port) => {
                match new_port.try_clone() {
                    Ok(read_port) => {
                        // Restore line states before the port goes live
                        apply_line_states(&mut new_port, mode, &lines);
                        lines.tx_paused.store(false, Ordering::SeqCst);

                        // Store the new port in shared state
                        if let Ok(mut g) = port_arc.lock() { *g = Some(new_port); }
                        if let Ok(mut g) = active_port_arc.lock() { *g = Some(params.port_name.clone()); }

                        // Update flags BEFORE emitting so the frontend sees correct state
                        reconnecting.store(false, Ordering::SeqCst);
                        running.store(true, Ordering::SeqCst);

                        app.emit("serial-reconnected", params.port_name.clone()).ok();

                        // Restart the read thread with fresh state
                        spawn_read_thread(read_port, app, running, reconnecting, port_arc, active_port_arc, params, lines, flow_mode, rx_tap);
                        break;
                    }
                    Err(_) => { /* try_clone failed, keep looping */ }
                }
            }
            Err(_) => { /* Port not available yet, keep looping */ }
        }
    }
}

// ─── Commands ────────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct SerialPortInfo {
    port_name: String,
    description: String,
}

#[tauri::command]
pub fn list_ports() -> Result<Vec<SerialPortInfo>, String> {
    match serialport::available_ports() {
        Ok(ports) => {
            let result: Vec<SerialPortInfo> = ports.into_iter().map(|p| {
                let description = match p.port_type {
                    serialport::SerialPortType::UsbPort(info) => {
                        format!("{} - {}", info.product.unwrap_or_else(|| "USB Device".to_string()),
                                info.manufacturer.unwrap_or_else(|| "Unknown".to_string()))
                    }
                    serialport::SerialPortType::PciPort => "PCI Port".to_string(),
                    serialport::SerialPortType::BluetoothPort => "Bluetooth Port".to_string(),
                    serialport::SerialPortType::Unknown => "Unknown Device".to_string(),
                };
                SerialPortInfo { port_name: p.port_name, description }
            }).collect();
            Ok(result)
        }
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn open_port(
    port_name: String,
    baud_rate: u32,
    data_bits: u8,
    stop_bits: u8,
    parity: String,
    flow_control: String,
    invert_rts: bool,
    invert_dtr: bool,
    invert_cts: bool,
    invert_dsr: bool,
    invert_cd: bool,
    invert_ri: bool,
    rs485_pre_delay_ms: u64,
    rs485_post_delay_ms: u64,
    half_duplex_pre_delay_ms: u64,
    half_duplex_post_delay_ms: u64,
    app: AppHandle,
    state: State<'_, SerialState>,
    bridge: State<'_, BridgeState>,
) -> Result<(), String> {
    if bridge.is_remote_active() {
        return Err("Disconnect from the remote share first".to_string());
    }
    let mut port_guard = state.port.lock().map_err(|e| e.to_string())?;

    if port_guard.is_some() {
        return Err("Port already open".to_string());
    }
    state.active_baud.store(baud_rate as u64, Ordering::SeqCst);

    state.invert_rts.store(invert_rts, Ordering::SeqCst);
    state.invert_dtr.store(invert_dtr, Ordering::SeqCst);
    state.invert_cts.store(invert_cts, Ordering::SeqCst);
    state.invert_dsr.store(invert_dsr, Ordering::SeqCst);
    state.invert_cd.store(invert_cd, Ordering::SeqCst);
    state.invert_ri.store(invert_ri, Ordering::SeqCst);
    state.rs485_pre_delay_ms.store(rs485_pre_delay_ms, Ordering::SeqCst);
    state.rs485_post_delay_ms.store(rs485_post_delay_ms, Ordering::SeqCst);
    state.half_duplex_pre_delay_ms.store(half_duplex_pre_delay_ms, Ordering::SeqCst);
    state.half_duplex_post_delay_ms.store(half_duplex_post_delay_ms, Ordering::SeqCst);

    let params = RawParams { port_name: port_name.clone(), baud_rate, data_bits, stop_bits, parity, flow_control };
    let mode = parse_flow_mode(&params.flow_control)?;
    let mut port = open_serial(&params, mode)?;
    let read_port = port.try_clone().map_err(|e| e.to_string())?;

    let lines = LineCtl {
        rts: state.rts.clone(),
        dtr: state.dtr.clone(),
        rts_touched: state.rts_touched.clone(),
        dtr_touched: state.dtr_touched.clone(),
        tx_paused: state.tx_paused.clone(),
        invert_rts: state.invert_rts.clone(),
        invert_dtr: state.invert_dtr.clone(),
    };
    apply_line_states(&mut port, mode, &lines);

    *state.flow_mode.lock().map_err(|e| e.to_string())? = mode;
    state.tx_paused.store(false, Ordering::SeqCst);

    *state.active_port.lock().map_err(|e| e.to_string())? = Some(port_name);

    state.reconnecting.store(false, Ordering::SeqCst);
    state.running.store(true, Ordering::SeqCst);

    *port_guard = Some(port);
    drop(port_guard); // Release lock before spawning thread

    spawn_read_thread(
        read_port,
        app,
        state.running.clone(),
        state.reconnecting.clone(),
        state.port.clone(),
        state.active_port.clone(),
        params,
        lines,
        state.flow_mode.clone(),
        state.rx_tap.clone(),
    );

    Ok(())
}

#[tauri::command]
pub fn close_port(state: State<'_, SerialState>, bridge: State<'_, BridgeState>) -> Result<(), String> {
    // Also tears down any remote session or share — the frontend's disconnect,
    // reconnect-timeout and no-auto-reconnect paths all funnel through here.
    bridge.stop_remote();
    bridge.stop_share();

    // Stop both the read thread and any ongoing reconnect
    state.running.store(false, Ordering::SeqCst);
    state.reconnecting.store(false, Ordering::SeqCst);

    *state.active_port.lock().map_err(|e| e.to_string())? = None;
    *state.port.lock().map_err(|e| e.to_string())? = None;
    state.tx_paused.store(false, Ordering::SeqCst);
    // Don't leave a stale "keyed" hold across a disconnect — the next
    // connection's first send must raise RTS and run its pre-delay again.
    state.tx_keyed.store(false, Ordering::SeqCst);

    Ok(())
}

#[tauri::command]
pub fn get_connection_status(state: State<'_, SerialState>) -> Result<Option<String>, String> {
    Ok(state.active_port.lock().map_err(|e| e.to_string())?.clone())
}

/// Poll `cond` every 5 ms until it holds, or fail after 2 s with a clear
/// flow-control error instead of hanging the send. Sleeps via Tokio rather
/// than `thread::sleep` so waiting here yields the thread back to the async
/// runtime instead of blocking it — a stalled CTS/XOFF wait must not be able
/// to stall anything else (including, depending on Tauri's IPC dispatch,
/// the UI) for up to 2 seconds.
async fn wait_until(mut cond: impl FnMut() -> bool, what: &str) -> Result<(), String> {
    const TIMEOUT: Duration = Duration::from_secs(2);
    let start = std::time::Instant::now();
    while !cond() {
        if start.elapsed() > TIMEOUT {
            return Err(format!("Flow control timeout: {}", what));
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    Ok(())
}

/// Wait for the OS-reported TX queue to actually empty after a write, instead
/// of trusting `flush()` alone to mean "on the wire". `flush()` maps to
/// `tcdrain()` on POSIX and `FlushFileBuffers()` on Windows — the latter in
/// particular is known to return once the driver has accepted the bytes, not
/// once a USB-serial bridge (FTDI/CP210x/CH340, etc.) has actually clocked
/// them out. `bytes_to_write()` (`TIOCOUTQ` / `ClearCommError`'s `cbOutQue`)
/// gives a real, live queue depth to poll instead of guessing a fixed delay.
/// Same 2 s ceiling as `wait_until`, for the same reason: never block a send
/// indefinitely if a device disconnects mid-transmit or a driver misreports.
// Takes `&mut` rather than `&` even though `bytes_to_write` only needs `&self`
// — `dyn SerialPort` isn't `Sync`, so a shared `&dyn SerialPort` held across
// the `.await` below would make this function's future non-`Send` (Tauri
// commands must return `Send` futures). `&mut dyn SerialPort` only needs the
// port type itself to be `Send`, which it is.
async fn drain_tx(port: &mut dyn SerialPort) {
    const TIMEOUT: Duration = Duration::from_secs(2);
    let start = std::time::Instant::now();
    loop {
        match port.bytes_to_write() {
            Ok(0) => return,
            Err(_) => return, // not supported here — nothing more we can check
            Ok(_) => {}
        }
        if start.elapsed() > TIMEOUT {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

/// Release RTS/DE after an optional grace delay, but only if nobody newer
/// has started a keyed send since `my_epoch` was recorded (see
/// `SerialState::tx_key_epoch`). Spawned as a detached task so `send_data`
/// can return to the caller as soon as its own write is confirmed drained,
/// instead of blocking every command for the full grace period — a rapid
/// next send can then catch RTS still asserted (via `tx_keyed`) and extend
/// the hold instead of racing a drop that belongs to a different message.
fn schedule_rts_release(
    port_arc: Arc<Mutex<Option<Box<dyn SerialPort>>>>,
    key_lock: Arc<tokio::sync::Mutex<()>>,
    keyed: Arc<AtomicBool>,
    epoch: Arc<AtomicU64>,
    my_epoch: u64,
    post_delay_ms: u64,
    inv_rts: bool,
) {
    tokio::spawn(async move {
        if post_delay_ms > 0 {
            tokio::time::sleep(Duration::from_millis(post_delay_ms)).await;
        }
        let _guard = key_lock.lock().await;
        if epoch.load(Ordering::SeqCst) != my_epoch {
            // A newer send started while we were waiting — it (or whichever
            // one finishes last) is responsible for the eventual release.
            return;
        }
        if let Ok(mut port_guard) = port_arc.lock() {
            if let Some(port) = port_guard.as_mut() {
                let _ = port.write_request_to_send(false != inv_rts);
            }
        }
        keyed.store(false, Ordering::SeqCst);
    });
}

/// Clone the live port handle and release `state.port` immediately. Clones
/// share the same underlying OS device — settings and line state written to
/// one are visible through the others — so every command does its actual
/// (possibly blocking) I/O on a private clone instead of holding the shared
/// mutex. Otherwise a single write that hangs at the driver level (e.g.
/// hardware flow control with CTS stuck low after a disconnect) wedges every
/// other command waiting on that same lock: close_port, RTS/DTR toggles,
/// modem-line polling, even the reconnect path.
fn clone_port(port_arc: &Mutex<Option<Box<dyn SerialPort>>>) -> Result<Box<dyn SerialPort>, String> {
    let port_guard = port_arc.lock().map_err(|e| e.to_string())?;
    let port = port_guard.as_ref().ok_or_else(|| "No port open".to_string())?;
    port.try_clone().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn send_data(data: Vec<u8>, state: State<'_, SerialState>, bridge: State<'_, BridgeState>) -> Result<(), String> {
    if let Some(tx) = bridge.remote_sender()? {
        return tx.send(data).map_err(|_| "Remote link is down".to_string());
    }
    send_data_inner(data, &state).await
}

/// Local TX with full flow-control semantics — shared by the `send_data`
/// command and the remote-share bridge so remote TX honors RS-485 keying etc.
pub async fn send_data_inner(data: Vec<u8>, state: &SerialState) -> Result<(), String> {
    let mode = *state.flow_mode.lock().map_err(|e| e.to_string())?;

    // Software gate: a received XOFF pauses TX until the peer sends XON
    if mode.soft_gated() {
        let tx_paused = state.tx_paused.clone();
        wait_until(|| !tx_paused.load(Ordering::SeqCst), "XOFF active, peer has paused TX").await?;
    }

    let mut port = clone_port(&state.port)?;
    let inv_rts = state.invert_rts.load(Ordering::SeqCst);
    let inv_cts = state.invert_cts.load(Ordering::SeqCst);
    let inv_cd = state.invert_cd.load(Ordering::SeqCst);

    if mode.waits_cts() {
        wait_until(|| port.read_clear_to_send().unwrap_or(false) != inv_cts, "CTS not asserted").await?;
    }

    match mode {
        FlowMode::HalfDuplex => {
            // Serialize the keyed critical section: without this, two sends
            // close together (rapid Enter, a macro firing mid-send) could
            // race on RTS or interleave writes on the wire.
            let key_guard = state.tx_key_lock.lock().await;
            let already_keyed = state.tx_keyed.load(Ordering::SeqCst);

            // Already-keyed sends skip the DCD/CTS handshake and pre-delay
            // entirely — they extend the existing hold instead of dropping
            // and re-keying between back-to-back messages.
            let handshake: Result<(), String> = if already_keyed {
                Ok(())
            } else {
                wait_until(|| !(port.read_carrier_detect().unwrap_or(false) != inv_cd), "carrier detected (DCD high)").await?;
                port.write_request_to_send(true != inv_rts).map_err(|e| e.to_string())?;
                let cts = wait_until(|| port.read_clear_to_send().unwrap_or(false) != inv_cts, "CTS not asserted").await;
                if cts.is_ok() {
                    state.tx_keyed.store(true, Ordering::SeqCst);
                    let pre_delay = state.half_duplex_pre_delay_ms.load(Ordering::SeqCst);
                    if pre_delay > 0 {
                        tokio::time::sleep(Duration::from_millis(pre_delay)).await;
                    }
                }
                cts
            };

            let my_epoch = state.tx_key_epoch.fetch_add(1, Ordering::SeqCst) + 1;
            let result = match handshake {
                Ok(_) => {
                    let r = port.write_all(&data)
                        .and_then(|_| port.flush())
                        .map_err(|e| e.to_string());
                    if r.is_ok() {
                        drain_tx(&mut *port).await;
                    }
                    r
                }
                Err(e) => Err(e),
            };
            drop(key_guard); // let a send arriving right now proceed immediately — RTS stays up for it

            // Optional extra margin on top of drain_tx's real wait, for
            // latency it can't see (e.g. a USB-serial bridge's own onboard
            // buffer) — skipped on a failed write, so a failure doesn't
            // needlessly hold the bus for the configured grace period.
            let post_delay = if result.is_ok() { state.half_duplex_post_delay_ms.load(Ordering::SeqCst) } else { 0 };
            schedule_rts_release(state.port.clone(), state.tx_key_lock.clone(), state.tx_keyed.clone(), state.tx_key_epoch.clone(), my_epoch, post_delay, inv_rts);
            result
        }
        FlowMode::Rs485 => {
            let key_guard = state.tx_key_lock.lock().await;
            let already_keyed = state.tx_keyed.load(Ordering::SeqCst);
            if !already_keyed {
                port.write_request_to_send(true != inv_rts).map_err(|e| e.to_string())?;
                state.tx_keyed.store(true, Ordering::SeqCst);
                let pre_delay = state.rs485_pre_delay_ms.load(Ordering::SeqCst);
                if pre_delay > 0 {
                    tokio::time::sleep(Duration::from_millis(pre_delay)).await;
                }
            }

            let my_epoch = state.tx_key_epoch.fetch_add(1, Ordering::SeqCst) + 1;
            let result = port.write_all(&data)
                .and_then(|_| port.flush()) // drain before releasing the bus
                .map_err(|e| e.to_string());
            if result.is_ok() {
                drain_tx(&mut *port).await;
            }
            drop(key_guard); // let a send arriving right now proceed immediately — RTS stays up for it

            let post_delay = if result.is_ok() { state.rs485_post_delay_ms.load(Ordering::SeqCst) } else { 0 };
            schedule_rts_release(state.port.clone(), state.tx_key_lock.clone(), state.tx_keyed.clone(), state.tx_key_epoch.clone(), my_epoch, post_delay, inv_rts);
            result
        }
        _ => port.write_all(&data).map_err(|e| e.to_string()),
    }
}

// ─── Modem line control ──────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct ModemLines {
    cts: bool,
    dsr: bool,
    cd: bool,
    ri: bool,
}

#[tauri::command]
pub fn set_rts(level: bool, state: State<'_, SerialState>) -> Result<(), String> {
    state.rts.store(level, Ordering::SeqCst);
    state.rts_touched.store(true, Ordering::SeqCst);
    let mut port_guard = state.port.lock().map_err(|e| e.to_string())?;
    if let Some(port) = port_guard.as_mut() {
        let inv = state.invert_rts.load(Ordering::SeqCst);
        port.write_request_to_send(level != inv).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn set_dtr(level: bool, state: State<'_, SerialState>) -> Result<(), String> {
    state.dtr.store(level, Ordering::SeqCst);
    state.dtr_touched.store(true, Ordering::SeqCst);
    let mut port_guard = state.port.lock().map_err(|e| e.to_string())?;
    if let Some(port) = port_guard.as_mut() {
        let inv = state.invert_dtr.load(Ordering::SeqCst);
        port.write_data_terminal_ready(level != inv).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn set_invert_rts(invert: bool, state: State<'_, SerialState>) -> Result<(), String> {
    state.invert_rts.store(invert, Ordering::SeqCst);
    // Re-drive the line immediately under the new polarity, whether it's
    // idling (RS-485/half-duplex) or holding a manually-set level.
    let mut port_guard = state.port.lock().map_err(|e| e.to_string())?;
    if let Some(port) = port_guard.as_mut() {
        let mode = *state.flow_mode.lock().map_err(|e| e.to_string())?;
        let lines = LineCtl {
            rts: state.rts.clone(),
            dtr: state.dtr.clone(),
            rts_touched: state.rts_touched.clone(),
            dtr_touched: state.dtr_touched.clone(),
            tx_paused: state.tx_paused.clone(),
            invert_rts: state.invert_rts.clone(),
            invert_dtr: state.invert_dtr.clone(),
        };
        apply_line_states(port, mode, &lines);
    }
    Ok(())
}

#[tauri::command]
pub fn set_invert_dtr(invert: bool, state: State<'_, SerialState>) -> Result<(), String> {
    state.invert_dtr.store(invert, Ordering::SeqCst);
    let mut port_guard = state.port.lock().map_err(|e| e.to_string())?;
    if let Some(port) = port_guard.as_mut() {
        let mode = *state.flow_mode.lock().map_err(|e| e.to_string())?;
        let lines = LineCtl {
            rts: state.rts.clone(),
            dtr: state.dtr.clone(),
            rts_touched: state.rts_touched.clone(),
            dtr_touched: state.dtr_touched.clone(),
            tx_paused: state.tx_paused.clone(),
            invert_rts: state.invert_rts.clone(),
            invert_dtr: state.invert_dtr.clone(),
        };
        apply_line_states(port, mode, &lines);
    }
    Ok(())
}

#[tauri::command]
pub fn set_rs485_pre_delay(delay_ms: u64, state: State<'_, SerialState>) -> Result<(), String> {
    state.rs485_pre_delay_ms.store(delay_ms, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn set_rs485_post_delay(delay_ms: u64, state: State<'_, SerialState>) -> Result<(), String> {
    state.rs485_post_delay_ms.store(delay_ms, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn set_half_duplex_pre_delay(delay_ms: u64, state: State<'_, SerialState>) -> Result<(), String> {
    state.half_duplex_pre_delay_ms.store(delay_ms, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn set_half_duplex_post_delay(delay_ms: u64, state: State<'_, SerialState>) -> Result<(), String> {
    state.half_duplex_post_delay_ms.store(delay_ms, Ordering::SeqCst);
    Ok(())
}

// Input lines: just flip the flag — the next read naturally reflects it, no
// re-drive needed since these are inputs, not outputs.
#[tauri::command]
pub fn set_invert_cts(invert: bool, state: State<'_, SerialState>) -> Result<(), String> {
    state.invert_cts.store(invert, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn set_invert_dsr(invert: bool, state: State<'_, SerialState>) -> Result<(), String> {
    state.invert_dsr.store(invert, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn set_invert_cd(invert: bool, state: State<'_, SerialState>) -> Result<(), String> {
    state.invert_cd.store(invert, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn set_invert_ri(invert: bool, state: State<'_, SerialState>) -> Result<(), String> {
    state.invert_ri.store(invert, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn set_flow_control(flow_control: String, state: State<'_, SerialState>) -> Result<(), String> {
    let mode = parse_flow_mode(&flow_control)?;
    let mut port_guard = state.port.lock().map_err(|e| e.to_string())?;
    let port = port_guard.as_mut().ok_or_else(|| "No port open".to_string())?;

    port.set_flow_control(mode.driver_flow()).map_err(|e| e.to_string())?;

    let lines = LineCtl {
        rts: state.rts.clone(),
        dtr: state.dtr.clone(),
        rts_touched: state.rts_touched.clone(),
        dtr_touched: state.dtr_touched.clone(),
        tx_paused: state.tx_paused.clone(),
        invert_rts: state.invert_rts.clone(),
        invert_dtr: state.invert_dtr.clone(),
    };
    apply_line_states(port, mode, &lines);

    *state.flow_mode.lock().map_err(|e| e.to_string())? = mode;
    state.tx_paused.store(false, Ordering::SeqCst);

    Ok(())
}

#[tauri::command]
pub fn read_modem_lines(state: State<'_, SerialState>) -> Result<ModemLines, String> {
    let mut port_guard = state.port.lock().map_err(|e| e.to_string())?;
    let port = port_guard.as_mut().ok_or_else(|| "No port open".to_string())?;
    // Some adapters don't wire every line; report those as low instead of failing
    Ok(ModemLines {
        cts: port.read_clear_to_send().unwrap_or(false) != state.invert_cts.load(Ordering::SeqCst),
        dsr: port.read_data_set_ready().unwrap_or(false) != state.invert_dsr.load(Ordering::SeqCst),
        cd:  port.read_carrier_detect().unwrap_or(false) != state.invert_cd.load(Ordering::SeqCst),
        ri:  port.read_ring_indicator().unwrap_or(false) != state.invert_ri.load(Ordering::SeqCst),
    })
}

#[tauri::command]
pub fn log_to_file(path: String, data: Vec<u8>) -> Result<(), String> {
    use std::fs::{OpenOptions, create_dir_all};
    use std::path::Path;

    if let Some(parent) = Path::new(&path).parent() {
        if !parent.exists() {
            create_dir_all(parent).map_err(|e| format!("Failed to create log directory: {}", e))?;
        }
    }

    let mut file = OpenOptions::new().create(true).append(true).open(&path).map_err(|e| e.to_string())?;
    file.write_all(&data).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn write_to_file(path: String, data: Vec<u8>) -> Result<(), String> {
    use std::fs::{OpenOptions, create_dir_all};
    use std::path::Path;

    if let Some(parent) = Path::new(&path).parent() {
        if !parent.exists() {
            create_dir_all(parent).map_err(|e| format!("Failed to create parent directory: {}", e))?;
        }
    }

    let mut file = OpenOptions::new().create(true).write(true).truncate(true).open(&path).map_err(|e| e.to_string())?;
    file.write_all(&data).map_err(|e| e.to_string())?;
    Ok(())
}
