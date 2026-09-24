#!/usr/bin/env node
// Measure field-level motion timing and A/V sync of a DVD output made from a
// make-motion-sample.sh source. Reads VOBs field by field (no deinterlacing).
//
// Usage: node motion-probe.mjs <code-rate> <VIDEO_TS dir>
//   code-rate: rate used to generate the source (e.g. 60000/1001)

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [rateArg, dir] = process.argv.slice(2);
const [rn, rd = '1'] = rateArg.split('/');
const codeRate = Number(rn) / Number(rd);
const vobs = fs.readdirSync(dir).filter((f) => /^VTS_01_[1-9]\.VOB$/.test(f)).sort().map((f) => path.join(dir, f));
const input = `concat:${vobs.join('|')}`;
const W = 720;
const H = 480;
const FRAME = 1001 / 30000;

const probe = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,start_time', '-of', 'json', input], { encoding: 'utf8' }).stdout);
const start = (type) => Number(probe.streams.find((s) => s.codec_type === type)?.start_time ?? 0);

// --- video: read the 12-bit code from each field ---------------------------
const raw = spawnSync('ffmpeg', ['-v', 'error', '-i', input, '-map', '0:v:0', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 2 ** 31 }).stdout;
const frames = raw.length / (W * H);
// Source is 1280x720 16:9 -> full 720 width. Box i centre at x = (i*100+90) * 720/1280.
const cols = Array.from({ length: 12 }, (_, i) => Math.round((i * 100 + 90) * (W / 1280)));
const fields = [];
for (let k = 0; k < frames; k++) {
  for (const parity of [0, 1]) { // TFF: top (even rows) first
    let code = 0;
    for (let i = 0; i < 12; i++) {
      let sum = 0;
      let n = 0;
      for (let y = 100 + parity; y < 380; y += 2) {
        sum += raw[k * W * H + y * W + cols[i]];
        n++;
      }
      if (sum / n > 128) code |= 1 << i;
    }
    fields.push({ display: start('video') + k * FRAME + parity * FRAME / 2, code });
  }
}

// --- timing statistics -------------------------------------------------------
// Judge timing only where a new source frame first appears (holding a frame is not an error).
const firsts = fields.filter((f, i) => i === 0 || f.code !== fields[i - 1].code);
const offsets = firsts.map((f) => f.display - f.code / codeRate).sort((a, b) => a - b);
const offset = offsets[offsets.length >> 1];
const errs = firsts.map((f) => f.display - f.code / codeRate - offset);
const ms = (x) => (x * 1000).toFixed(1);
const rms = Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / errs.length);
const maxAbs = Math.max(...errs.map(Math.abs));
let backwards = 0;
let repeatsAfterPair = 0;
const distinct = new Set(fields.map((f) => f.code));
for (let i = 1; i < fields.length; i++) if (fields[i].code < fields[i - 1].code) backwards++;
// A field repeating the previous field's code across a frame boundary (i.e. more than 2 fields per source frame)
let run = 1;
for (let i = 1; i < fields.length; i++) {
  run = fields[i].code === fields[i - 1].code ? run + 1 : 1;
  if (run === 3) repeatsAfterPair++;
}
const codes = [...distinct].sort((a, b) => a - b);
let skipped = 0;
for (let i = 1; i < codes.length; i++) skipped += codes[i] - codes[i - 1] - 1;
const combed = Array.from({ length: frames }, (_, k) => fields[2 * k].code !== fields[2 * k + 1].code).filter(Boolean).length;

// --- audio: click onsets vs video -----------------------------------------
const pcm = spawnSync('ffmpeg', ['-v', 'error', '-i', input, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 's16le', '-'], { maxBuffer: 1 << 30 }).stdout;
const onsets = [];
let quietUntil = 0;
for (let i = 0; i < pcm.length / 2; i++) {
  if (i < quietUntil) continue;
  if (Math.abs(pcm.readInt16LE(i * 2)) > 3000) {
    onsets.push(start('audio') + i / 48000);
    quietUntil = i + 24000;
  }
}
// Click k was generated at source time k; video shows source time k at display time k + offset.
const sync = onsets.map((t) => t - (Math.round(t - offset) + offset));

console.log(JSON.stringify({
  frames,
  fields: fields.length,
  distinctSourceFrames: distinct.size,
  uniqueFramesPerSecond: +(distinct.size / (frames * FRAME)).toFixed(2),
  skippedSourceFrames: skipped,
  backwardsFields: backwards,
  fieldsShowingSameFrameAsPreviousPair: repeatsAfterPair,
  framesWithTwoDifferentFields: combed,
  timingErrorMs: { rms: ms(rms), max: ms(maxAbs) },
  clicks: onsets.length,
  avSyncMs: onsets.length ? { mean: ms(sync.reduce((a, b) => a + b, 0) / sync.length), maxAbs: ms(Math.max(...sync.map(Math.abs))) } : null,
}, null, 1));
