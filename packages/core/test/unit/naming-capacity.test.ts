import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DVD_PLUS_R_SL_BYTES, LOW_VIDEO_KBPS, MIN_VIDEO_KBPS, TARGET_USABLE_BYTES, diskRequirement, expectedStreamBytes, videoBitrateKbps } from '../../src/capacity.ts';
import type { ConversionError } from '../../src/errors.ts';
import { numberedName, outputBaseName, safeChildPath, volumeLabel } from '../../src/naming.ts';

test('output name keeps Japanese and spaces, replaces unsafe characters', () => {
  assert.equal(outputBaseName('/x/オープニング ムービー.mp4'), 'オープニング ムービー');
  assert.equal(outputBaseName('/x/a:b*c?d.mp4'), 'a_b_c_d');
  assert.equal(outputBaseName('/x/..hidden.mp4'), 'hidden');
  assert.equal(outputBaseName('/x/trailing. .mp4'), 'trailing');
  assert.equal(outputBaseName('/x/.mp4'), '.mp4'.replace(/^\./, '') || 'dvd');
  assert.equal(outputBaseName('/x/   .mp4'), 'dvd');
  const long = outputBaseName(`/x/${'あ'.repeat(100)}.mp4`);
  assert.ok(Buffer.byteLength(long) <= 200);
});

test('numbered names', () => {
  assert.equal(numberedName('opening', 1), 'opening');
  assert.equal(numberedName('opening', 2), 'opening-2');
  assert.equal(numberedName('opening', 3), 'opening-3');
});

test('volume label is A-Z 0-9 _ and at most 30 characters', () => {
  assert.equal(volumeLabel('/x/opening-movie.mp4'), 'OPENING_MOVIE');
  assert.equal(volumeLabel('/x/オープニング ムービー.mp4'), 'DVD_VIDEO');
  assert.equal(volumeLabel('/x/Café Crème.mp4'), 'CAFE_CREME');
  assert.equal(volumeLabel('/x/2026 結婚式 opening.mp4'), '2026_OPENING');
  const l = volumeLabel(`/x/${'a'.repeat(40)}.mp4`);
  assert.equal(l.length, 30);
  assert.match(l, /^[A-Z0-9_]+$/);
});

test('video bitrate: 8000 kbps up to ~72 min, then fills the disc', () => {
  assert.equal(videoBitrateKbps(5 * 60), 8000);
  assert.equal(videoBitrateKbps(72 * 60), 8000);
  assert.equal(videoBitrateKbps(120 * 60), 4690);
  assert.equal(videoBitrateKbps(180 * 60), 3024);
  assert.ok(videoBitrateKbps(160 * 60) < LOW_VIDEO_KBPS);
  assert.ok(videoBitrateKbps(8 * 3600) < MIN_VIDEO_KBPS);
});

test('capacity model stays under the target and the smaller single-layer disc', () => {
  assert.ok(TARGET_USABLE_BYTES < DVD_PLUS_R_SL_BYTES);
  for (const minutes of [75, 90, 120, 180, 240]) {
    const d = minutes * 60;
    assert.ok(expectedStreamBytes(videoBitrateKbps(d), d) <= TARGET_USABLE_BYTES, `${minutes} min`);
  }
  // Phase 2 measurement: 20 min at 8000 kbps muxed to 1,259,787,264 bytes (1.71% overhead).
  assert.ok(expectedStreamBytes(8000, 1200.032) >= 1_259_787_264);
  // Worst measured overhead: 3.17% at 2000 kbps.
  assert.ok(expectedStreamBytes(2000, 180) >= Math.ceil((2001 + 256) * 1000 * 180 / 8 * 1.0317));
});

test('disk requirement covers temp (2x), output (3x) and same-volume peak', () => {
  const r = diskRequirement(1e9, 36000);
  assert.ok(r.temp > 2e9 && r.output > 3e9 && r.sameVolume >= r.output);
});

test('output names stay inside their folder: separators, dot names and absolute names are refused', () => {
  assert.equal(safeChildPath('/out/staging', 'movie.iso'), '/out/staging/movie.iso');
  assert.equal(safeChildPath('/out', 'オープニング ムービー (1)'), '/out/オープニング ムービー (1)');
  for (const name of ['../../x.iso', '../x.iso', '/abs/x.iso', 'a/b.iso', 'a\\b.iso', '..', '.', '', 'x\u0000.iso']) {
    assert.throws(() => safeChildPath('/out/staging', name), (e: ConversionError) => e.code === 'OUTPUT_ERROR' && e.reason === 'OUTPUT_NAME', name);
  }
  // Whatever the source file is called, the planned names are plain names.
  for (const source of ['/in/../../x.mp4', '/in/..mp4', '/in/.hidden.mp4', '/in/a\\b.mp4']) {
    assert.doesNotThrow(() => safeChildPath('/out', `${outputBaseName(source)}.iso`), source);
  }
});
