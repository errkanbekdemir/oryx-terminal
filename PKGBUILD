# Maintainer: Erkan Bekdemir <erkan@example.com>
pkgname=oryx-serial-terminal
pkgver=1.7.0
pkgrel=1
pkgdesc="Premium high-performance serial terminal built with Tauri and React"
arch=('x86_64' 'aarch64')
url="https://github.com/errkanbekdemir/oryx-terminal"
license=('MIT')
depends=('gtk3' 'webkit2gtk-4.1' 'libsoup3' 'libnm')
makedepends=('cargo' 'nodejs' 'npm')
_tag="1.7.0"
source=("${pkgname}-${pkgver}.tar.gz::https://github.com/errkanbekdemir/oryx-terminal/archive/refs/tags/v${_tag}.tar.gz")
sha256sums=('SKIP') # Use 'makepkg -g' to generate

prepare() {
  cd "oryx-terminal-${_tag}"
  
  # Verify Rust environment
  if ! command -v cargo &> /dev/null; then
    echo "ERROR: Cargo not found. Please run 'rustup default stable' first."
    exit 1
  fi
}

build() {
  cd "oryx-terminal-${_tag}"
  npm install
  npm run tauri build -- --bundles deb
}

package() {
  cd "oryx-terminal-${_tag}"
  
  # Extract the files from the generated deb package for simplicity
  # Alternatively, install manually from target/release/oryx
  install -Dm755 "src-tauri/target/release/oryx" "${pkgdir}/usr/bin/oryx"
  
  # Desktop file and icon
  install -Dm644 "src-tauri/icons/icon.png" "${pkgdir}/usr/share/pixmaps/oryx.png"
  
  # Create a simple .desktop file
  mkdir -p "${pkgdir}/usr/share/applications"
  cat > "${pkgdir}/usr/share/applications/oryx.desktop" <<EOF
[Desktop Entry]
Name=ORYX
Comment=Premium Serial Terminal
Exec=/usr/bin/oryx
Icon=oryx
Terminal=false
Type=Application
Categories=Development;Engineering;
EOF
}
