#!/usr/bin/env bash
# Build an LGPL-only FFmpeg/ffprobe for experiments (no --enable-gpl, no nonfree).
# Output: build/ffmpeg-lgpl/bin/{ffmpeg,ffprobe}. Not a distribution build.
# Requires: Xcode command line tools, pkg-config, zimg (brew install pkg-config zimg).
set -euo pipefail

VERSION=7.1
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BUILD="$ROOT/build"
SRC="$BUILD/ffmpeg-$VERSION"
PREFIX="$BUILD/ffmpeg-lgpl"

mkdir -p "$BUILD"
if [ ! -d "$SRC" ]; then
  curl -fsSL "https://ffmpeg.org/releases/ffmpeg-$VERSION.tar.xz" -o "$BUILD/ffmpeg-$VERSION.tar.xz"
  tar -xf "$BUILD/ffmpeg-$VERSION.tar.xz" -C "$BUILD"
fi

cd "$SRC"
./configure \
  --prefix="$PREFIX" \
  --disable-autodetect \
  --disable-network \
  --disable-doc \
  --disable-ffplay \
  --disable-shared \
  --enable-static \
  --enable-zlib \
  --enable-iconv \
  --enable-libzimg \
  --extra-libs=-liconv
make -j"$(sysctl -n hw.ncpu)"
make install

"$PREFIX/bin/ffmpeg" -hide_banner -L | head -3
