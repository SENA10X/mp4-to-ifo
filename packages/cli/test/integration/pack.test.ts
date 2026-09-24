// The package as npm users would get it: npm pack -> install the tarball in an empty project ->
// run the bin through npx. Catches anything that only works inside the workspace.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LGPL_BIN, makeSample, skipNoTools, tempDir, toolchain } from '../../../core/test/helpers/env.ts';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const work = tempDir('mp4-to-ifo-pack-');
after(() => fs.rmSync(work, { recursive: true, force: true }));

describe('npm pack', { skip: skipNoTools }, () => {
  let tarball = '';
  let files: string[] = [];

  test('pack contains the CLI and the bundled core, nothing else', () => {
    const json = execFileSync('npm', ['pack', '--json', '--pack-destination', work], { cwd: CLI, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    const info = JSON.parse(json.slice(json.indexOf('['))) as { filename: string; files: { path: string }[]; bundled: string[] }[];
    tarball = path.join(work, info[0]!.filename);
    files = info[0]!.files.map((f) => f.path).sort();
    assert.deepEqual(info[0]!.bundled, ['@mp4-to-ifo/core']);
    for (const f of ['package.json', 'README.md', 'LICENSE', 'dist/main.js', 'dist/cli.js', 'node_modules/@mp4-to-ifo/core/package.json', 'node_modules/@mp4-to-ifo/core/dist/index.js']) {
      assert.ok(files.includes(f), `missing ${f}`);
    }
    assert.deepEqual(files.filter((f) => /(^|\/)(src|test|scripts)\//.test(f) || f.endsWith('.ts') && !f.endsWith('.d.ts')), []);
    assert.equal(fs.existsSync(path.join(CLI, 'node_modules')), false, 'postpack removed the bundled copy');
    const pkg = JSON.parse(execFileSync('tar', ['-xOf', tarball, 'package/package.json']).toString());
    assert.equal(pkg.name, 'mp4-to-ifo');
    assert.deepEqual(pkg.bin, { 'mp4-to-ifo': 'dist/main.js' });
    assert.equal(pkg.license, 'MIT');
  });

  test('installed from the tarball, npx mp4-to-ifo runs and converts', () => {
    const project = path.join(work, 'project');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'package.json'), '{"name":"try-mp4-to-ifo","private":true}\n');
    execFileSync('npm', ['install', '--no-audit', '--no-fund', '--offline', tarball], { cwd: project, stdio: 'ignore' });
    const env = { ...process.env, PATH: [fs.existsSync(LGPL_BIN) ? LGPL_BIN : '', path.dirname(toolchain!.dvdauthor), process.env.PATH].join(':'), TMPDIR: work };
    const npx = (args: string[]) => spawnSync('npx', ['--no-install', 'mp4-to-ifo', ...args], { cwd: project, env, encoding: 'utf8' });

    const version = npx(['--version']);
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout.trim(), JSON.parse(fs.readFileSync(path.join(CLI, 'package.json'), 'utf8')).version);
    assert.match(npx(['--help']).stdout, /Usage:\n {2}mp4-to-ifo <input.mp4> \[options\]/);

    const src = makeSample(path.join(project, 'sample.mp4'), { seconds: 3 });
    const r = npx(['sample.mp4', '--yes']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /DVD-Video created and verified\./);
    assert.deepEqual(fs.readdirSync(path.join(project, 'sample')).sort(), ['VIDEO_TS', 'VIDEO_TS.zip', 'sample.iso']);
    assert.ok(fs.existsSync(src));
    // It really runs the installed copy, not the workspace.
    assert.ok(fs.realpathSync(path.join(project, 'node_modules/mp4-to-ifo')).startsWith(fs.realpathSync(project)));
  });
});
