import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@cadforge/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
    server: {
      port: 5173,
      strictPort: false,
      proxy: {
        // The API and the generated files are served by the Express server, so the
        // browser sees one origin and no CORS preflight in development.
        '/api': { target: 'http://127.0.0.1:4000', changeOrigin: true },
        '/files': { target: 'http://127.0.0.1:4000', changeOrigin: true },
        // The MCP endpoint lives at the server root, not under /api.
        '/mcp': { target: 'http://127.0.0.1:4000', changeOrigin: true },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
      // The OpenCascade WASM binary is ~7 MB; inlining it would be pointless.
      assetsInlineLimit: 0,
      // three.js dominates the main bundle; splitting it lets the browser
      // cache it across deploys.
      rollupOptions: {
        output: {
          manualChunks: {
            three: ['three'],
            react: ['react', 'react-dom'],
          },
        },
      },
      chunkSizeWarningLimit: 1600,
    },
  });
