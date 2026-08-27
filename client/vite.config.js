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
          if (id.includes('monaco-editor') || id.includes('@monaco-editor')) return 'monaco';
          if (id.includes('@xterm') || id.includes('xterm')) return 'xterm';
          if (id.includes('react') || id.includes('react-dom') || id.includes('scheduler')) return 'react';
          return 'vendor';
        }
      }
    }
  }
});
