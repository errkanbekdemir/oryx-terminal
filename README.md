# ORYX - Premium Serial Terminal

[![Tauri](https://img.shields.io/badge/Tauri-v2-FFC131?logo=tauri&logoColor=white)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-v19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![Rust](https://img.shields.io/badge/Rust-v1.75+-000000?logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.6.0-blue.svg)]()

**ORYX** is a premium, high-performance serial terminal designed for modern developers and engineers. Built with the speed of **Rust** and the flexibility of **React**, it offers a rock-solid cross-platform experience for all your serial communication needs.

<img src="app_preview.png" alt="ORYX Preview" width="800"/>

---

## ✨ Key Features

- 💎 **Premium UI**: Stunning design with glassmorphism, smooth animations, and handcrafted themes (Dark & Light).
- 🚀 **High Performance**: Virtualized terminal view capable of handling massive data streams without breaking a sweat.
- 🛠️ **Advanced Configuration**: Granular control over Baud Rate, Data Bits, Stop Bits, Parity, and Flow Control.
- 📟 **Smart View Modes**: Toggle between **Text**, **Char**, **Hex**, **Bin**, **Dec**, and **Oct** views on the fly.
- 🔥 **Advanced Macro System**: Save, categorize, and execute commands from a resizable, color-filtered sidebar. Drag to reorder macros.
- 🕒 **Command History**: Persistent, deduplicated history buffer with dropdown access and arrow-key navigation.
- 💾 **Portability**: Seamlessly Import/Export macro sets via JSON for easy configuration sharing.
- 🎯 **Direct Saving**: One-click "Save to Macro" functionality directly from your command history.
- 📋 **Flexible Line Breaking**: Break lines based on **Timeout**, **Byte Count**, **Chunks**, or specific **Sequences**.
- 📂 **Session Logging**: Robust logging system with automated directory management and session history.
- ⚡ **ESC Sequences**: Full support for escaped characters and C-style strings in TX data (`\h(4F)`, `0x4F`, `\r`, `\n` and more).
- ⌨️ **Keyboard Shortcuts**: Press `?` for a full shortcut reference. Shift+Enter / Shift+Click to send without line ending.
- 🛡️ **Crash Resilient**: Error boundaries prevent a component crash from taking down the whole application.

---

## 🏗️ Tech Stack

- **Backend**: Rust (Tauri v2)
- **Frontend**: React + TypeScript + Tailwind CSS
- **Communication**: `tauri-plugin-serialport`
- **UI Components**: Lucide-React, React Virtuoso (High-Performance List)

---

## 🛠️ Development

### Prerequisites
- [Rust](https://www.rust-lang.org/tools/install)
- [Node.js](https://nodejs.org/)
- OS-specific Tauri dependencies ([Prerequisites](https://tauri.app/v1/guides/getting-started/prerequisites))

### Setup
```bash
# Install dependencies
npm install

# Run in development mode
npm run tauri dev
```

### Arch Linux Native Build (PKGBUILD)

For a native Arch experience, ORYX provides a `PKGBUILD` to compile directly from source and register the app with `pacman`.

#### 1. Setup the Toolchain
If you haven't used Rust on Arch before, install the version manager and initialize the stable compiler:
```bash
sudo pacman -S rustup nodejs npm
rustup default stable
```

#### 2. Build and Install
Run the standard Arch build command in the project root. This will install dependencies, compile the binary, and create a system-level desktop entry:
```bash
makepkg -si
```

#### 3. Linux Serial Permissions
If the app starts but cannot detect or open COM ports, it is likely a permission issue. On Arch Linux, serial ports are owned by the `uucp` group. Add your user to this group:

```bash
sudo usermod -aG uucp $USER
```
**Important**: You must **log out and log back in** (or reboot) for this change to take effect.

> [!TIP]
> This method is preferred over `npm run tauri build` on Arch as it correctly handles system shared libraries (`webkit2gtk-4.1`, `libsoup3`) and provides a clean uninstallation path via `pacman -Rs`.

### macOS

If you see **"ORYX is damaged and can't be opened"** after installing, run:
```bash
xattr -cr /Applications/ORYX.app
```
This removes the macOS quarantine flag. Required because the app is not yet code-signed.

---

## 📝 License
Distributed under the MIT License. See `LICENSE` for more information.

---
Proudly developed with **ORYX** - The future of serial debugging.

## 👤 Author

Erkan Bekdemir  
Embedded Systems Engineer | IoT | Edge Systems  
🔗 LinkedIn: https://linkedin.com/in/erkanbekdemir