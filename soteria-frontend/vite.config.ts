import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// `npm run dev` has no Vercel functions: serve /api/sensors from the same code (api/_lib/sensors.ts).
// Server-only env (SENSOR_GATEWAY_KEY, RPC_URL) comes from .env.local / the shell, never the bundle.
const sensorsApiDev = (): Plugin => ({
  name: 'sensors-api-dev',
  configureServer(server) {
    server.middlewares.use('/api/sensors', async (req, res) => {
      const env = { ...loadEnv(server.config.mode, process.cwd(), ''), ...process.env };
      const { runRound } = await server.ssrLoadModule('/api/_lib/sensors.ts');
      let body = '';
      for await (const chunk of req) body += chunk;
      let trigger: string | undefined;
      try { trigger = JSON.parse(body || '{}').trigger; } catch { /* normal round */ }
      const result = await runRound(env, trigger).catch((e: Error) => ({ ok: false, error: e.message }));
      res.statusCode = result.ok ? 200 : 409;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(result));
    });
  },
});

export default defineConfig({
  plugins: [react(), sensorsApiDev()],
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
        sensors: resolve(__dirname, 'sensors.html'),
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
