// Phase 5.1 verification logic on synthetic data: the field temporal oracle, stream selection by
// packets, and the audio ambiguity rules. Deterministic (seeded patterns, no ffmpeg).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_BACKWARD_RATIO, MIN_FIELD_COVERAGE, MIN_STRUCTURE, addFieldStats, analyseFields, displayFields, judgeFields, normalise, temporalCapacity, type FieldPair, type OutputField,
} from '../../src/verify/fields.ts';
import { DVD_PLUS_R_SL_BYTES } from '../../src/capacity.ts';
import { expectedDisplayTime } from '../../src/profile/frame-rate.ts';
import { carrying, judgeAudioStreams, judgeIsoCapacity } from '../../src/verify/index.ts';
import { matchAudio } from '../../src/verify/sync.ts';

const PIXELS = 64 * 48;

function unit(seed: number, noise = 0, noiseSeed = 0): Float32Array {
  let x = seed * 2654435761 % 4294967296;
  let y = (noiseSeed + 1) * 40503 % 65536;
  const v = new Float32Array(PIXELS);
  let mean = 0;
  for (let i = 0; i < PIXELS; i++) {
    x = (x * 1664525 + 1013904223) % 4294967296;
    y = (y * 75 + 74) % 65537;
    v[i] = x / 4294967296 + noise * (y / 65537 - 0.5);
    mean += v[i]!;
  }
  mean /= PIXELS;
  let norm = 0;
  for (let i = 0; i < PIXELS; i++) {
    v[i] = v[i]! - mean;
    norm += v[i]! ** 2;
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < PIXELS; i++) v[i] = v[i]! / norm;
  return v;
}

/** `seconds` of source at `fps`, one distinct picture per frame (a still when `still`). */
function source(fps: number, seconds: number, still = false): FieldPair[] & { seeds: number[] } {
  const seeds = Array.from({ length: Math.round(fps * seconds) }, (_, i) => (still ? 1 : i + 1));
  const frames = seeds.map((seed, i) => {
    const px = unit(seed);
    return { t: i / fps, duration: 1 / fps, first: 'top' as const, top: px, bottom: px };
  });
  return Object.assign(frames, { seeds });
}

const FIELD = 1001 / 60000;
/** Output fields at 59.94/s, field j showing source frame pick(j) with a little coding noise. */
function fieldsShowing(src: ReturnType<typeof source>, count: number, pick: (j: number) => number): OutputField[] {
  return Array.from({ length: count }, (_, j) => ({
    t: j * FIELD,
    parity: j % 2 ? 'bottom' as const : 'top' as const,
    px: unit(src.seeds[Math.min(src.length - 1, pick(j))]!, 0.02, j),
  }));
}

const cap60i = temporalCapacity('interlace-60i');

test('field oracle: 59.94p -> 59.94i shows every moment; 29.97p labelled 60i shows half', () => {
  const src = source(60000 / 1001, 2);
  const fields = 2 * 60;
  const good = judgeFields(analyseFields(src, fieldsShowing(src, fields, (j) => j), 0.2, 1.8, cap60i).stats, cap60i);
  assert.equal(good.status, 'passed', good.reason);
  assert.ok((good.coverage ?? 0) >= 0.99, good.reason);
  assert.equal(good.backwardRatio, 0);

  const loss = judgeFields(analyseFields(src, fieldsShowing(src, fields, (j) => j - (j % 2)), 0.2, 1.8, cap60i).stats, cap60i);
  assert.equal(loss.status, 'failed', loss.reason);
  assert.ok(loss.coverage! < MIN_FIELD_COVERAGE && loss.coverage! > 0.4, loss.reason);
});

test('field oracle: one window losing half its moments fails even when the others dilute it', () => {
  const src = source(60000 / 1001, 2);
  const good = analyseFields(src, fieldsShowing(src, 120, (j) => j), 0.2, 1.8, cap60i).stats;
  const lossy = analyseFields(src, fieldsShowing(src, 120, (j) => j - (j % 2)), 0.2, 1.8, cap60i).stats;
  const windows = [good, good, good, good, lossy];
  const total = windows.reduce(addFieldStats);
  assert.equal(judgeFields(total, cap60i).status, 'passed', 'pooled alone, the loss is diluted');
  const r = judgeFields(total, cap60i, windows);
  assert.equal(r.status, 'failed', r.reason);
  assert.ok((r.worstWindow.coverage ?? 1) < MIN_FIELD_COVERAGE);
  assert.equal(judgeFields(total, cap60i, [good, good, good, good, good]).status, 'passed');
});

