import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyHdr, detectVariableFrameRate } from '../../src/analyze.ts';
import { CLIP_GUARD_CEILING_DBFS, audioFilterChain, clipGuardGainDb, planAudio } from '../../src/profile/audio.ts';
import { FILTER_INTERLACE_60I, INTERLACED_POLICY, PROGRESSIVE_POLICY, classifyFrameRate, expectedDisplayTime } from '../../src/profile/frame-rate.ts';
import { fitActiveArea, planHdr } from '../../src/profile/video.ts';
import { GPL_ONLY_FILTERS } from '../../src/toolchain.ts';

const track = (channels: number, channelLayout: string | null) => ({ index: 1, codec: 'aac', sampleRate: 48000, channels, channelLayout, default: true, startTime: 0, duration: 10 });

test('frame rate classes', () => {
  assert.equal(classifyFrameRate(30000 / 1001, false), 'ntsc-29.97');
  assert.equal(classifyFrameRate(30, false), 'ntsc-30');
  assert.equal(classifyFrameRate(24000 / 1001, false), 'film');
  assert.equal(classifyFrameRate(24, false), 'film');
  assert.equal(classifyFrameRate(60000 / 1001, false), 'video-60');
  assert.equal(classifyFrameRate(60, false), 'video-60');
  assert.equal(classifyFrameRate(50, false), 'pal-50');
  assert.equal(classifyFrameRate(25, false), 'pal-25');
  assert.equal(classifyFrameRate(15, false), 'other');
  assert.equal(classifyFrameRate(30000 / 1001, true), 'variable');
});

test('interlaced policy follows docs/poc.md §9.7', () => {
  const s = (c: Parameters<typeof INTERLACED_POLICY.decide>[0]) => INTERLACED_POLICY.decide(c).strategy;
  assert.equal(s('ntsc-29.97'), 'passthrough-29.97');
  assert.equal(s('ntsc-30'), 'decimate-30');
  assert.equal(s('film'), 'telecine-3-2');
  for (const c of ['video-60', 'pal-50', 'pal-25', 'other', 'variable'] as const) assert.equal(s(c), 'interlace-60i');
});

test('progressive policy swaps 59.94i for 29.97p only', () => {
  for (const c of ['video-60', 'pal-50', 'pal-25', 'other', 'variable'] as const) {
    const d = PROGRESSIVE_POLICY.decide(c);
    assert.equal(d.strategy, 'progressive-29.97');
    assert.equal(d.fieldBased, false);
  }
  assert.equal(PROGRESSIVE_POLICY.decide('film').strategy, 'telecine-3-2');
});

test('every strategy pins its grid to the timeline origin; 60i rounds weave down (33 ms fix)', () => {
  for (const c of ['ntsc-29.97', 'ntsc-30', 'film', 'video-60', 'pal-25'] as const) {
    assert.match(INTERLACED_POLICY.decide(c).filter, /^fps=\d+\/1001:start_time=0/);
  }
  assert.match(FILTER_INTERLACE_60I, /weave=first_field=top,fps=30000\/1001:round=down/);
});

test('no GPL-only filter in any strategy', () => {
  for (const policy of [INTERLACED_POLICY, PROGRESSIVE_POLICY]) {
    for (const c of ['ntsc-29.97', 'ntsc-30', 'film', 'video-60', 'pal-50', 'pal-25', 'other', 'variable'] as const) {
      const names = policy.decide(c).filter.split(',').map((f) => f.split('=')[0]);
      for (const n of names) assert.ok(!(GPL_ONLY_FILTERS as readonly string[]).includes(n ?? ''), `${n} is GPL-only`);
    }
  }
});

test('audio plans: stereo, mono, 5.1, 5.1(side), silence, unsupported layouts', () => {
  const stereo = planAudio(track(2, 'stereo'));
  assert.ok(stereo.ok && stereo.plan.strategy === 'stereo' && stereo.plan.matrix === null);
  const mono = planAudio(track(1, 'mono'));
  assert.ok(mono.ok && mono.plan.matrix === 'pan=stereo|c0=c0|c1=c0');
  const five = planAudio(track(6, '5.1'));
  assert.ok(five.ok && five.plan.strategy === 'downmix-5.1');
  assert.equal(five.ok && five.plan.matrix, 'pan=stereo|FL=FL+0.7071*FC+0.7071*BL|FR=FR+0.7071*FC+0.7071*BR');
  const side = planAudio(track(6, '5.1(side)'));
  assert.ok(side.ok && side.plan.matrix?.includes('SL'));
  const none = planAudio(null);
  assert.ok(none.ok && none.plan.strategy === 'silence');
  for (const [ch, layout] of [[8, '7.1'], [4, 'quad'], [6, null], [3, '2.1']] as const) {
    assert.equal(planAudio(track(ch, layout)).ok, false, `${ch} ${layout}`);
  }
  for (const r of [stereo, mono, five, none]) {
    assert.ok(r.ok && r.plan.codec === 'ac3' && r.plan.bitrateKbps === 256 && r.plan.sampleRate === 48000 && r.plan.channels === 2);
  }
});

