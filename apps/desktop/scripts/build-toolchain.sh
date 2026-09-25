#!/usr/bin/env bash
# Build the toolchain bundled in the macOS app (Apple Silicon, macOS 14+):
#   ffmpeg, ffprobe  FFmpeg 7.1, LGPL-only (no --enable-gpl / --enable-nonfree), zimg linked statically
#   dvdauthor        0.7.2 from source, system libraries only
#   node             official Node.js binary that runs the conversion core
# Outputs: apps/desktop/src-tauri/binaries/<name>-aarch64-apple-darwin (Tauri sidecars, not in git)
#          third-party/licenses/*, third-party/build-info/*, third-party/sources.json
# The upstream sources are built unmodified (no patches); build/toolchain/src keeps the tarballs, which are
# the corresponding source shipped with a release (docs/release.md).
# Requires: Xcode command line tools, curl, pkg-config, autoconf, automake, libtool (build time only).
set -euo pipefail

FFMPEG_VERSION=7.1
ZIMG_VERSION=3.0.5
DVDAUTHOR_VERSION=0.7.2
NODE_VERSION=22.23.2
MACOS_MIN=14.0
TRIPLE=aarch64-apple-darwin

DESKTOP="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$DESKTOP/../.." && pwd)"
WORK="$DESKTOP/build/toolchain"
PREFIX="$WORK/prefix"
BIN="$DESKTOP/src-tauri/binaries"
LICENSES="$REPO/third-party/licenses"
INFO="$REPO/third-party/build-info"
JOBS="$(sysctl -n hw.ncpu)"

export MACOSX_DEPLOYMENT_TARGET="$MACOS_MIN"
export CFLAGS="-arch arm64 -mmacosx-version-min=$MACOS_MIN -O2"
export CXXFLAGS="$CFLAGS"
export LDFLAGS="-arch arm64 -mmacosx-version-min=$MACOS_MIN"
# Never pick up Homebrew libraries: pkg-config only sees what we build.
export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig"
export PKG_CONFIG_PATH=""

mkdir -p "$WORK/src" "$PREFIX/bin" "$BIN" "$LICENSES" "$INFO"
fetch() { # url file
  [ -f "$WORK/src/$2" ] || curl -fsSL "$1" -o "$WORK/src/$2"
  shasum -a 256 "$WORK/src/$2" | cut -d' ' -f1
}

# --- zimg (WTFPL), static -----------------------------------------------------------
ZIMG_SHA=$(fetch "https://github.com/sekrit-twc/zimg/archive/refs/tags/release-$ZIMG_VERSION.tar.gz" "zimg-$ZIMG_VERSION.tar.gz")
if [ ! -f "$PREFIX/lib/libzimg.a" ]; then
  rm -rf "$WORK/zimg" && mkdir -p "$WORK/zimg"
  tar -xzf "$WORK/src/zimg-$ZIMG_VERSION.tar.gz" -C "$WORK/zimg" --strip-components=1
  (cd "$WORK/zimg" && LIBTOOLIZE=glibtoolize ./autogen.sh >/dev/null && ./configure --prefix="$PREFIX" --disable-shared --enable-static >/dev/null && make -j"$JOBS" >/dev/null && make install >/dev/null)
fi

