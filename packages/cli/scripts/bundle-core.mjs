// npm pack helper. The core is a private workspace package, so the published CLI carries it as a
// bundled dependency. npm only packs bundled dependencies that physically exist in this package's
// node_modules (not the workspace symlink), so prepack builds both packages and copies the core in;
// postpack (--clean) removes the copy.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const core = path.resolve(cli, '../core');
const target = path.join(cli, 'node_modules/@mp4-to-ifo/core');

fs.rmSync(path.join(cli, 'node_modules'), { recursive: true, force: true });
if (process.argv.includes('--clean')) process.exit(0);

const npm = process.env.npm_execpath;
const runNpm = (dir, args) => (npm ? execFileSync(process.execPath, [npm, ...args], { cwd: dir, stdio: 'inherit' }) : execFileSync('npm', args, { cwd: dir, stdio: 'inherit' }));
runNpm(core, ['run', 'build']);
runNpm(cli, ['run', 'build']);

const corePkg = JSON.parse(fs.readFileSync(path.join(core, 'package.json'), 'utf8'));
const cliPkg = JSON.parse(fs.readFileSync(path.join(cli, 'package.json'), 'utf8'));
if (corePkg.version !== cliPkg.version) throw new Error(`core ${corePkg.version} and cli ${cliPkg.version} versions differ`);

fs.mkdirSync(target, { recursive: true });
// Source maps point at src/, which is not shipped.
fs.cpSync(path.join(core, 'dist'), path.join(target, 'dist'), { recursive: true, filter: (f) => !f.endsWith('.map') });
// Runtime-only manifest: no development export (src is not shipped), no scripts or dev dependencies.
fs.writeFileSync(path.join(target, 'package.json'), `${JSON.stringify({
  name: corePkg.name,
  version: corePkg.version,
  license: corePkg.license,
  type: corePkg.type,
  exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
}, null, 2)}\n`);
fs.copyFileSync(path.join(cli, '../../LICENSE'), path.join(target, 'LICENSE'));
