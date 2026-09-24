// Check the Mac app (or the release DMG) before it is shipped. Run by `npm run app` (build level) and by
// scripts/release-mac.sh (every level); run it again on a finished DMG with `npm run verify:release`.
//
//   node scripts/check-bundle.mjs [--app <MP4 to IFO.app>] [--dmg <file.dmg>] [--level build|signed|release]
//                                 [--metadata <release.json>]
//
// build    contents (nothing unexpected: no tests, media, source maps, logs, credentials), Mach-O inventory
//          (arm64 only, minimum macOS, system libraries only), versions, bundled tool versions, licenses and
//          the third-party manifest, privacy (no home path, user name, temporary path, e-mail, private keys),
//          toolchain checksums against third-party/sources.json (before signing only)
// signed   + every executable signed with the hardened runtime; entitlements exactly as documented in
//          docs/release.md (node: allow-jit; nothing else); no get-task-allow anywhere; strict verification
// release  + Developer ID Application with a secure timestamp and one team, notarization ticket stapled,
//          Gatekeeper accepts the app (and the DMG) as notarized
// --dmg    the DMG: layout (the app and an Applications link), its own signature, and the app inside it
// --metadata  release.json against the DMG (file name, size, SHA-256, version, architecture, minimum macOS)

import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(desktop, '../..');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const level = arg('--level') ?? 'build';
if (!['build', 'signed', 'release'].includes(level)) throw new Error(`unknown level ${level}`);
const atLeast = (l) => ['build', 'signed', 'release'].indexOf(level) >= ['build', 'signed', 'release'].indexOf(l);
const dmg = arg('--dmg') && path.resolve(arg('--dmg'));
const metadataFile = arg('--metadata') && path.resolve(arg('--metadata'));

const BUNDLE_ID = 'io.github.sena10x.mp4-to-ifo';
const MIN_MACOS = '14.0';
const EXECUTABLES = ['mp4-to-ifo-desktop', 'node', 'ffmpeg', 'ffprobe', 'dvdauthor'];
/** Entitlements per executable (docs/release.md). Anything else, on anything, is a failure. */
const ENTITLEMENTS = { node: { 'com.apple.security.cs.allow-jit': true } };
/** Build paths inside upstream binaries that are not from this machine (docs/release.md, privacy). */
const UPSTREAM_PATHS = { node: ['/Users/admin/build/ws/'] };

const problems = [];
const fail = (message) => problems.push(message);
const ok = (message) => console.log(`ok    ${message}`);
const check = (condition, message, detail = '') => (condition ? ok(message) : fail(`${message}${detail ? `: ${detail}` : ''}`));
const run = (cmd, args, options = {}) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const plist = (file) => JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }));
const versionLe = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  return true;
};

