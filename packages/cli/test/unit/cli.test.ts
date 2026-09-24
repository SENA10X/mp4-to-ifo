import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PassThrough } from 'node:stream';
import { describe, test } from 'node:test';
import * as core from '@mp4-to-ifo/core';
import { ConversionError, planConversion, type ConversionResult, type InputAnalysis } from '@mp4-to-ifo/core';
import { parseCliArgs, UsageError } from '../../src/args.ts';
import { run, type CliEnvironment, type Core } from '../../src/cli.ts';
import { ProgressView, formatDuration, formatFps } from '../../src/render.ts';

const VERSION = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version as string;
const INPUT = '/Users/someone/Movies/山田家 opening.mp4';

function analysis(overrides: Partial<InputAnalysis> = {}): InputAnalysis {
  const duration = overrides.duration ?? 92;
  return {
    path: INPUT, fileSize: 1, modifiedMs: 1, container: 'mov,mp4', majorBrand: 'isom', duration, startTime: 0,
    video: {
      index: 0, codec: 'h264', profile: null, width: 1920, height: 1080, sampleAspectRatio: { num: 1, den: 1 }, displayAspectRatio: 16 / 9,
      frameRate: 60000 / 1001, rFrameRate: { num: 60000, den: 1001 }, avgFrameRate: { num: 60000, den: 1001 }, isVariableFrameRate: false,
      frameCount: null, pixelFormat: 'yuv420p', fieldOrder: 'progressive', color: { space: 'bt709', transfer: 'bt709', primaries: 'bt709', range: 'tv' },
      rotation: 0, hdr: { kind: 'sdr', dolbyVision: null }, startTime: 0, duration,
    },
    audioTracks: [{ index: 1, codec: 'aac', sampleRate: 48000, channels: 2, channelLayout: 'stereo', default: true, startTime: 0, duration }],
    subtitleTracks: [],
    selectedAudio: 0,
    ...overrides,
  };
}

function result(plan: ReturnType<typeof planConversion>): ConversionResult {
  return {
    outputDir: '/Users/someone/Movies/山田家 opening', videoTsDir: '', zipPath: '', isoPath: '/Users/someone/Movies/山田家 opening/山田家 opening.iso',
    plan, toolchain: {} as never, audio: { peakDbfs: null, gainDb: 0 }, timingsMs: { ENCODING_PASS_1: 1000 },
    verification: {
      passed: true, failed: [],
      checks: [
        { id: 'a', ok: true, status: 'passed', detail: '' },
        { id: 'sync.av_offset', ok: true, status: 'unmeasurable', detail: 'not measurable' },
        { id: 'source.unchanged', ok: true, status: 'not_applicable', detail: 'no fingerprint' },
      ],
      durations: { expectedVideo: 92, expectedAudio: 92, video: 92, audio: 92.01, ifo: 92 },
      sync: {
        status: 'partial', windows: [], videoMatches: 10, videoOffsetMs: 5.3, audioMatches: 0, audioOffsetMs: null, videoTimelineErrorMs: 0,
        audioTimingErrorMs: null, audioWindowOffsetsMs: [], introducedOffsetMs: null,
      },
      videoTiming: { status: 'passed', errorMs: 0, matches: 10 },
      audioTiming: { status: 'unmeasurable', errorMs: null, confidentWindows: 0, windows: 5 },
      relativeAvTiming: { status: 'unmeasurable', offsetMs: null },
      fieldTemporal: {
        status: 'passed', capacityHz: 30000 / 1001, coverage: 1, backwardRatio: 0, reason: '', worstWindow: { coverage: 1, backwardRatio: 0, judged: 5 },
        stats: { fields: 360, matchedFields: 360, residual: 0.005, allMoments: 150, sourceMoments: 150, expected: 150, shown: 150, steps: 146, backwards: 0 },
      },
    },
  };
}

interface Harness {
  env: CliEnvironment;
  stdout: () => string;
  stderr: () => string;
  signal: (name: 'SIGINT' | 'SIGTERM') => void;
  stdin: PassThrough & { isTTY?: boolean };
  forced: number[];
  convertCalls: number;
  /** planDigest passed to each convert() call. */
  planDigests: (string | undefined)[];
}

