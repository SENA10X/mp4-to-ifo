// Mutation check for the verification fixes (Phase 5.1 / 5.2, Beta Hardening): each mutation turns
// one fix off in a copy of packages/core, and the named tests must then fail. A mutation that leaves
// them passing means the tests no longer guard that fix.
//
//   node scripts/mutation-check.mjs            all mutations (a few minutes)
//   node scripts/mutation-check.mjs H3 M5      only those whose id starts with H3 or M5
//
// Uses the LGPL FFmpeg in build/ffmpeg-lgpl when present (as npm test does). Nothing in the working
// tree is changed.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hardening = 'test/integration/verify-hardening.test.ts';
const robustness = 'test/integration/verify-robustness.test.ts';
const unit = 'test/unit/verify.test.ts';
const pipeline = 'test/integration/pipeline.test.ts';

/** id, what is turned off, file, exact text (must occur once), replacement, tests, test name pattern. */
const MUTATIONS = [
  ['H1-a', 'field check never fails', 'src/verify/fields.ts',
    "  const ok = coverage >= MIN_FIELD_COVERAGE && backwardRatio <= MAX_BACKWARD_RATIO &&",
    '  const ok = true || coverage >= MIN_FIELD_COVERAGE && backwardRatio <= MAX_BACKWARD_RATIO &&', [unit, hardening], 'FI-60I|field oracle'],
  ['H1-b', '60i capacity reduced to 29.97 (verifier adopts the fault)', 'src/verify/fields.ts',
    '      return 60000 / 1001; // one moment per field', '      return 30000 / 1001;', [unit, hardening], 'FI-60I|field oracle'],
  ['H1-c', 'field check not recorded', 'src/verify/index.ts',
    "  record('video.field_temporal', fieldTemporal.status, `${strategy}: ${fieldTemporal.reason}`);",
    "  notJudged('video.field_temporal', 'unmeasurable', fieldTemporal.reason);", [hardening], 'FI-60I'],
  ['H2-a', 'sound timing only judged when the picture is measurable', 'src/verify/index.ts',
    "    status: hasSourceAudio ? judge(sync.audioTimingErrorMs, AUDIO_TIMING_TOLERANCE_MS) : 'not_applicable' as CheckStatus,",
    "    status: hasSourceAudio ? (sync.videoTimelineErrorMs === null ? 'unmeasurable' : judge(sync.audioTimingErrorMs, AUDIO_TIMING_TOLERANCE_MS)) : 'not_applicable' as CheckStatus,",
    [hardening], 'FI-AUDIO'],
  ['H2-b', 'sound tolerance loosened to 200 ms', 'src/verify/index.ts',
    'export const AUDIO_TIMING_TOLERANCE_MS = SYNC_TOLERANCE_MS;', 'export const AUDIO_TIMING_TOLERANCE_MS = 200;', [hardening], 'FI-AUDIO'],
  ['H2-c', 'audio ambiguity guard removed', 'src/verify/sync.ts',
    '  return best >= 0.5 && best - runnerUp >= 0.1 ? bestLag / AUDIO_RATE : null;',
    '  return best >= 0.5 || runnerUp > 9 ? bestLag / AUDIO_RATE : null;', [unit, hardening], 'FI-AUDIO|audio timing'],
  ['H3-a', 'picture change point taken from the best-matching repeat, not the start of the moment', 'src/verify/fields.ts',
    '    const src = source[first[k] ?? -1];', '    const src = source[bestFrame[j] ?? -1];', [unit], 'picture timing'],
  ['H3-b', 'repeated frames split into separate moments', 'src/verify/fields.ts',
    '  const boundary = Math.max(SAME_DIST, CLEAR_FACTOR * residual);', '  const boundary = 1e-9;', [unit, robustness], 'picture timing|REG-LOW-MOTION'],
  ['H3-c', 'change points no longer require a clean entry', 'src/verify/fields.ts',
    '    if (j <= 0 || before === null || before === undefined || before >= k) continue;', '    if (j < 0) continue;', [unit, robustness], 'picture timing|REG-'],
  ['M1', 'ffprobe r_frame_rate required again', 'src/verify/index.ts',
    "      v[0].sample_aspect_ratio === '32:27' && v[0].display_aspect_ratio === '16:9', v.map(describe).join('; '));",
    "      v[0].sample_aspect_ratio === '32:27' && v[0].display_aspect_ratio === '16:9' && v[0].r_frame_rate === '30000/1001', v.map(describe).join('; '));",
    [hardening], 'M1'],
  ['M2-a', 'streams counted without packets', 'src/verify/index.ts',
    '  return { real: all.filter((s) => packets(s) > 0), empty: all.filter((s) => packets(s) === 0) };',
    '  return { real: all, empty: all.filter((s) => packets(s) < 0) };', [unit, hardening], 'M2|streams are counted'],
  ['M2-b', 'PES payload evidence ignored', 'src/verify/index.ts',
    "    withPayload.length === 1 && withPayload[0]?.[0] === 'bd-0x80';", '    true;', [unit], 'audio streams'],
  ['M3', 'core ignores planDigest', 'src/job.ts',
    '    if (options.planDigest !== undefined && options.planDigest !== planDigest(plan)) {', "    if (options.planDigest === 'never') {",
    ['test/integration/convert.test.ts'], 'conversion|M6'],
  ['M5', 'only the first sequence extension checked', 'src/dvd/vob.ts',
    '        r.frameRateExtensions[rate] = (r.frameRateExtensions[rate] ?? 0) + 1;',
    '        const firstRate = Object.keys(r.frameRateExtensions)[0] ?? rate; r.frameRateExtensions[firstRate] = (r.frameRateExtensions[firstRate] ?? 0) + 1;',
    [robustness], 'M5'],
  ['M6-a', 'output folder not resolved or identified when planning', 'src/job.ts',
    '  return planConversion(analysis, { ...options, outputDirectory: output.path }, output.id);', '  return planConversion(analysis, options);',
    ['test/integration/convert.test.ts'], 'M6'],
  ['M6-b', 'output folder not re-checked while converting', 'src/job.ts',
    '  if (!pinned || !same) throw', '  if (false && (!pinned || !same)) throw', ['test/integration/convert.test.ts'], 'M6'],
  ['M7', 'windows pooled only (a local fault is averaged away)', 'src/verify/index.ts',
    '  const fieldTemporal = judgeFields(pictures.stats, capacityHz, pictures.windows);', '  const fieldTemporal = judgeFields(pictures.stats, capacityHz);',
    [robustness], 'M7'],
  ['BH-H1-a', 'pictures without structure normalised again (black a zero vector, noise a random one)', 'src/verify/fields.ts',
    '  if (Math.sqrt(Math.max(0, coherent / pairs)) < MIN_STRUCTURE) return null;', '  if (norm === 0) return new Float32Array(PIXELS);',
    [unit, robustness], 'BH-H1'],
  ['BH-H1-b', 'fields without structure counted as unmatched evidence', 'src/verify/fields.ts',
    '    if (!f.px) {\n      bestFrame.push(null);', '    if (!f.px) {\n      stats.fields++;\n      bestFrame.push(null);',
    [unit, robustness], 'BH-H1'],
  ['BH-M4', 'final ISO size not judged against the disc', 'src/verify/index.ts',
    '    ok: margin >= 0,', '    ok: true,', [unit, pipeline], 'ISO capacity|single-layer DVD'],
];