test('field oracle: swapped field order goes back in time', () => {
  const src = source(60000 / 1001, 2);
  const swapped = judgeFields(analyseFields(src, fieldsShowing(src, 120, (j) => j ^ 1), 0.2, 1.8, cap60i).stats, cap60i);
  assert.equal(swapped.status, 'failed', swapped.reason);
  assert.ok(swapped.backwardRatio! > MAX_BACKWARD_RATIO, swapped.reason);
});

test('field oracle: sources with more moments than the strategy carries are judged by its share', () => {
  const src = source(120, 2);
  const every2nd = judgeFields(analyseFields(src, fieldsShowing(src, 120, (j) => Math.round(j * 120 / (60000 / 1001))), 0.2, 1.8, cap60i).stats, cap60i);
  assert.equal(every2nd.status, 'passed', every2nd.reason);
  const cap30 = temporalCapacity('progressive-29.97');
  const progressive = judgeFields(analyseFields(src, fieldsShowing(src, 120, (j) => 4 * (j >> 1)), 0.2, 1.8, cap30).stats, cap30);
  assert.equal(progressive.status, 'passed', progressive.reason);
  const halfOfThat = judgeFields(analyseFields(src, fieldsShowing(src, 120, (j) => 8 * (j >> 2)), 0.2, 1.8, cap30).stats, cap30);
  assert.equal(halfOfThat.status, 'failed', halfOfThat.reason);
});

test('field oracle: a still, too few moments or unmatched fields are unmeasurable, never failed', () => {
  const still = source(60, 2, true);
  const r = judgeFields(analyseFields(still, fieldsShowing(still, 120, (j) => j - (j % 2)), 0.2, 1.8, cap60i).stats, cap60i);
  assert.equal(r.status, 'unmeasurable', r.reason);

  const short = source(60000 / 1001, 0.3);
  assert.equal(judgeFields(analyseFields(short, fieldsShowing(short, 18, (j) => j - (j % 2)), 0.05, 0.25, cap60i).stats, cap60i).status, 'unmeasurable');

  const src = source(60000 / 1001, 2);
  const unrelated: OutputField[] = Array.from({ length: 120 }, (_, j) => ({ t: j * FIELD, parity: 'top', px: unit(10_000 + j) }));
  assert.equal(judgeFields(analyseFields(src, unrelated, 0.2, 1.8, cap60i).stats, cap60i).status, 'unmeasurable');
});

/** 59.94 fps source whose picture changes every `hold` frames; repeats differ only by slight coding noise. */
function heldSource(hold: number, frames: number): ReturnType<typeof source> {
  const fps = 60000 / 1001;
  const seeds = Array.from({ length: frames }, (_, i) => Math.floor(i / hold) + 1);
  const pairs = seeds.map((seed, i) => {
    const px = unit(seed, 0.004, 1000 + i);
    return { t: i / fps, duration: 1 / fps, first: 'top' as const, top: px, bottom: px };
  });
  return Object.assign(pairs, { seeds });
}

test('picture timing: repeated frames are one moment; its start is the change, whichever repeat matches best', () => {
  for (const hold of [1, 2, 4, 6, 10]) {
    const src = heldSource(hold, 120);
    const onTime = analyseFields(src, fieldsShowing(src, 110, (j) => j), 0.2, 1.8, cap60i).changes;
    assert.ok(onTime.length >= Math.floor(1.4 * 60 / hold) - 2, `hold ${hold}: ${onTime.length} changes`);
    for (const c of onTime) assert.ok(Math.abs(c.out - c.src) < 1e-6, `hold ${hold}: ${c.out - c.src}`);
    // One frame (two fields) late, as in the Phase 2 33 ms bug: every change point shows it.
    const late = analyseFields(src, fieldsShowing(src, 110, (j) => Math.max(0, j - 2)), 0.2, 1.8, cap60i).changes;
    assert.ok(late.length > 0 && late.every((c) => Math.abs(c.out - c.src - 2 * FIELD) < 1e-6), `hold ${hold}`);
  }
});

