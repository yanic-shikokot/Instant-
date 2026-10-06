import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const isCloudRun = Boolean(process.env.K_SERVICE || process.env.K_REVISION);
const hmrDisabled = process.env.DISABLE_HMR === 'true';
const hmrClientPort = Number(process.env.VITE_HMR_CLIENT_PORT || (isCloudRun ? 443 : 3000));
const hmrProtocol = process.env.VITE_HMR_PROTOCOL || (isCloudRun ? 'wss' : 'ws');

export default defineConfig({
  base: './',
  server: {
    port: 3000,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    ws: hmrDisabled ? false : {
      clientPort: hmrClientPort,
      protocol: hmrProtocol
    }
  },
  plugins: [
    tailwindcss()
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
