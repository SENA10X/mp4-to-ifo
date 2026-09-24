// Check the built .app: every bundled part is present and nothing contains the build machine's home path
// (a user name must not ship inside the app). Run by `npm run app` after `tauri build`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = path.join(desktop, 'src-tauri/target/release/bundle/macos/MP4 to IFO.app');
const required = [
  'Contents/MacOS/mp4-to-ifo-desktop',
  'Contents/MacOS/node',
  'Contents/MacOS/ffmpeg',
  'Contents/MacOS/ffprobe',
  'Contents/MacOS/dvdauthor',
  'Contents/Resources/engine/engine.js',
  'Contents/Resources/engine/node_modules/@mp4-to-ifo/core/package.json',
  'Contents/Resources/licenses/THIRD-PARTY.md',
  'Contents/Resources/licenses/MP4-to-IFO-MIT.txt',
  'Contents/Resources/build-info/toolchain.txt',
];

const problems = required.filter((f) => !fs.existsSync(path.join(app, f))).map((f) => `missing ${f}`);
const home = Buffer.from(os.homedir());
for (const file of fs.readdirSync(app, { recursive: true, withFileTypes: true })) {
  if (!file.isFile()) continue;
  const full = path.join(file.parentPath, file.name);
  if (fs.readFileSync(full).includes(home)) problems.push(`home path in ${path.relative(app, full)}`);
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`bundle ok: ${path.relative(desktop, app)}`);
