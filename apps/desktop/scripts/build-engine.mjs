// Build the desktop engine into src-tauri/engine (bundled as an app resource):
//   engine.js                              compiled engine/engine.ts
//   node_modules/@mp4-to-ifo/core/          core dist + runtime-only package.json
// Run with the bundled node: node engine.js ...

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const core = path.resolve(desktop, '../../packages/core');
const out = path.join(desktop, 'src-tauri/engine');
const npm = process.env.npm_execpath;
const run = (cwd, args) => (npm ? execFileSync(process.execPath, [npm, ...args], { cwd, stdio: 'inherit' }) : execFileSync('npm', args, { cwd, stdio: 'inherit' }));

run(core, ['run', 'build']);
fs.rmSync(out, { recursive: true, force: true });
const tsPkg = createRequire(import.meta.url).resolve('typescript/package.json');
const tsc = path.join(path.dirname(tsPkg), JSON.parse(fs.readFileSync(tsPkg, 'utf8')).bin.tsc);
execFileSync(process.execPath, [tsc, '-p', path.join(desktop, 'engine/tsconfig.build.json')], { stdio: 'inherit', cwd: desktop });

const target = path.join(out, 'node_modules/@mp4-to-ifo/core');
fs.mkdirSync(target, { recursive: true });
fs.cpSync(path.join(core, 'dist'), path.join(target, 'dist'), { recursive: true, filter: (f) => !f.endsWith('.map') && !f.endsWith('.d.ts') });
const pkg = JSON.parse(fs.readFileSync(path.join(core, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(target, 'package.json'), `${JSON.stringify({ name: pkg.name, version: pkg.version, license: pkg.license, type: 'module', exports: { '.': './dist/index.js' } }, null, 2)}\n`);
fs.writeFileSync(path.join(out, 'package.json'), '{ "type": "module", "private": true }\n');
console.log(`engine built in ${out}`);
