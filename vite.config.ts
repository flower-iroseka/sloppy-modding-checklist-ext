import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: resolve(root, 'dist'),
    emptyOutDir: true,
    sourcemap: false,
    rolldownOptions: {
      input: {
        popup: resolve(root, 'popup.html'),
        app: resolve(root, 'app.html'),
        background: resolve(root, 'src/background/index.ts'),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js',
      },
    },
  },
});
