use tauri::{AppHandle, Emitter, State};
use serialport::SerialPort;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use std::thread;
use std::io::{Read, Write};

// ─── State ───────────────────────────────────────────────────────────────────

pub struct SerialState {
    pub port: Arc<Mutex<Option<Box<dyn SerialPort>>>>,
    pub running: Arc<AtomicBool>,
    pub reconnecting: Arc<AtomicBool>,
    pub active_port: Arc<Mutex<Option<String>>>,
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
struct Payload {
    data: Vec<u8>,
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

fn parse_flow_control(v: &str) -> Result<serialport::FlowControl, String> {
    match v.to_lowercase().as_str() {
        "none"     => Ok(serialport::FlowControl::None),
        "software" => Ok(serialport::FlowControl::Software),
        "hardware" => Ok(serialport::FlowControl::Hardware),
        _ => Err("Invalid flow control. Must be 'none', 'software', or 'hardware'".to_string()),
    }
}

fn open_serial(params: &RawParams) -> Result<Box<dyn SerialPort>, String> {
    let db = parse_data_bits(params.data_bits)?;
    let sb = parse_stop_bits(params.stop_bits)?;
    let pa = parse_parity(&params.parity)?;
    let fc = parse_flow_control(&params.flow_control)?;

    serialport::new(&params.port_name, params.baud_rate)
        .timeout(Duration::from_millis(10))
        .data_bits(db)
        .stop_bits(sb)
        .parity(pa)
        .flow_control(fc)
        .open()
        .map_err(|e| e.to_string())
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
) {
    thread::spawn(move || {
        let mut buf = vec![0u8; 1000];

        loop {
            if !running.load(Ordering::SeqCst) {
                break;
            }

            match read_port.read(buf.as_mut_slice()) {
                Ok(n) if n > 0 => {
                    if app.emit("serial-data", Payload { data: buf[..n].to_vec() }).is_err() {
                        break; // Window closed
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
                            move || reconnect_loop(reconnecting, running, port_arc, active_port_arc, params, app)
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
) {
    loop {
        // Check for abort before sleeping
        if !reconnecting.load(Ordering::SeqCst) { break; }

        thread::sleep(Duration::from_millis(200));

        // Check for abort after sleeping (user may have clicked Stop)
        if !reconnecting.load(Ordering::SeqCst) { break; }

        // Try to open the serial port directly — cheap single syscall
        match open_serial(&params) {
            Ok(new_port) => {
                match new_port.try_clone() {
                    Ok(read_port) => {
                        // Store the new port in shared state
                        if let Ok(mut g) = port_arc.lock() { *g = Some(new_port); }
                        if let Ok(mut g) = active_port_arc.lock() { *g = Some(params.port_name.clone()); }

                        // Update flags BEFORE emitting so the frontend sees correct state
                        reconnecting.store(false, Ordering::SeqCst);
                        running.store(true, Ordering::SeqCst);

                        app.emit("serial-reconnected", params.port_name.clone()).ok();

                        // Restart the read thread with fresh state
                        spawn_read_thread(read_port, app, running, reconnecting, port_arc, active_port_arc, params);
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
    app: AppHandle,
    state: State<'_, SerialState>,
) -> Result<(), String> {
    let mut port_guard = state.port.lock().map_err(|e| e.to_string())?;

    if port_guard.is_some() {
        return Err("Port already open".to_string());
    }

    let params = RawParams { port_name: port_name.clone(), baud_rate, data_bits, stop_bits, parity, flow_control };
    let port = open_serial(&params)?;
    let read_port = port.try_clone().map_err(|e| e.to_string())?;

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
    );

    Ok(())
}

#[tauri::command]
pub fn close_port(state: State<'_, SerialState>) -> Result<(), String> {
    // Stop both the read thread and any ongoing reconnect
    state.running.store(false, Ordering::SeqCst);
    state.reconnecting.store(false, Ordering::SeqCst);

    *state.active_port.lock().map_err(|e| e.to_string())? = None;
    *state.port.lock().map_err(|e| e.to_string())? = None;

    Ok(())
}

#[tauri::command]
pub fn get_connection_status(state: State<'_, SerialState>) -> Result<Option<String>, String> {
    Ok(state.active_port.lock().map_err(|e| e.to_string())?.clone())
}

#[tauri::command]
pub fn send_data(data: Vec<u8>, state: State<'_, SerialState>) -> Result<(), String> {
    let mut port_guard = state.port.lock().map_err(|e| e.to_string())?;
    if let Some(port) = port_guard.as_mut() {
        port.write_all(&data).map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("No port open".to_string())
    }
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
