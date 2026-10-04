import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import http from 'node:http';

export default defineConfig({
  base: './',
  server: {
    port: 3001,
    host: '0.0.0.0',
    allowedHosts: true,
  },
  plugins: [
    tailwindcss(),
    {
      name: 'port-compat-bridge',
      configureServer(server) {
        // Ensure both port 3001 and port 3000 are simultaneously active
        // without requiring conflicting duplicate CLI flags in package.json
        try {
          const mirrorPort = server.config.server.port === 3001 ? 3000 : 3001;
          const bridge = http.createServer((req, res) => {
            server.middlewares(req, res);
          });
          bridge.on('error', () => {});
          bridge.listen(mirrorPort, '0.0.0.0');
        } catch (_) {}
      }
    }
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/jspdf')) return 'vendor-jspdf';
          if (id.includes('node_modules/lucide')) return 'vendor-lucide';
          if (id.includes('node_modules/@supabase')) return 'vendor-supabase';
        }
      }
    }
  }
});
