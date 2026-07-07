#!/bin/bash
# Usage: ./update-version.sh <new-version>
# Example: ./update-version.sh 1.7.0

set -e

if [ -z "$1" ]; then
  echo "Usage: $0 <new-version>"
  echo "Example: $0 1.7.0"
  exit 1
fi

VERSION="$1"

# Validate semver format (x.y.z)
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Error: Version must be in x.y.z format (e.g. 1.7.0)"
  exit 1
fi

# In-place sed differs between GNU (Linux / Windows Git Bash) and BSD (macOS)
if sed --version >/dev/null 2>&1; then
  sedi() { sed -i "$@"; }        # GNU sed
else
  sedi() { sed -i '' "$@"; }     # BSD/macOS sed
fi

echo "Bumping version to $VERSION..."

# package.json
sedi "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" package.json
echo "  package.json          ✓"

# src-tauri/tauri.conf.json
sedi "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" src-tauri/tauri.conf.json
echo "  tauri.conf.json       ✓"

# src-tauri/Cargo.toml (only the [package] version line)
sedi "s/^version = \"[^\"]*\"/version = \"$VERSION\"/" src-tauri/Cargo.toml
echo "  Cargo.toml            ✓"

# PKGBUILD — pkgver and _tag
sedi "s/^pkgver=.*/pkgver=$VERSION/" PKGBUILD
sedi "s/^_tag=.*/\_tag=\"$VERSION\"/" PKGBUILD
echo "  PKGBUILD              ✓"

echo ""
echo "Version updated to $VERSION in all files."
