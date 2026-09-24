# MP4 to IFO

Convert an MP4 video into DVD-Video files for disc authoring: a `VIDEO_TS` folder (IFO / BUP / VOB), a `VIDEO_TS.zip`, and a DVD-Video ISO you can burn to a DVD-R.

It is made for the common request "please bring your movie as a DVD / IFO file": pick the MP4, and the tool chooses the DVD settings, converts, and verifies the result. No DVD knowledge or encoding settings are needed.

## Status

Pre-release (0.x). The conversion core, the command-line tool and the Mac app work. No release has been published yet: the Mac app's signed and notarized release build is prepared ([docs/release.md](docs/release.md)) but not distributed, and nothing is published to npm.

**Not physically verified.** The output passes software verification (DVD structure, streams, full decode, picture and sound timing against the source, sampled checks that the motion reaches the interlaced fields, ZIP and ISO checks), but it has not been tested on physical DVD players. Always test the burned disc on a DVD player before submitting it. Checks that a particular video gives nothing to measure (a still picture, silence) are reported as not measured, not as passed.

## Mac app

Apple Silicon, macOS 14 or later. Drop an MP4 onto the window (or click Select MP4), check the plan and any warnings, and click Convert. The app includes everything it needs (FFmpeg, dvdauthor and a Node.js runtime); nothing else has to be installed. English and Japanese.

## CLI requirements

- macOS on Apple Silicon (the tested platform)
- Node.js 22.18 or later
- `ffmpeg`, `ffprobe` and `dvdauthor` on your `PATH`

## CLI usage

```bash
mp4-to-ifo <input.mp4> [options]
```

| Option | |
| --- | --- |
| `-o, --output <directory>` | Folder to create the output in (default: next to the input) |
| `-y, --yes` | Convert without asking for confirmation (required when not run in a terminal) |
| `--verbose` | Show tool versions, conversion details and a redacted error report on failure |
| `-h, --help` | Show help |
| `--version` | Show the version |

Examples:

```bash
mp4-to-ifo opening.mp4                     # creates ./opening/ next to the MP4
mp4-to-ifo opening.mp4 --output ~/Desktop  # creates ~/Desktop/opening/
mp4-to-ifo opening.mp4 --yes               # no confirmation prompt (scripts, CI)
```

Before converting, the CLI shows what it will do (input, DVD format, estimated size, output folder) and any warnings, then asks to continue.

Exit codes: `0` success, `1` conversion failure, `2` input or usage error, `3` verification failure, `4` cancelled.

## Output

```text
opening/
├── VIDEO_TS/        DVD-Video files (IFO / BUP / VOB)
├── VIDEO_TS.zip     VIDEO_TS for storage or transfer (not a DVD by itself)
└── opening.iso      DVD-Video image to burn
```

If `opening/` already exists, the output goes to `opening-2/`, `opening-3/`, and so on. Nothing is overwritten, and the MP4 is never modified. Output appears only after it passes verification.

The DVD is NTSC, 16:9, 720×480 MPEG-2 with AC-3 stereo audio, and plays automatically without a menu.

## Supported input

- One `.mp4` file per conversion
- Any size and aspect ratio (4:3 and vertical video get black bars; nothing is cropped or stretched), rotated video
- 23.976, 24, 25, 29.97, 30, 50, 59.94 and 60 fps, and variable frame rate
- Audio: stereo, mono, 5.1 (mixed down to stereo), or none (a silent track is added)
- HDR10 and HLG: converted to SDR — **experimental**, a warning is shown

## Unsupported input

- MOV, MKV and other containers
- 4-channel, 7.1 and other multichannel audio layouts
- Dolby Vision without a compatible base layer (such as Profile 5), and unrecognised colour formats
- Videos too long for a single-layer DVD
- Clips shorter than one DVD frame (about 1/30 second), such as a single frame of 50 or 60 fps video
- Subtitle tracks are not carried over (subtitles that are part of the picture are kept)

## Privacy

Your video never leaves your computer. No telemetry, analytics, uploads or accounts. The Mac app only shows a system notification when a conversion finishes while it is in the background, and stores the chosen language locally.

## Development

```bash
npm install
npm test          # core, CLI and desktop tests (desktop engine tests need the bundled toolchain)
npm run typecheck
npm run build
node --conditions=development packages/cli/src/main.ts input.mp4   # run the CLI from source
```

Tests prefer an LGPL-only FFmpeg build (the configuration planned for distribution) when one exists in `build/ffmpeg-lgpl` — see `scripts/experiments/build-ffmpeg-lgpl.sh`.

- `packages/core` — conversion core — [docs/core.md](docs/core.md)
- `packages/cli` — the `mp4-to-ifo` command — [docs/cli.md](docs/cli.md)
- `apps/desktop` — the Mac app (Tauri 2) — [docs/desktop.md](docs/desktop.md). Build with `npm run build:toolchain -w @mp4-to-ifo/desktop` (once) and `npm run app -w @mp4-to-ifo/desktop`; requires Rust.
- Release build (signed, notarized DMG): `npm run release:mac` — [docs/release.md](docs/release.md). Heavy media regression (local `samples/`, not in git, not part of `npm test` or CI): `npm run test:regression`.
- `scripts/poc-convert.mjs` — Phase 2 proof of concept, kept as a reference — [docs/poc.md](docs/poc.md)

## License

MIT for the code in this repository. The MIT license does not cover third-party software: FFmpeg, dvdauthor and mkisofs are separate projects under their own licenses; see [docs/poc.md](docs/poc.md#13-license-findings). The Mac app bundles FFmpeg (LGPL-2.1-or-later), zimg (WTFPL), dvdauthor (GPL-2.0-or-later) and Node.js (MIT) as separate programs, plus npm packages and Rust crates under their own licenses; see [third-party/README.md](third-party/README.md). Each release publishes the corresponding source of the bundled FFmpeg, zimg and dvdauthor.
