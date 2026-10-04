import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true
      }
    }
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          // Split heavy editor/vendor libs out of the app bundle
          if (id.includes('monaco-editor') || id.includes('@monaco-editor') || id.includes('state-local')) return 'monaco';
          if (id.includes('@xterm') || id.includes('xterm')) return 'xterm';
          // React core ONLY — precise match. (A loose 'react' substring match
          // would pull react-simple-maps/react-window in here and create a
          // circular chunk dependency with viz -> TDZ crash at runtime.)
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler|react-is|use-sync-external-store)[\\/]/.test(id)) return 'react';
          // Charts + map libs (fleet dashboard / metrics) — own lazy chunk
          if (id.includes('recharts') || id.includes('d3-') || id.includes('react-simple-maps') ||
              id.includes('react-window') || id.includes('topojson') || id.includes('world-atlas') ||
              id.includes('victory-vendor') || id.includes('internmap') || id.includes('decimal.js') ||
              id.includes('lodash')) return 'viz';
          return 'vendor';
        }
      }
    }
  }
});
