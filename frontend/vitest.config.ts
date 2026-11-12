import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Kept separate from vite.config.ts so tests do not load dev-server settings (.env, HTTPS files).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true
  }
});
