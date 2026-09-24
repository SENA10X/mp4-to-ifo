# Third-party software in MP4 to IFO for macOS

MP4 to IFO's own code is MIT-licensed (`LICENSE`). The macOS app also ships the programs below as
separate executables. Each keeps its own license; the MIT license does not apply to them.

The exact build (sources with SHA-256, configure options, linked libraries, minimum macOS) is recorded in
`build-info/toolchain.txt`, produced by `apps/desktop/scripts/build-toolchain.sh`. The license texts are in
`licenses/`. Both folders are copied into the app (`Contents/Resources/licenses`, `…/build-info`) and shown
under Settings → Open Source Licenses.

| Component | Version | License | Source | How it is shipped |
| --- | --- | --- | --- | --- |
| FFmpeg (`ffmpeg`, `ffprobe`) | 7.1 | LGPL-2.1-or-later (built without `--enable-gpl` and `--enable-nonfree`; `ffmpeg -L` reports LGPL 2.1+) | https://ffmpeg.org/releases/ffmpeg-7.1.tar.xz | Two executables in `Contents/MacOS`, run as separate processes |
| zimg | 3.0.5 | WTFPL | https://github.com/sekrit-twc/zimg/archive/refs/tags/release-3.0.5.tar.gz | Statically linked into `ffmpeg` / `ffprobe` (`zscale`, used for experimental HDR → SDR) |
| dvdauthor (`dvdauthor` only) | 0.7.2 | GPL-2.0-or-later | https://downloads.sourceforge.net/project/dvdauthor/dvdauthor-0.7.2.tar.gz | One executable in `Contents/MacOS`, run as a separate process |
| Node.js | 22.23.2 | MIT, plus the licenses of the libraries it contains (listed in its `LICENSE`) | https://nodejs.org/dist/v22.23.2/node-v22.23.2-darwin-arm64.tar.gz (official build, checksum verified) | One executable in `Contents/MacOS` that runs the conversion engine |

Libraries the executables link to are part of macOS (`/usr/lib`, `/System/Library`: libSystem, libc++, libz,
libiconv, libxml2, libicucore, CoreFoundation, CoreVideo, CoreMedia, Security). They are not shipped.

Not shipped: mkisofs / cdrtools (used only as a test reference; the app writes ISO files itself), Homebrew
packages, FFmpeg's GPL-only filters (never used; checked by tests).

## Also inside the app (not separate programs)

- The app binary is built from Rust crates (Tauri 2 and its plugins, serde, libc, and their dependencies),
  mostly MIT / Apache-2.0. A complete generated list (e.g. with `cargo about`) is release work (Phase 6).
- The user interface bundles React and React DOM (MIT) and the Tauri JavaScript API and plugins
  (MIT / Apache-2.0).
- The conversion core and engine are this repository's code (MIT).

## Redistribution notes (to confirm before a public release)

These are the obligations we have identified; they are not legal advice and must be reviewed before
distribution.

- **dvdauthor (GPL-2.0-or-later):** distributing the binary requires offering the complete corresponding
  source: the dvdauthor 0.7.2 tarball above plus the build script and options used. Plan: publish them with
  each release (GitHub Release asset) and state where they are in the app.
- **FFmpeg (LGPL-2.1-or-later):** provide the FFmpeg source used and the configure options (recorded in
  `build-info/toolchain.txt`), and ship the LGPL text. FFmpeg runs as its own executable and is not linked
  into MIT code. See https://ffmpeg.org/legal.html (checklist) for the items to confirm.
- **zimg (WTFPL):** no conditions beyond keeping the notice; the license text is included.
- **Node.js (MIT and bundled licenses):** keep its `LICENSE` (included).
- The app's code signing will sign these executables as part of the bundle; this does not change their
  licenses.
