import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { tauriBridge } from './bridge.ts';
import './styles.css';

// No analytics or telemetry: the app talks only to its own backend.
const bridge = await tauriBridge();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App bridge={bridge} storage={window.localStorage} />
  </StrictMode>,
);
