import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const frontendHost = process.env.FRONTEND_HOST || '0.0.0.0';
const frontendPort = Number(process.env.FRONTEND_PORT || 5173);

export default defineConfig({
  plugins: [react()],
  server: {
    host: frontendHost,
    port: frontendPort
  }
});
