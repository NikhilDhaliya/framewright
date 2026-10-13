import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  root: path.resolve(import.meta.dirname, 'src/renderer'),
  base: './',
  plugins: [react()],
  resolve: {
    alias: { '@core': path.resolve(import.meta.dirname, 'src/core') },
  },
  build: {
    outDir: path.resolve(import.meta.dirname, 'out/renderer'),
    emptyOutDir: true,
    target: 'chrome140',
    rollupOptions: {
      input: {
        index: path.resolve(import.meta.dirname, 'src/renderer/index.html'),
        render: path.resolve(import.meta.dirname, 'src/renderer/render.html'),
      },
    },
  },
  server: { port: 5199, strictPort: true },
})
