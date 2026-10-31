import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the API runs separately (npm run dev starts both); Vite proxies /api to it.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': `http://localhost:${process.env.API_PORT ?? 3001}` },
  },
});
