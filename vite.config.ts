import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const { version } = JSON.parse(
  readFileSync(new URL('package.json', import.meta.url), 'utf8'),
) as { version: string };

export default defineConfig({
  // src-tauri/tauri.conf.json points devUrl at 1420, so `npm run tauri dev` only
  // works if Vite serves that exact port.
  server: { port: 1420, strictPort: true },
  // Keep the version the UI shows tied to the one that is packaged and released.
  define: { __RUYD_VERSION__: JSON.stringify(version) },
});
