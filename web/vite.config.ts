import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'

// In development the dashboard runs on Vite's port and talks to a
// `postgres2mcp serve` on :3333 (override with P2M_DEV_API).
const api = process.env.P2M_DEV_API ?? 'http://localhost:3333'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
      // Monaco 0.55 embeds DOMPurify 3.2.7; a package override alone does not
      // replace that copy. Route its sanitizer import to the patched package.
      {
        find: './dompurify/dompurify.js',
        replacement: fileURLToPath(new URL('./node_modules/dompurify/dist/purify.es.mjs', import.meta.url)),
      },
    ],
  },
  server: {
    proxy: { '/api': api, '/mcp': api },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
  },
})
