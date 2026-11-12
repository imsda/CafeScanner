import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Site-specific settings come from frontend/.env (not tracked by git) or the shell
// environment, so each deployment can configure them without editing this file
// (a modified tracked file blocks scripts/update-service.sh).
const frontendDir = path.dirname(fileURLToPath(import.meta.url));
const env = { ...loadEnv(process.env.NODE_ENV || 'development', frontendDir, ''), ...process.env };

const frontendHost = env.FRONTEND_HOST || '0.0.0.0';
const frontendPort = Number(env.FRONTEND_PORT || 5173);

// Extra hostnames the dev server answers to (e.g. a domain routed through Traefik/nginx).
// Comma-separated; "all" or "true" accepts any host. localhost and IP addresses are always allowed.
// Unset keeps the original default so existing deployments behave the same.
function parseAllowedHosts(value: string | undefined): string[] | true {
  if (value === undefined) return ['cafescanner.internal.imsda.org'];
  const trimmed = value.trim();
  if (trimmed === 'all' || trimmed === 'true') return true;
  return trimmed.split(',').map((host) => host.trim()).filter(Boolean);
}
const allowedHosts = parseAllowedHosts(env.FRONTEND_ALLOWED_HOSTS);

const certFile = env.SSL_CERT_FILE;
const keyFile = env.SSL_KEY_FILE;

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
    allowedHosts,
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
