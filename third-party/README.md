# Third-party software in MP4 to IFO for macOS

MP4 to IFO's own code is MIT-licensed (`LICENSE`). The macOS app also ships the programs below as
separate executables. Each keeps its own license; the MIT license does not apply to them.

The exact build (sources with SHA-256, configure options, linked libraries, minimum macOS) is recorded in
`build-info/toolchain.txt` and, machine-readable, in `sources.json`; both are produced by
`apps/desktop/scripts/build-toolchain.sh`. The license texts are in `licenses/`. These are copied into the app
(`Contents/Resources/licenses`, `…/build-info`); Settings → Open Source Licenses shows every file in
`licenses/`.

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

All four are built or taken unmodified (no patches; checked against the source tarballs).

## Also inside the app (not separate programs)

- The app binary is built from Rust crates (Tauri 2 and its plugins, serde, libc, and their dependencies),
  and the user interface bundles React, React DOM, scheduler and the Tauri JavaScript API and plugins. All are
  used unmodified. `inventory.json` lists each package with its version, license and source, and
  `licenses/Rust-crates-and-npm-packages.txt` (shipped in the app) has their license texts. Both are generated
  from the lockfiles by `apps/desktop/scripts/license-inventory.mjs` (`--check` fails when they are stale).
  Most are MIT / Apache-2.0; four crates are MPL-2.0 (cssparser, dtoa-short, option-ext, selectors;
  unmodified, source on crates.io).
- The conversion core and engine are this repository's code (MIT).

## Source for each release

This software uses code of [FFmpeg](https://ffmpeg.org) licensed under the LGPL-2.1-or-later, and dvdauthor
licensed under the GPL-2.0-or-later. Each release of the Mac app publishes, next to the DMG, the archive
`MP4-to-IFO-<version>-third-party-sources.tar.gz` made by the release script. It contains the exact FFmpeg,
zimg and dvdauthor source tarballs (unmodified, SHA-256 as in `sources.json`), `build-toolchain.sh`,
`toolchain.txt`, `sources.json` and the license texts, i.e. everything needed to rebuild the shipped
executables. The same sources stay available from this repository's release for that version.

- **dvdauthor (GPL-2.0-or-later):** the archive is the complete corresponding source (no modifications; the
  build script and options are included). It is published with the binary, not on request.
- **FFmpeg (LGPL-2.1-or-later):** built without `--enable-gpl` / `--enable-nonfree`; the LGPL text and FFmpeg's
  `LICENSE.md` are in the app; the exact source and configure options are in the archive. FFmpeg runs as its
  own executables (`ffmpeg`, `ffprobe`); no MIT code of this project links to it. zimg is statically linked into
  those executables; its source is in the archive too, so both can be rebuilt with `build-toolchain.sh` and the
  executables in `Contents/MacOS` replaced (the app then has to be re-signed locally, e.g. ad hoc; the
  notarized signature only covers the shipped files).
- **zimg (WTFPL):** keep the notice; included.
- **Node.js (MIT and the licenses in its LICENSE):** keep its `LICENSE` (included). The official binary is
  shipped unmodified; its source is at https://nodejs.org/dist/.
- The release signs these executables (Developer ID, hardened runtime). Signing does not change their code or
  their licenses.

These are the obligations we have identified; they are not legal advice.