// --- the DMG: mount read-only, check its layout and signature -------------------------------------------
let mountPoint = null;
let app = arg('--app') ?? path.join(desktop, 'src-tauri/target/release/bundle/macos/MP4 to IFO.app');
if (dmg) {
  mountPoint = fs.mkdtempSync(path.join(os.tmpdir(), 'mp4-to-ifo-dmg-'));
  execFileSync('hdiutil', ['attach', dmg, '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mountPoint], { stdio: 'ignore' });
  process.on('exit', () => {
    spawnSync('hdiutil', ['detach', mountPoint, '-quiet']);
    fs.rmdirSync(mountPoint);
  });
  app = path.join(mountPoint, 'MP4 to IFO.app');
  const entries = fs.readdirSync(mountPoint).filter((e) => !['.fseventsd', '.Trashes'].includes(e)).sort();
  check(JSON.stringify(entries) === JSON.stringify(['Applications', 'MP4 to IFO.app']), 'dmg: contains only MP4 to IFO.app and Applications', entries.join(', '));
  const link = path.join(mountPoint, 'Applications');
  check(fs.lstatSync(link).isSymbolicLink() && fs.readlinkSync(link) === '/Applications', 'dmg: Applications is a link to /Applications');
  if (atLeast('signed')) {
    const v = run('codesign', ['--verify', '--strict', '--verbose=2', dmg]);
    check(v.status === 0, 'dmg: signature verifies', v.stderr.trim());
  }
  if (atLeast('release')) {
    const d = run('codesign', ['-dvv', dmg]).stderr;
    check(/^Authority=Developer ID Application: /m.test(d), 'dmg: signed with Developer ID Application');
    check(/^Timestamp=/m.test(d), 'dmg: secure timestamp');
    const staple = run('xcrun', ['stapler', 'validate', dmg]);
    check(staple.status === 0, 'dmg: notarization ticket stapled', staple.stdout.trim());
    const gk = run('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '-vv', dmg]);
    check(gk.status === 0 && /source=Notarized Developer ID/.test(gk.stderr), 'dmg: Gatekeeper accepts (Notarized Developer ID)', gk.stderr.trim());
  }
}
check(fs.existsSync(app), `app: ${path.relative(repo, app).startsWith('..') ? app : path.relative(repo, app)}`);
if (!fs.existsSync(app)) finish();

// --- contents: required files, and nothing that is not expected -----------------------------------------
const sources = readJson(path.join(repo, 'third-party/sources.json'));
const licenseFiles = [...sources.components.flatMap((c) => c.licenseFiles), 'Rust-crates-and-npm-packages.txt', 'THIRD-PARTY.md', 'MP4-to-IFO-MIT.txt'].sort();
const required = [
  'Contents/Info.plist',
  ...EXECUTABLES.map((e) => `Contents/MacOS/${e}`),
  'Contents/Resources/engine/engine.js',
  'Contents/Resources/engine/node_modules/@mp4-to-ifo/core/package.json',
  'Contents/Resources/engine/node_modules/@mp4-to-ifo/core/dist/index.js',
  'Contents/Resources/build-info/toolchain.txt',
  'Contents/Resources/build-info/sources.json',
  ...licenseFiles.map((f) => `Contents/Resources/licenses/${f}`),
];
const allowed = [
  /^Contents\/Info\.plist$/,
  /^Contents\/PkgInfo$/,
  new RegExp(`^Contents/MacOS/(${EXECUTABLES.join('|')})$`),
  /^Contents\/_CodeSignature\/CodeResources$/,
  /^Contents\/CodeResources$/, // stapled notarization ticket
  /^Contents\/Resources\/icon\.icns$/,
  /^Contents\/Resources\/engine\/(engine\.js|package\.json)$/,
  /^Contents\/Resources\/engine\/node_modules\/@mp4-to-ifo\/core\/(package\.json|dist\/[a-z/-]+\.js)$/,
  /^Contents\/Resources\/licenses\/[^/]+\.(txt|md)$/,
  /^Contents\/Resources\/build-info\/(toolchain\.txt|sources\.json)$/,
];
const files = [];
for (const entry of fs.readdirSync(app, { recursive: true, withFileTypes: true })) {
  const rel = path.relative(app, path.join(entry.parentPath, entry.name));
  if (entry.isSymbolicLink()) fail(`unexpected symbolic link ${rel}`);
  else if (entry.isFile()) files.push(rel);
}
const missing = required.filter((f) => !files.includes(f));
check(missing.length === 0, 'contents: required files present', missing.join(', '));
const unexpected = files.filter((f) => !allowed.some((re) => re.test(f)));
check(unexpected.length === 0, `contents: nothing unexpected (${files.length} files; no tests, fixtures, media, source maps, logs, keys)`, unexpected.join(', '));
const shippedLicenses = fs.readdirSync(path.join(app, 'Contents/Resources/licenses')).sort();
check(JSON.stringify(shippedLicenses) === JSON.stringify(licenseFiles), 'licenses: exactly the third-party manifest, the package notices and the app license', shippedLicenses.join(', '));

// --- Mach-O inventory ----------------------------------------------------------------------------------
const MACHO = new Set(['feedfacf', 'cffaedfe', 'feedface', 'cefaedfe', 'cafebabe', 'bebafeca']);
const machO = files.filter((f) => {
  const fd = fs.openSync(path.join(app, f), 'r');
  const head = Buffer.alloc(4);
  fs.readSync(fd, head, 0, 4, 0);
  fs.closeSync(fd);
  return MACHO.has(head.toString('hex'));
});
check(JSON.stringify(machO.sort()) === JSON.stringify(EXECUTABLES.map((e) => `Contents/MacOS/${e}`).sort()), `mach-o: exactly ${EXECUTABLES.length} executables in Contents/MacOS, no dylibs or frameworks`, machO.join(', '));
const info = plist(path.join(app, 'Contents/Info.plist'));
for (const f of machO) {
  const file = path.join(app, f);
  const name = path.basename(f);
  const archs = run('lipo', ['-archs', file]).stdout.trim();
  const minos = run('vtool', ['-show-build', file]).stdout.match(/minos (\S+)/)?.[1] ?? '?';
  const libs = run('otool', ['-L', file]).stdout.split('\n').slice(1).map((l) => l.trim().split(' ')[0]).filter(Boolean);
  const foreign = libs.filter((l) => !l.startsWith('/usr/lib/') && !l.startsWith('/System/Library/'));
  check(archs === 'arm64' && minos !== '?' && versionLe(minos, MIN_MACOS) && foreign.length === 0, `mach-o: ${name} arm64, minos ${minos}, ${(fs.statSync(file).size / 1e6).toFixed(1)} MB, system libraries only`, `${archs} ${foreign.join(' ')}`);
}

// --- versions -------------------------------------------------------------------------------------------
const version = readJson(path.join(desktop, 'package.json')).version;
const versions = {
  'packages/core': readJson(path.join(repo, 'packages/core/package.json')).version,
  'packages/cli': readJson(path.join(repo, 'packages/cli/package.json')).version,
  'apps/desktop': version,
  'Cargo.toml': fs.readFileSync(path.join(desktop, 'src-tauri/Cargo.toml'), 'utf8').match(/^version = "([^"]+)"/m)?.[1],
  'Info.plist CFBundleShortVersionString': info.CFBundleShortVersionString,
  'Info.plist CFBundleVersion': info.CFBundleVersion,
  'bundled core': readJson(path.join(app, 'Contents/Resources/engine/node_modules/@mp4-to-ifo/core/package.json')).version,
};
const off = Object.entries(versions).filter(([, v]) => v !== version);
check(off.length === 0, `version: ${version} everywhere (core, cli, desktop, Cargo, Info.plist, bundled core)`, off.map(([k, v]) => `${k}=${v}`).join(', '));
check(info.CFBundleIdentifier === BUNDLE_ID && info.LSMinimumSystemVersion === MIN_MACOS, `Info.plist: ${BUNDLE_ID}, LSMinimumSystemVersion ${MIN_MACOS}`);
check(readJson(path.join(desktop, 'src-tauri/tauri.conf.json')).bundle.macOS.minimumSystemVersion === MIN_MACOS && sources.minimumMacOS === MIN_MACOS, `minimum macOS: tauri.conf.json and the toolchain build say ${MIN_MACOS}`);

// --- bundled tools: versions and license of the build; checksums before signing ---------------------------
const tool = (name, args) => run(path.join(app, 'Contents/MacOS', name), args, { env: { PATH: '/usr/bin:/bin' } });
const component = (name) => sources.components.find((c) => c.component === name);
const nodeVersion = tool('node', ['--version']).stdout.trim();
check(nodeVersion === `v${component('Node.js').version}`, `tool: node ${nodeVersion} runs`);
const ffmpegVersion = tool('ffmpeg', ['-hide_banner', '-version']).stdout;
check(ffmpegVersion.startsWith(`ffmpeg version ${component('FFmpeg').version} `), `tool: ffmpeg ${component('FFmpeg').version}`);
check(!/--enable-(gpl|nonfree)/.test(ffmpegVersion) && /--enable-libzimg/.test(ffmpegVersion), 'tool: ffmpeg configured without --enable-gpl / --enable-nonfree, with zimg');
check(/GNU Lesser General Public License/.test(tool('ffmpeg', ['-hide_banner', '-L']).stdout.replace(/\s+/g, ' ')), 'tool: ffmpeg -L reports the LGPL');
check(tool('ffprobe', ['-hide_banner', '-version']).stdout.startsWith(`ffprobe version ${component('FFmpeg').version} `), `tool: ffprobe ${component('FFmpeg').version}`);
const dvdauthor = tool('dvdauthor', ['-h']);
check(`${dvdauthor.stdout}${dvdauthor.stderr}`.includes(`version ${component('dvdauthor').version}`), `tool: dvdauthor ${component('dvdauthor').version}`);
const signedAlready = /flags=0x[0-9a-f]+\([^)]*runtime/.test(run('codesign', ['-dv', path.join(app, 'Contents/MacOS/ffmpeg')]).stderr);
if (!signedAlready) {
  for (const c of sources.components) {
    for (const b of c.binaries) check(sha256(path.join(app, 'Contents/MacOS', b.name)) === b.sha256, `checksum: ${b.name} matches third-party/sources.json`);
  }
} else ok('checksum: executables are re-signed; the pre-signing checksums were checked when the app was built');
const bundled = ['sources.json', 'toolchain.txt'].every((f) => fs.readFileSync(path.join(app, 'Contents/Resources/build-info', f)).equals(fs.readFileSync(path.join(repo, 'third-party', f === 'sources.json' ? f : `build-info/${f}`))));
check(bundled, 'manifest: bundled build-info matches third-party/');
const licenseSource = (f) => path.join(repo, f === 'THIRD-PARTY.md' ? 'third-party/README.md' : f === 'MP4-to-IFO-MIT.txt' ? 'LICENSE' : `third-party/licenses/${f}`);
const stale = shippedLicenses.filter((f) => !fs.existsSync(licenseSource(f)) || !fs.readFileSync(path.join(app, 'Contents/Resources/licenses', f)).equals(fs.readFileSync(licenseSource(f))));
check(stale.length === 0, 'manifest: every bundled license file matches the repository (what Open Source Licenses shows)', stale.join(', '));

// --- privacy -------------------------------------------------------------------------------------------
// Terms are read from this machine at run time and never printed.
const git = run('git', ['config', '--global', 'user.email']).stdout.trim();
const terms = [
  ['home directory', os.homedir()],
  ['user name', os.userInfo().username],
  ['temporary folder', '/var/folders/'],
  ['temporary folder', process.env.TMPDIR?.replace(/\/$/, '')],
  ['git e-mail', git],
  ['private key', '-----BEGIN PRIVATE KEY'],
  ['private key', '-----BEGIN RSA PRIVATE KEY'],
  ['private key', '-----BEGIN ENCRYPTED PRIVATE KEY'],
  ['private key', '-----BEGIN EC PRIVATE KEY'],
  ['App Store Connect key', 'AuthKey_'],
].filter(([, t]) => t && t.length >= 4);
let privacy = 0;
const upstream = [];
for (const f of files) {
  const data = fs.readFileSync(path.join(app, f));
  for (const [label, term] of terms) {
    if (data.includes(term)) {
      fail(`privacy: ${label} in ${f}`);
      privacy++;
    }
  }
  // Any other user folder path, unless it is a known upstream build path.
  const text = data.toString('latin1');
  for (const m of text.matchAll(/\/Users\/[A-Za-z0-9._-]+\//g)) {
    const known = UPSTREAM_PATHS[path.basename(f)]?.some((p) => text.startsWith(p, m.index));
    if (known) upstream.push(`${path.basename(f)}: ${m[0]}`);
    else {
      fail(`privacy: user folder path ${m[0]} in ${f}`);
      privacy++;
    }
  }
}
check(privacy === 0, `privacy: no home path, user name, temporary path, git e-mail or private key in ${files.length} files`);
if (upstream.length) ok(`privacy: upstream build paths only (not from this machine): ${[...new Set(upstream)].join(', ')}`);

// --- signatures ------------------------------------------------------------------------------------------
if (atLeast('signed')) {
  const verify = run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  check(verify.status === 0, 'codesign: app verifies (--deep --strict)', verify.stderr.trim());
  const teams = new Set();
  for (const target of [...EXECUTABLES.map((e) => path.join(app, 'Contents/MacOS', e)), app]) {
    const name = target === app ? 'app' : path.basename(target);
    const d = run('codesign', ['-dvv', target]).stderr;
    const id = d.match(/^Identifier=(.+)$/m)?.[1];
    const expectedId = name === 'app' || name === 'mp4-to-ifo-desktop' ? BUNDLE_ID : `${BUNDLE_ID}.${name}`;
    check(/flags=0x[0-9a-f]*\(.*runtime.*\)/.test(d), `codesign: ${name} hardened runtime`);
    check(id === expectedId, `codesign: ${name} identifier ${expectedId}`, id);
    const raw = run('codesign', ['-d', '--entitlements', '-', '--xml', target]).stdout;
    const entitlements = raw.trim() ? JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', '-'], { input: raw, encoding: 'utf8' })) : {};
    const expected = ENTITLEMENTS[name] ?? {};
    check(JSON.stringify(entitlements) === JSON.stringify(expected), `entitlements: ${name} ${Object.keys(expected).join(', ') || 'none'}`, JSON.stringify(entitlements));
    check(!('com.apple.security.get-task-allow' in entitlements), `entitlements: ${name} has no get-task-allow`);
    if (atLeast('release')) {
      check(/^Authority=Developer ID Application: /m.test(d) && /^Authority=Developer ID Certification Authority$/m.test(d) && /^Authority=Apple Root CA$/m.test(d), `codesign: ${name} Developer ID Application`);
      check(/^Timestamp=/m.test(d), `codesign: ${name} secure timestamp`);
      teams.add(d.match(/^TeamIdentifier=(.+)$/m)?.[1]);
    }
  }
  if (atLeast('release')) {
    const [team] = teams;
    check(teams.size === 1 && /^[A-Z0-9]{10}$/.test(team ?? ''), `codesign: one team for everything (${[...teams].join(', ')})`);
    const dr = `anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${team}"`;
    const req = run('codesign', ['--verify', '--deep', '--strict', `-R=${dr}`, app]);
    check(req.status === 0, 'codesign: satisfies the Developer ID requirement', req.stderr.trim());
    const staple = run('xcrun', ['stapler', 'validate', app]);
    check(staple.status === 0, 'notarization: ticket stapled to the app', staple.stdout.trim());
    const gk = run('spctl', ['--assess', '--type', 'execute', '-vv', app]);
    check(gk.status === 0 && /source=Notarized Developer ID/.test(gk.stderr), 'gatekeeper: app accepted (Notarized Developer ID)', gk.stderr.trim());
  }
  console.log(`      designated requirement: ${run('codesign', ['-d', '-r-', app]).stdout.trim().replace(/^designated => /, '')}`);
}

// --- release metadata --------------------------------------------------------------------------------------
if (metadataFile) {
  const meta = readJson(metadataFile);
  check(dmg && meta.file === path.basename(dmg), `metadata: file ${meta.file}`);
  check(dmg && meta.size === fs.statSync(dmg).size, `metadata: size ${meta.size}`);
  check(dmg && meta.sha256 === sha256(dmg), `metadata: SHA-256 ${meta.sha256}`);
  check(meta.version === version && meta.file === `MP4-to-IFO-${version}-arm64.dmg`, `metadata: version ${meta.version} and file name`);
  check(meta.architecture === 'arm64' && meta.minimumMacOS === MIN_MACOS, `metadata: arm64, macOS ${meta.minimumMacOS}+`);
  if (atLeast('release')) check(meta.notarization?.status === 'Accepted' && meta.testBuild === false, `metadata: notarization ${meta.notarization?.status}`);
}

finish();

function finish() {
  if (problems.length) {
    console.error(problems.map((p) => `FAIL  ${p}`).join('\n'));
    console.error(`${problems.length} problem(s) (level ${level})`);
    process.exit(1);
  }
  console.log(`bundle ok (level ${level}${dmg ? `, ${path.basename(dmg)}` : ''})`);
  process.exit(0);
}
