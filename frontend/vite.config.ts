import fs from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const frontendHost = process.env.FRONTEND_HOST || '0.0.0.0';
const frontendPort = Number(process.env.FRONTEND_PORT || 5173);

const certFile = process.env.SSL_CERT_FILE;
const keyFile = process.env.SSL_KEY_FILE;

const hasHttpsFiles = Boolean(certFile && keyFile);

const httpsConfig = hasHttpsFiles
  ? {
      cert: fs.readFileSync(certFile!, 'utf8'),
      key: fs.readFileSync(keyFile!, 'utf8')
    }
  : undefined;

if (hasHttpsFiles) {
  console.log(`[vite] HTTPS enabled using SSL_CERT_FILE=${certFile} and SSL_KEY_FILE=${keyFile}`);
} else {
  console.log('[vite] HTTPS disabled. To enable HTTPS, set SSL_CERT_FILE and SSL_KEY_FILE (e.g. certs/dev.crt + certs/dev.key).');
}

export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: ['cafescanner.internal.imsda.org'],
    host: frontendHost,
    port: frontendPort,
    strictPort: true,
    https: httpsConfig,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4000',
        changeOrigin: true
      }
    }
  }
});
