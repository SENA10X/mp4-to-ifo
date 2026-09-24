# mp4-to-ifo

Convert an MP4 video into DVD-Video files for disc authoring: a `VIDEO_TS` folder (IFO / BUP / VOB), a `VIDEO_TS.zip`, and a DVD-Video ISO. Everything runs locally, and every output is verified before it is kept.

**Status:** pre-release (0.x). Not published to npm yet. The output has not been tested on physical DVD players; test the burned disc on a DVD player before relying on it.

## Requirements

- macOS on Apple Silicon (the tested platform)
- Node.js 22.18 or later
- `ffmpeg`, `ffprobe` and `dvdauthor` on your `PATH`

## Usage

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

There are no encoding options: the tool picks the DVD settings from the input.

```bash
mp4-to-ifo opening.mp4                     # creates ./opening/ next to the MP4
mp4-to-ifo opening.mp4 --output ~/Desktop  # creates ~/Desktop/opening/
mp4-to-ifo opening.mp4 --yes               # no confirmation prompt (scripts, CI)
```

Output (`opening-2`, `opening-3`, … if the folder already exists):

```text
opening/
├── VIDEO_TS/
├── VIDEO_TS.zip
└── opening.iso
```

Exit codes: `0` success, `1` conversion failure, `2` input or usage error, `3` verification failure, `4` cancelled.

## Privacy

Your video never leaves your computer. No telemetry, analytics, uploads or accounts.

## License

MIT. FFmpeg and dvdauthor are separate projects under their own licenses.
