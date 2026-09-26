# MP4 to IFO

Convert an MP4 video into DVD-Video files for disc authoring: a `VIDEO_TS` folder (IFO / BUP / VOB), a `VIDEO_TS.zip`, and a DVD-Video ISO you can burn to a DVD.

It is made for the common request "please bring your movie as a DVD / IFO file": pick the MP4, and the tool chooses the DVD settings, converts, and verifies the result. No DVD knowledge or encoding settings are needed.

## Status

Public Beta (v0.1.0). The Mac app is published as a GitHub pre-release. The command-line tool runs from this repository; nothing is published to npm.

**Not physically verified.** The output passes software verification, but it has not been tested on physical DVD players. Always burn the disc and test it on a DVD player before submitting it.

## Download

Download `MP4-to-IFO-0.1.0-arm64.dmg` from the [v0.1.0 pre-release](https://github.com/SENA10X/mp4-to-ifo/releases/tag/v0.1.0). It is for Macs with Apple Silicon, signed with a Developer ID and notarized by Apple. Open the DMG and drag MP4 to IFO to Applications.

The app does not check for updates. New beta versions are published on [GitHub Releases](https://github.com/SENA10X/mp4-to-ifo/releases).

## Requirements

- Mac with Apple Silicon
- macOS 14 or later. macOS 14 is the minimum the app is built for; it has not yet been tested on a Mac running macOS 14.
- Intel Macs and Windows are not supported.

The app includes everything it needs (FFmpeg, dvdauthor and a Node.js runtime); nothing else has to be installed. English and Japanese.

## How to use

1. Drop an MP4 onto the window, or click Select MP4.
2. Check the plan (DVD format, estimated size, output folder) and any warnings.
3. Click Convert.
4. The app verifies the output. The files appear only after they pass.
5. Use the output (see below).

## Output

```text
opening/
├── VIDEO_TS/
├── VIDEO_TS.zip
└── opening.iso
```

- `VIDEO_TS/` — the DVD-Video files (IFO / BUP / VOB). This is what "IFO files" usually means; use it with software that expects a `VIDEO_TS` folder.
- `VIDEO_TS.zip` — the same folder as one file, for sending or storing. It is not a disc image; unzip it to get `VIDEO_TS/`.
- `opening.iso` — a DVD-Video disc image to burn with disc-burning software.

If `opening/` already exists, the output goes to `opening-2/`, `opening-3/`, and so on. Nothing is overwritten, and the MP4 is never modified.

The DVD is NTSC, 16:9, 720×480 MPEG-2 with AC-3 stereo audio, and plays automatically without a menu.

## Verification

Before any output appears, it is checked in software: DVD structure, streams, full decode, duration, picture and sound timing against the source, that the motion reaches the interlaced fields, and the ZIP and ISO. If a check fails, no output is kept.

- Software verification is not a test on a DVD player.
- The timing and motion checks compare five short sections of the video with the source, not the whole video.
- A check that a particular video gives nothing to measure (a still picture, silence) is reported as not measured, not as passed.

Details (Japanese): [docs/core.md](docs/core.md#7-verification).

## Supported input

- One `.mp4` file per conversion
- Any size and aspect ratio (4:3 and vertical video get black bars; nothing is cropped or stretched), rotated video
- 23.976, 24, 25, 29.97, 30, 50, 59.94 and 60 fps, and variable frame rate
- Interlaced video (such as 1080i from a camcorder), top or bottom field first: every field is kept, in order
- Audio: stereo, mono, 5.1 (mixed down to stereo), or none (a silent track is added)
- HDR10 and HLG: converted to SDR — **experimental**, a warning is shown

## Unsupported input

- MOV, MKV and other containers
- 4-channel, 7.1 and other multichannel audio layouts
- Dolby Vision without a compatible base layer (such as Profile 5), and unrecognised colour formats
- Videos too long for a single-layer DVD
- Clips shorter than one DVD frame (about 1/30 second), such as a single frame of 50 or 60 fps video
- Subtitle tracks are not carried over (subtitles that are part of the picture are kept)

## Known limitations

- Physical DVD playback has not been verified.
- Apple Silicon only: Intel Macs and Windows are not supported. macOS 14 has not yet been tested on real hardware.
- No automatic updates; check GitHub Releases for new versions.
- HDR10 and HLG to SDR conversion is experimental.
- Progressive video that is flagged as interlaced (for example PAL SD 25PsF) is treated as interlaced and may lose some vertical detail.
- Extracting a `VIDEO_TS.zip` larger than 4 GB has been checked on macOS, not on Windows.
- The content checks only see five short sections of the video: a fault between them is not seen, and a timing error larger than about one second (the ±1 s search range) is not judged.
- Some videos give the content checks nothing to measure (still or uniform pictures, silence, repeating pictures or sounds); those checks are reported as not measured.

## Privacy

Your video never leaves your computer. No telemetry, analytics, uploads or accounts. The Mac app only shows a system notification when a conversion finishes while it is in the background, and stores the chosen language locally.

## CLI

The command-line tool is for developers for now. It is not published to npm and does not bundle any tools; run it from a clone of this repository.

- macOS on Apple Silicon (the tested platform)
- Node.js 22.18 or later
- `ffmpeg`, `ffprobe` and `dvdauthor` on your `PATH`

```bash
npm install
node --conditions=development packages/cli/src/main.ts <input.mp4> [options]
```

| Option | |
| --- | --- |
| `-o, --output <directory>` | Folder to create the output in (default: next to the input) |
| `-y, --yes` | Convert without asking for confirmation (required when not run in a terminal) |
| `--verbose` | Show tool versions, conversion details and a redacted error report on failure |
| `-h, --help` | Show help |
| `--version` | Show the version |

Before converting, the CLI shows what it will do (input, DVD format, estimated size, output folder) and any warnings, then asks to continue. Exit codes: `0` success, `1` conversion failure, `2` input or usage error, `3` verification failure, `4` cancelled. More: [docs/cli.md](docs/cli.md) (Japanese), [packages/cli/README.md](packages/cli/README.md).

## Development

```bash
npm install
npm test          # core, CLI and desktop tests (desktop engine tests need the bundled toolchain)
npm run typecheck
npm run build
```

Tests prefer an LGPL-only FFmpeg in `MP4_TO_IFO_FFMPEG_DIR` or `build/ffmpeg-lgpl` (`scripts/experiments/build-ffmpeg-lgpl.sh`) when one exists, and otherwise use the tools on `PATH`. Standard CI uses the bundled toolchain built by `apps/desktop/scripts/build-toolchain.sh`.

The developer documents are in Japanese.

- `packages/core` — conversion core — [docs/core.md](docs/core.md)
- `packages/cli` — the `mp4-to-ifo` command — [docs/cli.md](docs/cli.md)
- `apps/desktop` — the Mac app (Tauri 2) — [docs/desktop.md](docs/desktop.md). Build with `npm run build:toolchain -w @mp4-to-ifo/desktop` (once) and `npm run app -w @mp4-to-ifo/desktop`; requires Rust.
- Release build (signed, notarized DMG): `npm run release:mac` — [docs/release.md](docs/release.md). Heavy media regression (local `samples/`, not in git, not part of `npm test` or CI): `npm run test:regression`.
- `scripts/poc-convert.mjs` — Phase 2 proof of concept, kept as a historical reference — [docs/poc.md](docs/poc.md)

## License

MIT for the code in this repository ([LICENSE](LICENSE)). The MIT license does not cover third-party software. The Mac app bundles FFmpeg (LGPL-2.1-or-later), zimg (WTFPL), dvdauthor (GPL-2.0-or-later) and Node.js (MIT) as separate programs, plus npm packages and Rust crates under their own licenses; see [third-party/README.md](third-party/README.md). Each release publishes the corresponding source of the bundled FFmpeg, zimg and dvdauthor. mkisofs and isoinfo (cdrtools) are used only as a reference in tests and are not part of the app.
