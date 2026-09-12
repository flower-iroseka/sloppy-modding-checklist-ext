import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [react()],
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: resolve(root, 'dist'),
    emptyOutDir: false,
    cssMinify: false,
    lib: {
      entry: resolve(root, 'src/content/index.tsx'),
      formats: ['iife'],
      name: 'OsuModdingChecklistContent',
      fileName: () => 'content.js',
      cssFileName: 'content',
    },
  },
});
