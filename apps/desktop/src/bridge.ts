// Everything the UI needs from the outside world. The Tauri implementation talks to the Rust backend
// (which runs the engine) and to Tauri plugins; tests pass a fake.

import type { EngineMessage } from './engine-types.ts';

export type Unlisten = () => void;

export interface Bridge {
  pickMp4(title: string): Promise<string | null>;
  pickFolder(defaultPath: string): Promise<string | null>;
  analyze(input: string, outputDir: string | null): Promise<EngineMessage>;
  /** Only the user's choices go to the engine: the core plans again and checks planDigest. */
  startConversion(input: string, outputDir: string, planDigest: string): Promise<void>;
  cancel(): Promise<void>;
  cancelAndQuit(): Promise<void>;
  onEngine(handler: (message: EngineMessage | { type: 'exit'; code: number | null }) => void): Promise<Unlisten>;
  onQuitRequested(handler: () => void): Promise<Unlisten>;
  onDragDrop(handler: (event: { type: 'enter' | 'leave' } | { type: 'drop'; paths: string[] }) => void): Promise<Unlisten>;
  ask(options: { title: string; message: string; ok: string; cancel: string }): Promise<boolean>;
  notify(title: string, body: string): Promise<void>;
  /** Open the output folder of the conversion that just passed verification. The backend knows which
   *  folder that is; no path crosses this boundary. */
  openOutputFolder(): Promise<void>;
  openUrl(url: string): Promise<void>;
  copy(text: string): Promise<void>;
  readLicenses(): Promise<{ name: string; text: string }[]>;
  appVersion(): Promise<string>;
}

export async function tauriBridge(): Promise<Bridge> {
  const { invoke } = await import('@tauri-apps/api/core');
  const { listen } = await import('@tauri-apps/api/event');
  const { getCurrentWebview } = await import('@tauri-apps/api/webview');
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const { getVersion } = await import('@tauri-apps/api/app');
  const dialog = await import('@tauri-apps/plugin-dialog');
  const notification = await import('@tauri-apps/plugin-notification');
  const opener = await import('@tauri-apps/plugin-opener');
  const clipboard = await import('@tauri-apps/plugin-clipboard-manager');

  return {
    async pickMp4(title) {
      const picked = await dialog.open({ title, multiple: false, directory: false, filters: [{ name: 'MP4', extensions: ['mp4', 'MP4'] }] });
      return typeof picked === 'string' ? picked : null;
    },
    async pickFolder(defaultPath) {
      const picked = await dialog.open({ directory: true, multiple: false, defaultPath, canCreateDirectories: true });
      return typeof picked === 'string' ? picked : null;
    },
    analyze: (input, outputDir) => invoke<EngineMessage>('analyze', { input, outputDir }),
    startConversion: (input, outputDir, planDigest) => invoke('start_conversion', { input, outputDir, planDigest }),
    cancel: () => invoke('cancel_conversion'),
    cancelAndQuit: () => invoke('cancel_and_quit'),
    onEngine: (handler) => listen<EngineMessage | { type: 'exit'; code: number | null }>('engine', (e) => handler(e.payload)),
    onQuitRequested: (handler) => listen('quit-requested', () => handler()),
    onDragDrop: (handler) =>
      getCurrentWebview().onDragDropEvent((e) => {
        if (e.payload.type === 'enter') handler({ type: 'enter' });
        else if (e.payload.type === 'leave') handler({ type: 'leave' });
        else if (e.payload.type === 'drop') handler({ type: 'drop', paths: e.payload.paths });
      }),
    ask: ({ title, message, ok, cancel }) => dialog.ask(message, { title, kind: 'warning', okLabel: ok, cancelLabel: cancel }),
    async notify(title, body) {
      // Only when the user is elsewhere; the window already shows the result.
      if (await getCurrentWindow().isFocused()) return;
      let granted = await notification.isPermissionGranted();
      if (!granted) granted = (await notification.requestPermission()) === 'granted';
      if (granted) notification.sendNotification({ title, body });
    },
    openOutputFolder: () => invoke('open_output_folder'),
    openUrl: (url) => opener.openUrl(url),
    copy: (text) => clipboard.writeText(text),
    readLicenses: () => invoke('read_licenses'),
    appVersion: () => getVersion(),
  };
}