test('picture timing: an entry the output does not show cleanly (unmatched field before it) gives no change point', () => {
  const src = heldSource(4, 120);
  // The field where each new picture should first appear is garbled: the next field is the first match,
  // one field after the real entry. Timing it would invent a 16.7 ms error.
  const fields = fieldsShowing(src, 110, (j) => j).map((f, j) => (j % 4 === 0 ? { ...f, px: unit(50_000 + j) } : f));
  const changes = analyseFields(src, fields, 0.2, 1.8, cap60i).changes;
  assert.deepEqual(changes.filter((c) => Math.abs(c.out - c.src) > 1e-6), []);
});

test('picture timing: when the strategy skips source frames, a repeated picture has no precise start', () => {
  const src = heldSource(4, 120);
  const cap30 = temporalCapacity('progressive-29.97');
  assert.deepEqual(analyseFields(src, fieldsShowing(src, 110, (j) => 2 * (j >> 1)), 0.2, 1.8, cap30).changes, []);
  // Single-frame moments still have one.
  const moving = heldSource(1, 120);
  assert.ok(analyseFields(moving, fieldsShowing(moving, 110, (j) => 2 * (j >> 1)), 0.2, 1.8, cap30).changes.length > 20);
});

test('field oracle: output fields follow each frame\'s own field order flag', () => {
  const a = unit(1);
  const b = unit(2);
  const f = (first: 'top' | 'bottom'): FieldPair => ({ t: 1, duration: 1001 / 30000, first, top: a, bottom: b });
  assert.deepEqual(displayFields([f('top')]).map((x) => [x.parity, x.t]), [['top', 1], ['bottom', 1 + FIELD]]);
  assert.deepEqual(displayFields([f('bottom')]).map((x) => [x.parity, x.t]), [['bottom', 1], ['top', 1 + FIELD]]);
});

test('field oracle: temporal capacity per strategy is the DVD property, not the filter', () => {
  assert.ok(Math.abs(temporalCapacity('interlace-60i') - 59.94) < 0.01);
  assert.ok(Math.abs(temporalCapacity('telecine-3-2') - 23.976) < 0.01);
  for (const s of ['passthrough-29.97', 'decimate-30', 'progressive-29.97'] as const) assert.ok(Math.abs(temporalCapacity(s) - 29.97) < 0.01);
});

test('streams are counted by packets: a listed stream without packets is ignored', () => {
  const streams: Record<string, string | number>[] = [
    { codec_type: 'video', codec_name: 'mpeg2video', nb_read_packets: '30' },
    { codec_type: 'audio', codec_name: 'ac3', id: '0x80', nb_read_packets: '32' },
    { codec_type: 'audio', codec_name: 'mp2', id: '0x1c0', channels: 0, nb_read_packets: '0' },
    { codec_type: 'audio', codec_name: 'mp2', id: '0x1c1' },
  ];
  const audio = carrying(streams, 'audio');
  assert.deepEqual(audio.real.map((s) => s.codec_name), ['ac3']);
  assert.deepEqual(audio.empty.map((s) => s.id), ['0x1c0', '0x1c1']);
  assert.equal(carrying([...streams, { codec_type: 'audio', codec_name: 'ac3', id: '0x81', nb_read_packets: '5' }], 'audio').real.length, 2);
  assert.equal(carrying(streams.filter((s) => s.codec_type !== 'audio' || s.codec_name !== 'ac3'), 'audio').real.length, 0);
});

test('audio streams: ffprobe packets and the VOB\'s PES payload must agree on one AC-3 stereo stream', () => {
  const ac3 = { codec_type: 'audio', codec_name: 'ac3', id: '0x80', sample_rate: '48000', channels: 2, nb_read_packets: '32' };
  const phantom = { codec_type: 'audio', codec_name: 'mp2', id: '0x1c0', sample_rate: '0', channels: 0 };
  assert.equal(judgeAudioStreams([ac3], { 'bd-0x80': 50_000 }).ok, true);
  const withPhantom = judgeAudioStreams([ac3, phantom], { 'bd-0x80': 50_000 });
  assert.equal(withPhantom.ok, true);
  assert.match(withPhantom.detail, /ignored \(no packets\): mp2 0x1c0/);
  // A second stream only the PES scan sees (ffprobe missed it) still fails, and so does no payload at all.
  assert.equal(judgeAudioStreams([ac3], { 'bd-0x80': 50_000, 'mpeg-0xc0': 4_000 }).ok, false);
  assert.equal(judgeAudioStreams([ac3], { 'bd-0x80': 50_000, 'bd-0x81': 50_000 }).ok, false);
  assert.equal(judgeAudioStreams([ac3], {}).ok, false);
  assert.equal(judgeAudioStreams([ac3, { ...ac3, id: '0x81' }], { 'bd-0x80': 50_000, 'bd-0x81': 50_000 }).ok, false);
  assert.equal(judgeAudioStreams([phantom], {}).ok, false);
  assert.equal(judgeAudioStreams([{ ...ac3, channels: 6 }], { 'bd-0x80': 50_000 }).ok, false);
});

