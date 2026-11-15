import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Vite 8's default CSS target rewrites authored `max-width` queries into
  // range syntax (`width<=760px`), which iOS Safari before 16.4 ignores, so
  // phones fell back to the desktop layout. Keep classic media queries.
  build: { cssTarget: ['chrome87', 'edge88', 'firefox78', 'safari14'] },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    host: '127.0.0.1', port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787', changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (proxyRequest, request) => {
            // Only translate the known local dev origin; preserve rejection of
            // unrelated origins by the Worker’s same-origin check.
            if (request.headers.origin === 'http://127.0.0.1:5173') proxyRequest.setHeader('Origin', 'http://127.0.0.1:8787')
          })
        },
      },
    },
  },
})
