import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  base: './',
  server: {
    port: 3000,
    strictPort: true,
    host: '127.0.0.1',
    allowedHosts: ['localhost', '127.0.0.1'],
    forwardConsole: {
      unhandledErrors: true,
      logLevels: ['warn', 'error']
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