test('audio timing: unique peaks are measured; periodic sound and silence are not', () => {
  const rate = 8000;
  const at = (n: number, clicks: number[]) => {
    const s = new Float32Array(n);
    for (const c of clicks) for (let i = 0; i < 160; i++) s[c + i] = Math.sin(i / 2);
    return s;
  };
  // One click; the output hears it 100 ms late.
  const src = at(3 * rate, [rate]);
  const late = at(2 * rate, [Math.round(0.6 * rate)]);
  assert.equal(matchAudio(src, 0, late, 0.5), 0.1);
  // Clicks every 0.2 s: several lags fit equally.
  const pulses = (n: number, offset: number) => at(n, Array.from({ length: Math.floor((n - 200) / 1600) }, (_, k) => offset + k * 1600));
  assert.equal(matchAudio(pulses(3 * rate, 0), 0, pulses(2 * rate, 800), 0.5), null);
  assert.equal(matchAudio(src, 0, new Float32Array(2 * rate), 0.5), null);
});

test('ISO capacity: the written ISO must fit the smaller single-layer disc (DVD+R SL), to the byte', () => {
  assert.equal(judgeIsoCapacity(DVD_PLUS_R_SL_BYTES - 1).ok, true);
  assert.equal(judgeIsoCapacity(DVD_PLUS_R_SL_BYTES).ok, true);
  assert.equal(judgeIsoCapacity(DVD_PLUS_R_SL_BYTES + 1).ok, false);
  assert.equal(judgeIsoCapacity(DVD_PLUS_R_SL_BYTES + 2048).ok, false);
  assert.equal(judgeIsoCapacity(null).ok, false);
  assert.match(judgeIsoCapacity(DVD_PLUS_R_SL_BYTES + 1).detail, /1 bytes over/);
});

test('BH-H1: line sets without structure are no evidence either way; the pictures around them still are', () => {
  const src = source(60000 / 1001, 2);
  const blank = (i: number) => i >= 40 && i < 70; // half a second of black in the source and the output
  const black = Object.assign(src.map((f, i) => (blank(i) ? { ...f, top: null, bottom: null } : f)), { seeds: src.seeds });
  const fields = fieldsShowing(src, 120, (j) => j).map((f, j) => (blank(j) ? { ...f, px: null } : f));
  const a = analyseFields(black, fields, 0.2, 1.8, cap60i);
  const r = judgeFields(a.stats, cap60i);
  assert.equal(r.status, 'passed', r.reason);
  assert.equal(r.coverage, 1, r.reason);
  assert.equal(a.stats.fields, 90, 'black fields are not counted');
  assert.ok(a.changes.length > 60 && a.changes.every((c) => Math.abs(c.out - c.src) < 1e-6), `${a.changes.length} changes`);
  // Timing faults on either side of the black are still seen.
  const late = analyseFields(black, fieldsShowing(src, 120, (j) => Math.max(0, j - 2)).map((f, j) => (blank(j - 2) ? { ...f, px: null } : f)), 0.2, 1.8, cap60i);
  assert.ok(late.changes.length > 60 && late.changes.every((c) => Math.abs(c.out - c.src - 2 * FIELD) < 1e-6));
  // Nothing but black: unmeasurable, never failed.
  const allBlack = src.map((f) => ({ ...f, top: null, bottom: null }));
  const none = judgeFields(analyseFields(allBlack, fields.map((f) => ({ ...f, px: null })), 0.2, 1.8, cap60i).stats, cap60i);
  assert.equal(none.status, 'unmeasurable', none.reason);
});