function harness(options: { a?: InputAnalysis; convert?: (o: Parameters<Core['convert']>[0]) => Promise<ConversionResult>; tty?: boolean; stdoutTTY?: boolean; lockError?: boolean; toolError?: boolean } = {}): Harness {
  let out = '';
  let err = '';
  const handlers = new Map<string, () => void>();
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  stdin.isTTY = options.tty ?? false;
  const h: Harness = {
    stdout: () => out,
    stderr: () => err,
    signal: (name) => handlers.get(name)?.(),
    stdin,
    forced: [],
    convertCalls: 0,
    planDigests: [] as (string | undefined)[],
    env: undefined as never,
  };
  const a = options.a ?? analysis();
  const fake: Core = {
    ...core,
    resolveToolchain: () => {
      if (options.toolError) throw new ConversionError('PREFLIGHT_ERROR', 'ffmpeg was not found', { reason: 'TOOL_MISSING' });
      return { ffmpeg: '/x/ffmpeg', ffprobe: '/x/ffprobe', dvdauthor: '/x/dvdauthor' };
    },
    inspectToolchain: async (tc) => ({
      ffmpeg: { path: tc.ffmpeg, version: '7.1', license: 'lgpl', configuration: '' }, ffprobe: { path: tc.ffprobe, version: '7.1' },
      dvdauthor: { path: tc.dvdauthor, version: '0.7.2' }, missing: [], missingExperimental: [],
    }),
    cleanupStaleJobs: async () => 0,
    analyzeAndPlan: async (_input, o) => ({ analysis: a, plan: planConversion(a, o) }),
    nextOutputDirectory: (dir, name) => `${dir}/${name}`,
    acquireLock: async () => {
      if (options.lockError) throw new ConversionError('PREFLIGHT_ERROR', 'Another conversion is running', { reason: 'LOCKED' });
      return { path: '', owner: {} as never, release() {} };
    },
    convert: async (o) => {
      h.convertCalls++;
      h.planDigests.push(o.planDigest);
      return options.convert ? options.convert(o) : result(planConversion(a, o));
    },
  };
  h.env = {
    stdout: { write: (s) => void (out += s), isTTY: options.stdoutTTY ?? false },
    stderr: { write: (s) => void (err += s) },
    stdin,
    onSignal: (name, handler) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    forceExit: (code) => void h.forced.push(code),
    version: VERSION,
    core: fake,
  };
  return h;
}

describe('arguments', () => {
  test('input and options', () => {
    assert.deepEqual(parseCliArgs(['in.mp4']), { input: 'in.mp4', output: null, yes: false, verbose: false, help: false, version: false });
    const a = parseCliArgs(['in.mp4', '--output', 'out', '--yes', '--verbose']);
    assert.equal(a.output, 'out');
    assert.equal(a.yes && a.verbose, true);
    assert.equal(parseCliArgs(['-o', 'x', '-y', 'in.mp4']).output, 'x');
    assert.ok(parseCliArgs(['--output=~/Desktop', 'in.mp4']).output?.endsWith('/Desktop'));
    assert.equal(parseCliArgs(['--', '-odd name.mp4']).input, '-odd name.mp4');
    assert.equal(parseCliArgs([]).input, null);
  });
  test('usage errors', () => {
    assert.throws(() => parseCliArgs(['a.mp4', 'b.mp4']), (e: Error) => e instanceof UsageError && /one input/.test(e.message));
    assert.throws(() => parseCliArgs(['--bitrate', '5000', 'a.mp4']), (e: Error) => e instanceof UsageError && /Unknown option: --bitrate/.test(e.message));
    assert.throws(() => parseCliArgs(['a.mp4', '--output']), UsageError);
  });
  test('--help and --version exit 0; no input or bad arguments exit 2', async () => {
    let h = harness();
    assert.equal(await run(['--help'], h.env), 0);
    assert.match(h.stdout(), /Usage:\n {2}mp4-to-ifo <input.mp4> \[options\]/);
    assert.match(h.stdout(), /Convert an MP4 video into DVD-Video files for disc authoring\./);
    h = harness();
    assert.equal(await run(['--version'], h.env), 0);
    assert.equal(h.stdout(), `${VERSION}\n`);
    h = harness();
    assert.equal(await run([], h.env), 2);
    assert.match(h.stderr(), /Usage:/);
    h = harness();
    assert.equal(await run(['a.mp4', 'b.mp4'], h.env), 2);
    h = harness();
    assert.equal(await run(['--frame-rate', '25', 'a.mp4'], h.env), 2);
    assert.match(h.stderr(), /Unknown option: --frame-rate/);
  });
  test('version comes from package.json and matches the core (one SemVer)', () => {
    const corePkg = JSON.parse(fs.readFileSync(new URL('../../../core/package.json', import.meta.url), 'utf8'));
    assert.equal(corePkg.version, VERSION);
  });
});

