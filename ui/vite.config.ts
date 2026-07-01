import { defineConfig } from 'vite'

export default defineConfig({
  root: '.',
  build: {
    outDir: '../dist/ui',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
    }
  }
})