# --- FFmpeg (LGPL-2.1-or-later build) -------------------------------------------------
FFMPEG_SHA=$(fetch "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" "ffmpeg-$FFMPEG_VERSION.tar.xz")
# A neutral prefix: ffmpeg prints its configuration (and embeds the prefix), so the build machine's paths
# must not appear in it. Nothing is installed there; the binaries are taken from the build tree.
FFMPEG_CONFIGURE=(
  --prefix=/usr/local
  --disable-autodetect --disable-network --disable-doc --disable-ffplay
  --disable-shared --enable-static
  --enable-zlib --enable-iconv --enable-libzimg
  --pkg-config-flags=--static
  --extra-cflags="-mmacosx-version-min=$MACOS_MIN"
  --extra-ldflags="-mmacosx-version-min=$MACOS_MIN"
  --extra-libs="-liconv -lc++"
)
if [ ! -x "$WORK/ffmpeg/ffprobe" ] || [ "$(cat "$WORK/ffmpeg.stamp" 2>/dev/null)" != "${FFMPEG_CONFIGURE[*]}" ]; then
  rm -rf "$WORK/ffmpeg" && mkdir -p "$WORK/ffmpeg"
  tar -xf "$WORK/src/ffmpeg-$FFMPEG_VERSION.tar.xz" -C "$WORK/ffmpeg" --strip-components=1
  (cd "$WORK/ffmpeg" && ./configure "${FFMPEG_CONFIGURE[@]}" >"$WORK/ffmpeg-configure.log" && make -j"$JOBS" >/dev/null)
  echo "${FFMPEG_CONFIGURE[*]}" >"$WORK/ffmpeg.stamp"
fi

# --- dvdauthor (GPL-2.0-or-later), dvdauthor tool only -------------------------------------
# libpng is only used by spumux, which is not built; configure still checks for it.
DVDAUTHOR_SHA=$(fetch "https://downloads.sourceforge.net/project/dvdauthor/dvdauthor-$DVDAUTHOR_VERSION.tar.gz" "dvdauthor-$DVDAUTHOR_VERSION.tar.gz")
SDK="$(xcrun --show-sdk-path)"
if [ ! -x "$PREFIX/bin/dvdauthor" ]; then
  rm -rf "$WORK/dvdauthor" && mkdir -p "$WORK/dvdauthor"
  tar -xzf "$WORK/src/dvdauthor-$DVDAUTHOR_VERSION.tar.gz" -C "$WORK/dvdauthor" --strip-components=1
  (cd "$WORK/dvdauthor" \
    && CFLAGS="$CFLAGS -Wno-error=implicit-function-declaration -Wno-error=int-conversion" \
       XML_CONFIG=/usr/bin/false LIBXML2_CFLAGS="-I$SDK/usr/include/libxml2" LIBXML2_LIBS="-lxml2" \
       LIBPNG_CFLAGS=" " LIBPNG_LIBS=" " \
       ./configure --prefix="$PREFIX" --disable-dvdunauthor >"$WORK/dvdauthor-configure.log" \
    && make -C src -j"$JOBS" dvdauthor >/dev/null \
    && install -m 755 src/dvdauthor "$PREFIX/bin/dvdauthor")
fi

# --- Node.js (official build) -----------------------------------------------------------
NODE_TGZ="node-v$NODE_VERSION-darwin-arm64.tar.gz"
fetch "https://nodejs.org/dist/v$NODE_VERSION/$NODE_TGZ" "$NODE_TGZ" >/dev/null
fetch "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" "node-SHASUMS256-$NODE_VERSION.txt" >/dev/null
NODE_SHA=$(shasum -a 256 "$WORK/src/$NODE_TGZ" | cut -d' ' -f1)
grep -q "$NODE_SHA  $NODE_TGZ" "$WORK/src/node-SHASUMS256-$NODE_VERSION.txt" || { echo "node checksum mismatch" >&2; exit 1; }
rm -rf "$WORK/node" && mkdir -p "$WORK/node"
tar -xzf "$WORK/src/$NODE_TGZ" -C "$WORK/node" --strip-components=1

# --- install sidecars ----------------------------------------------------------------------
install -m 755 "$WORK/ffmpeg/ffmpeg" "$BIN/ffmpeg-$TRIPLE"
install -m 755 "$WORK/ffmpeg/ffprobe" "$BIN/ffprobe-$TRIPLE"
install -m 755 "$PREFIX/bin/dvdauthor" "$BIN/dvdauthor-$TRIPLE"
install -m 755 "$WORK/node/bin/node" "$BIN/node-$TRIPLE"

