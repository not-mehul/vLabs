import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// During development the SPA runs on :5173 and proxies /api to the Express
// backend on :4000, so the browser only ever talks to one origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The client imports the shared template schema from ../shared, which is
    // outside the Vite project root; allow the repo root to be served in dev.
    fs: { allow: [path.resolve(__dirname, '..')] },
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
