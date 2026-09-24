// dvdauthor: minimal DVD-Video structure. Disc start -> title 1 -> stop. No menus, no chapter editing.

import fs from 'node:fs';
import path from 'node:path';
import { ConversionError } from './errors.ts';
import type { LogSink } from './log.ts';
import { runTool } from './process.ts';
import type { Toolchain } from './toolchain.ts';

/** File names are fixed; no user-provided text enters the XML. */
export function dvdauthorXml(mpegFileName: string, dest: string): string {
  return `<dvdauthor dest="${dest}">
  <vmgm>
    <fpc>jump title 1;</fpc>
  </vmgm>
  <titleset>
    <titles>
      <video format="ntsc" aspect="16:9" widescreen="nopanscan"/>
      <audio format="ac3" channels="2" samplerate="48khz"/>
      <pgc>
        <vob file="${mpegFileName}"/>
        <post>exit;</post>
      </pgc>
    </titles>
  </titleset>
</dvdauthor>
`;
}

/**
 * Author `<workDir>/dvd/VIDEO_TS` from `<workDir>/title.mpg`. dvdauthor reports some real problems
 * (e.g. an invalid DVD frame rate) only as warnings and still writes output, so any WARN is fatal.
 */
export async function author(workDir: string, mpegPath: string, ctx: { toolchain: Toolchain; signal?: AbortSignal; log?: LogSink }): Promise<string> {
  const dest = 'dvd';
  fs.writeFileSync(path.join(workDir, 'dvdauthor.xml'), dvdauthorXml(path.basename(mpegPath), dest));
  const warnings: string[] = [];
  const r = await runTool(ctx.toolchain.dvdauthor, ['-x', 'dvdauthor.xml'], {
    errorCode: 'AUTHOR_ERROR',
    signal: ctx.signal,
    log: ctx.log,
    cwd: workDir,
    env: { VIDEO_FORMAT: 'NTSC' },
    onStderrLine: (line) => {
      if (/^(WARN|ERR)/.test(line)) warnings.push(line);
    },
  });
  if (warnings.length) {
    throw new ConversionError('AUTHOR_ERROR', 'dvdauthor reported problems', { reason: 'AUTHOR_WARNINGS', detail: warnings.join('\n') });
  }
  const videoTs = path.join(workDir, dest, 'VIDEO_TS');
  if (!fs.existsSync(path.join(videoTs, 'VIDEO_TS.IFO'))) {
    throw new ConversionError('AUTHOR_ERROR', 'dvdauthor did not produce VIDEO_TS.IFO', { detail: r.stderr.slice(-2000) });
  }
  return videoTs;
}