const only = process.argv.slice(2);
const selected = MUTATIONS.filter(([id]) => !only.length || only.some((o) => id.startsWith(o)));
const lgpl = path.join(repo, 'build/ffmpeg-lgpl/bin');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mp4-to-ifo-mutation-'));
const copy = path.join(work, 'packages/core');
fs.cpSync(path.join(repo, 'packages/core'), copy, { recursive: true, filter: (f) => !f.includes(`${path.sep}dist`) });
fs.symlinkSync(path.join(repo, 'node_modules'), path.join(work, 'node_modules'));

let survived = 0;
for (const [id, what, file, from, to, tests, pattern] of selected) {
  const target = path.join(copy, file);
  const original = fs.readFileSync(target, 'utf8');
  const count = original.split(from).length - 1;
  if (count !== 1) {
    console.log(`${id.padEnd(5)} ERROR   ${what}: expected the text once in ${file}, found ${count}`);
    survived++;
    continue;
  }
  fs.writeFileSync(target, original.replace(from, to));
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', `--test-name-pattern=${pattern}`, ...tests], {
    cwd: copy, encoding: 'utf8', env: { ...process.env, ...(fs.existsSync(lgpl) ? { MP4_TO_IFO_FFMPEG_DIR: lgpl } : {}) },
  });
  fs.writeFileSync(target, original);
  const failed = /^# fail (\d+)/m.exec(r.stdout)?.[1] ?? '?';
  const killed = r.status !== 0 && failed !== '0';
  if (!killed) survived++;
  console.log(`${id.padEnd(5)} ${killed ? 'KILLED ' : 'SURVIVED'} ${what} (${failed} failing)`);
}
fs.rmSync(work, { recursive: true, force: true });
console.log(survived ? `${survived} mutation(s) not caught` : `all ${selected.length} mutations caught`);
process.exitCode = survived ? 1 : 0;
