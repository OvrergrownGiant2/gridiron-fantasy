import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: './',
  // The offline build ships a real-data snapshot (scripts/build-nflverse-snapshot.ts) from public-demo/.
  publicDir: mode === 'demo' ? 'public-demo' : false,
  define: { __DEMO__: JSON.stringify(mode === 'demo'), __LOCAL_HEADSHOTS__: JSON.stringify(process.env.LOCAL_HEADSHOTS === '1') },
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
  resolve: { alias: mode === 'demo' ? {} : { '@electric-sql/pglite': '/src/api/no-pglite.ts' } },
  server: { port: 5173, proxy: { '/api': { target: 'http://localhost:8787', ws: false }, '/media': 'http://localhost:8787' } },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000, assetsInlineLimit: 0 },
}));