test('clip guard only attenuates, to -1 dBFS', () => {
  assert.equal(CLIP_GUARD_CEILING_DBFS, -1);
  assert.equal(clipGuardGainDb(-10.1), 0);
  assert.equal(clipGuardGainDb(-1), 0);
  assert.equal(clipGuardGainDb(5.59), -6.59);
  assert.equal(clipGuardGainDb(Number.NEGATIVE_INFINITY), 0);
  const stereo = planAudio(track(2, 'stereo'));
  assert.ok(stereo.ok);
  assert.equal(audioFilterChain(stereo.plan, 0), 'aresample=48000:async=1:first_pts=0');
  const five = planAudio(track(6, '5.1'));
  assert.ok(five.ok);
  assert.match(audioFilterChain(five.plan, -6.59), /^pan=stereo\|.*,volume=-6\.59dB,aresample=48000:async=1:first_pts=0$/);
});

test('active area: 16:9 full, 4:3 pillarbox, 9:16 vertical (matches Phase 2 cropdetect)', () => {
  assert.deepEqual(fitActiveArea(16 / 9), { width: 720, height: 480, x: 0, y: 0 });
  assert.deepEqual(fitActiveArea(4 / 3), { width: 540, height: 480, x: 90, y: 0 });
  assert.deepEqual(fitActiveArea(9 / 16), { width: 226, height: 480, x: 246, y: 0 });
  const wide = fitActiveArea(2.39);
  assert.equal(wide.width, 720);
  assert.ok(wide.height < 480 && wide.y > 0 && wide.y % 2 === 0);
});

test('HDR classification and plan', () => {
  assert.equal(classifyHdr({ index: 0, color_transfer: 'smpte2084', color_primaries: 'bt2020' }).kind, 'hdr10');
  assert.equal(classifyHdr({ index: 0, color_transfer: 'arib-std-b67' }).kind, 'hlg');
  assert.equal(classifyHdr({ index: 0, color_transfer: 'bt709' }).kind, 'sdr');
  assert.equal(classifyHdr({ index: 0, color_primaries: 'bt2020', color_transfer: 'bt2020-10' }).kind, 'bt2020-sdr');
  const dv5 = classifyHdr({ index: 0, side_data_list: [{ side_data_type: 'DOVI configuration record', dv_profile: 5, dv_bl_signal_compatibility_id: 0 }] });
  assert.equal(dv5.dolbyVision?.baseLayer, 'none');
  assert.equal(planHdr(dv5).strategy, 'unsupported');
  const dv84 = classifyHdr({ index: 0, color_transfer: 'arib-std-b67', side_data_list: [{ side_data_type: 'DOVI configuration record', dv_profile: 8, dv_bl_signal_compatibility_id: 4 }] });
  assert.equal(planHdr(dv84).strategy, 'tonemap-experimental');
  assert.equal(planHdr({ kind: 'hdr10', dolbyVision: null }).strategy, 'tonemap-experimental');
  assert.equal(planHdr({ kind: 'bt2020-sdr', dolbyVision: null }).strategy, 'unsupported');
});

test('VFR detection: rate mismatch or spread packet durations; CFR tick jitter is not VFR', () => {
  const cfr = Array.from({ length: 300 }, (_, i) => Math.round(i * 512.5)); // 29.97 in a 1/15360 time base
  assert.equal(detectVariableFrameRate({ num: 30000, den: 1001 }, { num: 30000, den: 1001 }, cfr), false);
  assert.equal(detectVariableFrameRate({ num: 60, den: 1 }, { num: 7750, den: 199 }, cfr), true);
  const gaps = cfr.filter((_, i) => i % 10 !== 5);
  assert.equal(detectVariableFrameRate({ num: 30000, den: 1001 }, { num: 30000, den: 1001 }, gaps), true);
});

test('expected display time per strategy (what a correct conversion shows when)', () => {
  const F = 1001 / 30000;
  // 29.97 passthrough: frame k at k*F
  assert.ok(Math.abs(expectedDisplayTime('passthrough-29.97', 10 * F) - 10 * F) < 1e-12);
  // 30 -> 29.97: nearest slot; frame 1000 of a 30 fps source (33.333 s) lands on slot 999 (33.3333 s)
  assert.ok(Math.abs(expectedDisplayTime('decimate-30', 1000 / 30) - 999 * F) < 1e-9);
  // 60i: 59.94 field grid
  assert.ok(Math.abs(expectedDisplayTime('interlace-60i', 3 * 1001 / 60000) - 3 * F / 2) < 1e-12);
  // 3:2: film frames 0..4 start at fields 0, 2, 5, 7, 10
  const film = (j: number) => expectedDisplayTime('telecine-3-2', j * 1001 / 24000) / (F / 2);
  assert.deepEqual([0, 1, 2, 3, 4].map((j) => Math.round(film(j))), [0, 2, 5, 7, 10]);
});