# --- checks: LGPL, system libraries only, deployment target -------------------------------
"$BIN/ffmpeg-$TRIPLE" -hide_banner -L | tr '\n' ' ' | grep -q 'GNU Lesser General Public License' || { echo "ffmpeg is not LGPL" >&2; exit 1; }
if "$BIN/ffmpeg-$TRIPLE" -hide_banner -version | grep -Eq -- '--enable-(gpl|nonfree)'; then echo "ffmpeg configured with gpl/nonfree" >&2; exit 1; fi
for b in "$BIN"/*-"$TRIPLE"; do
  if strings -a "$b" | grep -Fq -e "$HOME" -e "$REPO"; then echo "$b contains build machine paths" >&2; exit 1; fi
  if otool -L "$b" | tail -n +2 | grep -Ev '^\s+(/usr/lib/|/System/Library/)' | grep -q .; then
    echo "$b links non-system libraries:" >&2; otool -L "$b" >&2; exit 1
  fi
done

# --- licenses and build info -----------------------------------------------------------------
cp "$WORK/ffmpeg/COPYING.LGPLv2.1" "$LICENSES/FFmpeg-LGPL-2.1.txt"
cp "$WORK/ffmpeg/LICENSE.md" "$LICENSES/FFmpeg-LICENSE.md"
cp "$WORK/zimg/COPYING" "$LICENSES/zimg-WTFPL.txt"
cp "$WORK/dvdauthor/COPYING" "$LICENSES/dvdauthor-GPL-2.0.txt"
cp "$WORK/node/LICENSE" "$LICENSES/Node.js-LICENSE.txt"

sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
{
  echo "# Bundled toolchain build ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
  echo "target: $TRIPLE, macOS $MACOS_MIN+, built on macOS $(sw_vers -productVersion) with $(clang --version | head -1)"
  echo
  echo "## FFmpeg $FFMPEG_VERSION (ffmpeg, ffprobe)"
  echo "source: https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz sha256 $FFMPEG_SHA"
  echo "configuration: $("$BIN/ffmpeg-$TRIPLE" -hide_banner -version | sed -n 's/^configuration: //p')"
  echo "license (ffmpeg -L): $("$BIN/ffmpeg-$TRIPLE" -hide_banner -L | tr '\n' ' ' | grep -o 'GNU Lesser General Public License[^.]*version [0-9.]*[^.]*')"
  echo "ffmpeg sha256 $(sha "$BIN/ffmpeg-$TRIPLE")"
  echo "ffprobe sha256 $(sha "$BIN/ffprobe-$TRIPLE")"
  echo
  echo "## zimg $ZIMG_VERSION (statically linked into ffmpeg/ffprobe for zscale)"
  echo "source: https://github.com/sekrit-twc/zimg/archive/refs/tags/release-$ZIMG_VERSION.tar.gz sha256 $ZIMG_SHA"
  echo "configure: --disable-shared --enable-static"
  echo
  echo "## dvdauthor $DVDAUTHOR_VERSION (dvdauthor tool only)"
  echo "source: https://downloads.sourceforge.net/project/dvdauthor/dvdauthor-$DVDAUTHOR_VERSION.tar.gz sha256 $DVDAUTHOR_SHA"
  echo "configure: --disable-dvdunauthor, libxml2 from the macOS SDK"
  echo "dvdauthor sha256 $(sha "$BIN/dvdauthor-$TRIPLE")"
  echo
  echo "## Node.js $NODE_VERSION (runtime for the conversion core)"
  echo "source: https://nodejs.org/dist/v$NODE_VERSION/$NODE_TGZ sha256 $NODE_SHA (verified against SHASUMS256.txt)"
  echo "node sha256 $(sha "$BIN/node-$TRIPLE")"
  echo
  echo "## Linked libraries (system only)"
  for b in "$BIN"/*-"$TRIPLE"; do echo "$(basename "$b"):"; otool -L "$b" | tail -n +2; done
  echo
  echo "## Minimum macOS"
  for b in "$BIN"/*-"$TRIPLE"; do echo "$(basename "$b"): $(vtool -show-build "$b" 2>/dev/null | awk '/minos/{print $2}' | head -1)"; done
} > "$INFO/toolchain.txt"

# Machine-readable: what is shipped, its exact source and how it was built. Binary checksums are of the
# build output, before the release signs the executables (signing changes the bytes, not the code).
ffmpeg_conf=$("$BIN/ffmpeg-$TRIPLE" -hide_banner -version | sed -n 's/^configuration: //p' | sed 's/"/\\"/g')
cat > "$REPO/third-party/sources.json" <<JSON
{
  "note": "Generated by apps/desktop/scripts/build-toolchain.sh. Sources are built unmodified; binary sha256 is before release signing.",
  "target": "$TRIPLE",
  "minimumMacOS": "$MACOS_MIN",
  "components": [
    {
      "component": "FFmpeg",
      "version": "$FFMPEG_VERSION",
      "license": "LGPL-2.1-or-later",
      "licenseFiles": ["FFmpeg-LGPL-2.1.txt", "FFmpeg-LICENSE.md"],
      "sourceUrl": "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz",
      "sourceSha256": "$FFMPEG_SHA",
      "binaries": [
        { "name": "ffmpeg", "sha256": "$(sha "$BIN/ffmpeg-$TRIPLE")" },
        { "name": "ffprobe", "sha256": "$(sha "$BIN/ffprobe-$TRIPLE")" }
      ],
      "modifications": "none",
      "build": { "script": "apps/desktop/scripts/build-toolchain.sh", "configure": "$ffmpeg_conf" }
    },
    {
      "component": "zimg",
      "version": "$ZIMG_VERSION",
      "license": "WTFPL",
      "licenseFiles": ["zimg-WTFPL.txt"],
      "sourceUrl": "https://github.com/sekrit-twc/zimg/archive/refs/tags/release-$ZIMG_VERSION.tar.gz",
      "sourceSha256": "$ZIMG_SHA",
      "binaries": [],
      "linkedInto": ["ffmpeg", "ffprobe"],
      "modifications": "none",
      "build": { "script": "apps/desktop/scripts/build-toolchain.sh", "configure": "--disable-shared --enable-static" }
    },
    {
      "component": "dvdauthor",
      "version": "$DVDAUTHOR_VERSION",
      "license": "GPL-2.0-or-later",
      "licenseFiles": ["dvdauthor-GPL-2.0.txt"],
      "sourceUrl": "https://downloads.sourceforge.net/project/dvdauthor/dvdauthor-$DVDAUTHOR_VERSION.tar.gz",
      "sourceSha256": "$DVDAUTHOR_SHA",
      "binaries": [{ "name": "dvdauthor", "sha256": "$(sha "$BIN/dvdauthor-$TRIPLE")" }],
      "modifications": "none",
      "build": { "script": "apps/desktop/scripts/build-toolchain.sh", "configure": "--disable-dvdunauthor (dvdauthor tool only; libxml2 from the macOS SDK)" }
    },
    {
      "component": "Node.js",
      "version": "$NODE_VERSION",
      "license": "MIT (and the licenses in its LICENSE file)",
      "licenseFiles": ["Node.js-LICENSE.txt"],
      "sourceUrl": "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION.tar.gz",
      "binaryUrl": "https://nodejs.org/dist/v$NODE_VERSION/$NODE_TGZ",
      "binaryArchiveSha256": "$NODE_SHA",
      "binaries": [{ "name": "node", "sha256": "$(sha "$BIN/node-$TRIPLE")" }],
      "modifications": "none (official binary; the release re-signs it)",
      "build": { "script": "apps/desktop/scripts/build-toolchain.sh", "configure": "official build from nodejs.org, checksum verified against SHASUMS256.txt" }
    }
  ]
}
JSON
echo "toolchain ready in $BIN"
