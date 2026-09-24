import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Tauri serves the built files; the dev server runs on a fixed port.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { target: 'safari17', outDir: 'dist' },
  resolve: { conditions: ['development'] },
  test: { include: ['test/ui/**/*.test.tsx'], environment: 'node' },
});
