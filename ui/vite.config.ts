import { defineConfig } from 'vite'

export default defineConfig({
  root: '.',
  build: {
    outDir: '../dist/ui',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/index.js',
        chunkFileNames: 'assets/index.js',
        assetFileNames: 'assets/index[extname]',
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
    }
  }
})