test('BH-H1: structure floor: flat pictures, near-black noise and grain are not pictures; faint real structure is', () => {
  const W = 64;
  let seed = 12345;
  const noise = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296 - 0.5;
  };
  const line = (f: (x: number, y: number) => number) =>
    Buffer.from(Array.from({ length: 64 * 48 }, (_, i) => Math.max(0, Math.min(255, Math.round(f(i % W, Math.floor(i / W)))))));
  assert.equal(normalise(line(() => 16), 0), null, 'black');
  assert.equal(normalise(line(() => 235), 0), null, 'white');
  assert.equal(normalise(line(() => 16 + 2 * noise()), 0), null, 'near-black noise');
  assert.equal(normalise(line(() => 128 + 14 * noise()), 0), null, 'grain of 4 levels (std) on grey');
  assert.equal(normalise(line((x, y) => 128 + ((x + y) % 2 ? 3 : -3)), 0), null, 'a pixel checkerboard has no coherent structure');
  assert.notEqual(normalise(line((x) => (x < 32 ? 16 : 19)), 0), null, 'two dark areas 3 levels apart (std 1.5)');
  assert.notEqual(normalise(line((x) => 16 + x / 8), 0), null, 'dark gradient 16-24');
  assert.notEqual(normalise(line((x, y) => (x > 28 && x < 36 && y > 22 && y < 26 ? 235 : 16)), 0), null, 'a small title on black');
  assert.equal(MIN_STRUCTURE, 1);
});

test('M-2: a picture that repeats within the search has no time of its own, only candidates', () => {
  const fps = 60000 / 1001;
  const seeds = Array.from({ length: 120 }, (_, i) => (i % 12) + 1); // the same 12 pictures every 200 ms
  const src = Object.assign(seeds.map((seed, i) => {
    const px = unit(seed, 0.004, 1000 + i);
    return { t: i / fps, duration: 1 / fps, first: 'top' as const, top: px, bottom: px };
  }), { seeds });
  const nearest = (c: { out: number; src: number[] }) => Math.min(...c.src.map((s) => Math.abs(c.out - s)));
  const onTime = analyseFields(src, fieldsShowing(src, 110, (j) => j), 0.2, 1.8, cap60i);
  assert.deepEqual(onTime.changes, [], 'no precise change point from a repeating picture');
  assert.equal(judgeFields(onTime.stats, cap60i).status, 'unmeasurable');
  assert.ok(onTime.ambiguous.length > 50, `${onTime.ambiguous.length} entries`);
  assert.ok(onTime.ambiguous.every((c) => c.src.length > 1 && nearest(c) < 1e-6));
  // Two fields late: no repeat explains it.
  const late = analyseFields(src, fieldsShowing(src, 110, (j) => Math.max(0, j - 2)), 0.2, 1.8, cap60i);
  assert.ok(late.ambiguous.length > 50 && late.ambiguous.every((c) => Math.abs(nearest(c) - 2 * FIELD) < 1e-6));
  // A picture that comes back only after the search (400 ms) is still unique.
  const slow = Object.assign(Array.from({ length: 120 }, (_, i) => {
    const px = unit((i % 24) + 1, 0.004, 1000 + i);
    return { t: i / fps, duration: 1 / fps, first: 'top' as const, top: px, bottom: px };
  }), { seeds: Array.from({ length: 120 }, (_, i) => (i % 24) + 1) });
  const unique = analyseFields(slow, fieldsShowing(slow, 110, (j) => j), 0.2, 1.8, cap60i);
  assert.ok(unique.changes.length > 50 && unique.ambiguous.length === 0);
});

test('M-5: passing interlaced frames through carries their fields: capacity and display time per field', () => {
  for (const s of ['passthrough-29.97', 'decimate-30'] as const) {
    assert.ok(Math.abs(temporalCapacity(s, true) - 60000 / 1001) < 1e-9, s);
    assert.ok(Math.abs(temporalCapacity(s) - 30000 / 1001) < 1e-9, s);
    // The second field of a source frame is shown in the second field of the DVD frame.
    assert.ok(Math.abs(expectedDisplayTime(s, 3 * FIELD, true) - 3 * FIELD) < 1e-9, s);
    assert.ok(Math.abs(expectedDisplayTime(s, 2 * FIELD, true) - 2 * FIELD) < 1e-9, s);
  }
  // Whole-frame output of an interlaced source (progressive policy) still carries one moment per frame.
  assert.ok(Math.abs(temporalCapacity('progressive-29.97', true) - 30000 / 1001) < 1e-9);
  assert.ok(Math.abs(temporalCapacity('interlace-60i', true) - temporalCapacity('interlace-60i')) < 1e-9);
});
