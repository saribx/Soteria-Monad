import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    // Scenario facts are read straight from the repository's data/ folder
    fs: { allow: ['..'] },
  },
  build: {
    rollupOptions: {
      // Two pages: the operations console and the agent live console
      input: {
        main: resolve(__dirname, 'index.html'),
        console: resolve(__dirname, 'console.html'),
      },
      output: {
        // Vendor code changes rarely; keep it cacheable apart from the app
        manualChunks: {
          mapbox: ['mapbox-gl'],
          react: ['react', 'react-dom'],
        },
      },
    },
    // mapbox-gl alone is ~1.7 MB minified
    chunkSizeWarningLimit: 2000,
  },
});