describe('summary, warnings and confirmation', () => {
  test('--yes converts without asking and prints the plan and result', async () => {
    const h = harness();
    assert.equal(await run([INPUT, '--yes'], h.env), 0);
    const o = h.stdout();
    assert.match(o, /Input\n {2}山田家 opening\.mp4\n {2}1920×1080 · 59\.94 fps · 01:32\n {2}Audio: Stereo \(AAC\)/);
    assert.match(o, /NTSC 16:9 · 720×480 · MPEG-2 · 59\.94i \(interlaced\)/);
    assert.match(o, /Audio: Stereo → AC-3 Stereo · 256 kbps/);
    assert.match(o, /Output\n {2}\/Users\/someone\/Movies\/山田家 opening\//);
    assert.match(o, /DVD-Video created and verified\./);
    assert.match(o, /Files:\n {2}VIDEO_TS\/\n {2}VIDEO_TS\.zip\n {2}山田家 opening\.iso/);
    assert.match(o, /Verification: passed \(1 of 2 checks; 1 could not be measured/);
    assert.match(o, /test it on a DVD player/);
    assert.doesNotMatch(o, /compatible/i);
    assert.doesNotMatch(o, /Continue\?/);
    // The core gets the digest of the plan that was shown, never the plan itself.
    assert.deepEqual(h.planDigests, [core.planDigest(planConversion(analysis(), { outputDirectory: undefined }))]);
  });

  test('TTY: "y" and Enter continue, "n" cancels with exit 4', async () => {
    for (const [answer, code, calls] of [['y', 0, 1], ['', 0, 1], ['n', 4, 0]] as const) {
      const h = harness({ tty: true });
      const p = run([INPUT], h.env);
      setTimeout(() => h.stdin.write(`${answer}\n`), 20);
      assert.equal(await p, code, `answer "${answer}"`);
      assert.match(h.stdout(), /Continue\? \[Y\/n\]/);
      assert.equal(h.convertCalls, calls);
    }
  });

  test('not a TTY and no --yes: refuses without waiting for input (exit 2)', async () => {
    const h = harness({ tty: false });
    assert.equal(await run([INPUT], h.env), 2);
    assert.match(h.stderr(), /Run with --yes/);
    assert.equal(h.convertCalls, 0);
  });

  test('warnings: HDR, subtitles, low bitrate, no audio, 5.1', async () => {
    const a = analysis();
    const cases: [InputAnalysis, RegExp][] = [
      [{ ...a, video: { ...a.video, hdr: { kind: 'hlg', dolbyVision: null } } }, /Warning: HDR video detected \(HLG\)\.\n {2}MP4 to IFO will convert HDR to SDR\. HDR conversion is experimental\./],
      [{ ...a, subtitleTracks: [{ index: 2, codec: 'mov_text', language: null }] }, /Warning: Subtitle tracks are not included in the DVD output\./],
      [analysis({ duration: 3 * 3600 }), /Warning: The calculated video bitrate is 3,024 kbps\.\n {2}Video quality may be reduced\./],
      [{ ...a, audioTracks: [], selectedAudio: null }, /Audio: None → Silent AC-3 Stereo[\s\S]*Warning: The MP4 has no audio/],
      [{ ...a, audioTracks: [{ ...a.audioTracks[0]!, channels: 6, channelLayout: '5.1' }] }, /Audio: 5\.1 → AC-3 Stereo/],
    ];
    for (const [input, pattern] of cases) {
      const h = harness({ a: input });
      assert.equal(await run([INPUT, '--yes'], h.env), 0);
      assert.match(h.stdout(), pattern);
    }
  });

  test('plan errors stop before converting (exit 2): 7.1, quad, Dolby Vision 5, unknown HDR, too long', async () => {
    const a = analysis();
    const cases: [InputAnalysis, RegExp][] = [
      [{ ...a, audioTracks: [{ ...a.audioTracks[0]!, channels: 8, channelLayout: '7.1' }] }, /Error: 7\.1-channel audio is not supported in this version\./],
      [{ ...a, audioTracks: [{ ...a.audioTracks[0]!, channels: 4, channelLayout: 'quad' }] }, /Error: 4-channel \(quad\) audio is not supported/],
      [{ ...a, video: { ...a.video, hdr: { kind: 'dolby-vision', dolbyVision: { profile: 5, compatibilityId: 0, baseLayer: 'none' } } } }, /Dolby Vision video without a compatible base layer \(such as Profile 5\)/],
      [{ ...a, video: { ...a.video, hdr: { kind: 'unknown', dolbyVision: null } } }, /unrecognised colour format/],
      [analysis({ duration: 9 * 3600 }), /too long to fit on a single-layer DVD/],
    ];
    for (const [input, pattern] of cases) {
      const h = harness({ a: input });
      assert.equal(await run([INPUT, '--yes'], h.env), 2);
      assert.match(h.stderr(), pattern);
      assert.equal(h.convertCalls, 0);
    }
  });
});

describe('exit codes and errors', () => {
  const fail = (e: Error) => () => Promise.reject(e);
  const cases: [string, Error, number, RegExp][] = [
    ['conversion failure', new ConversionError('ENCODE_ERROR', 'ffmpeg failed', { detail: `x ${INPUT}` }), 1, /Encoding the video failed\./],
    ['input error', new ConversionError('INPUT_ERROR', 'incomplete', { reason: 'TRUNCATED' }), 2, /The MP4 file appears to be incomplete or damaged\./],
    ['verification failure', new ConversionError('VERIFY_ERROR', 'failed', { reason: 'sync.av_offset' }), 3, /did not pass verification, so no output was kept/],
    ['cancellation', new ConversionError('CANCELLED', 'cancelled'), 4, /Cancelled\. No output was kept\./],
    ['output drive gone', new ConversionError('OUTPUT_ERROR', 'EIO'), 1, /output drive is connected/],
    ['unexpected', new TypeError('boom'), 1, /An unexpected error occurred\./],
  ];
  for (const [name, error, code, pattern] of cases) {
    test(`${name} -> exit ${code}`, async () => {
      const h = harness({ convert: fail(error) });
      assert.equal(await run([INPUT, '--yes'], h.env), code);
      assert.match(h.stderr(), pattern);
      assert.doesNotMatch(h.stderr(), /at .*\.ts:\d+/); // no stack trace
      if (code !== 4) assert.match(h.stderr(), /Run again with --verbose/);
    });
  }

  test('success -> exit 0', async () => {
    assert.equal(await run([INPUT, '--yes'], harness().env), 0);
  });

  test('missing tools and a busy lock have clear messages', async () => {
    let h = harness({ toolError: true });
    assert.equal(await run([INPUT, '--yes'], h.env), 1);
    assert.match(h.stderr(), /Error: ffmpeg was not found\.\n\n {2}MP4 to IFO requires ffmpeg, ffprobe, and dvdauthor\./);
    assert.doesNotMatch(h.stderr(), / +\n/); // no trailing spaces
    h = harness({ lockError: true });
    assert.equal(await run([INPUT, '--yes'], h.env), 1);
    assert.match(h.stderr(), /Another MP4 to IFO conversion is already running for this user\./);
    assert.equal(h.convertCalls, 0);
  });

  test('--verbose adds tool versions, plan details and a redacted error report', async () => {
    const h = harness({ convert: fail(new ConversionError('ENCODE_ERROR', `ffmpeg failed on ${INPUT}`, { detail: `Error opening ${INPUT}\n/Users/someone/Movies/out` })) });
    assert.equal(await run([INPUT, '--yes', '--verbose', '--output', '/Users/someone/Movies/out'], h.env), 1);
    assert.match(h.stdout(), /ffmpeg 7\.1 \(lgpl\)/);
    assert.match(h.stdout(), /Frame rate strategy: interlace-60i/);
    const report = h.stderr().slice(h.stderr().indexOf('{'));
    const parsed = JSON.parse(report);
    assert.equal(parsed.code, 'ENCODE_ERROR');
    assert.ok(!report.includes('山田家'), report);
    assert.ok(!report.includes('/Users/someone'), report);
    assert.ok(!report.includes('opening.mp4'), report);
  });
});

describe('progress', () => {
  const events: core.ProgressEvent[] = [
    { phase: 'ENCODING_PASS_1', phaseProgress: 0, overallProgress: 0.03 },
    { phase: 'ENCODING_PASS_1', phaseProgress: 0.3, overallProgress: 0.1, mediaTime: 28, mediaDuration: 92 },
    { phase: 'ENCODING_PASS_1', phaseProgress: 0.6, overallProgress: 0.2, mediaTime: 55, mediaDuration: 92 },
    { phase: 'ENCODING_PASS_2', phaseProgress: 0.53, overallProgress: 0.5, mediaTime: 48, mediaDuration: 92 },
    { phase: 'COMPLETED', phaseProgress: 1, overallProgress: 1 },
  ];
  test('not a TTY: plain lines, no escape codes or carriage returns', () => {
    let out = '';
    const view = new ProgressView({ write: (s) => void (out += s), isTTY: false });
    for (const e of events) view.update(e);
    assert.doesNotMatch(out, /\r|\x1b/);
    assert.match(out, /Encoding pass 1\/2\.\.\.\nEncoding pass 1\/2\.\.\. 30% · 00:28\nEncoding pass 1\/2\.\.\. 60% · 00:55\nEncoding pass 2\/2\.\.\. 53% · 00:48\nDone\.\n/);
  });
  test('TTY: updates one line in place per phase', () => {
    let out = '';
    let t = 0;
    const view = new ProgressView({ write: (s) => void (out += s), isTTY: true }, () => (t += 300));
    for (const e of events) view.update(e);
    assert.match(out, /\r\x1b\[2KEncoding pass 1\/2\.\.\. 30% · 00:28/);
    assert.equal(out.split('\n').length - 1, 3); // pass 1 line, pass 2 line, Done.
    assert.ok(out.endsWith('Done.\n'));
  });
  test('formatting', () => {
    assert.equal(formatDuration(92), '01:32');
    assert.equal(formatDuration(3 * 3600 + 5), '3:00:05');
    assert.equal(formatFps(30000 / 1001), '29.97');
    assert.equal(formatFps(24000 / 1001), '23.976');
    assert.equal(formatFps(25), '25');
  });
});

describe('signals', () => {
  const waitForAbort = (o: Parameters<Core['convert']>[0]) =>
    new Promise<ConversionResult>((_, reject) => o.signal?.addEventListener('abort', () => setTimeout(() => reject(new ConversionError('CANCELLED', 'cancelled')), 10)));

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    test(`${sig} during conversion aborts the core and exits 4`, async () => {
      let signalSeen: AbortSignal | undefined;
      const h = harness({ convert: (o) => ((signalSeen = o.signal), waitForAbort(o)) });
      const p = run([INPUT, '--yes'], h.env);
      await new Promise((r) => setTimeout(r, 30));
      h.signal(sig);
      assert.equal(await p, 4);
      assert.equal(signalSeen?.aborted, true);
      assert.match(h.stderr(), /Cancelling\.\.\./);
      assert.deepEqual(h.forced, []);
    });
  }

  test('second signal explains, third forces exit', async () => {
    const h = harness({ convert: () => new Promise(() => {}) });
    void run([INPUT, '--yes'], h.env);
    await new Promise((r) => setTimeout(r, 30));
    h.signal('SIGINT');
    h.signal('SIGINT');
    assert.match(h.stderr(), /Press Ctrl\+C again to quit immediately/);
    assert.deepEqual(h.forced, []);
    h.signal('SIGINT');
    assert.deepEqual(h.forced, [4]);
  });

  test('Ctrl+C at the prompt cancels without converting', async () => {
    const h = harness({ tty: true });
    const p = run([INPUT], h.env);
    await new Promise((r) => setTimeout(r, 30));
    h.signal('SIGINT');
    assert.equal(await p, 4);
    assert.equal(h.convertCalls, 0);
  });
});

