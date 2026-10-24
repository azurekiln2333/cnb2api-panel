import { resolve } from 'node:path';
import { createPanelServer } from './app.mjs';

const flag = (name, value) => {
  if (value === undefined || value === '') return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${name} must be true or false`);
};

const list = (value) =>
  value === undefined || value === ''
    ? undefined
    : String(value)
        .split(/[\s,]+/)
        .map((entry) => entry.trim())
        .filter(Boolean);

// Environment variables seed an unconfigured panel only. Once SSO settings are
// saved in panel.json, the saved encrypted configuration wins.
function ssoBootstrapFromEnv(env) {
  const bootstrap = {
    enabled: flag('PANEL_SSO_ENABLED', env.PANEL_SSO_ENABLED),
    keyLoginEnabled: flag('PANEL_KEY_LOGIN_ENABLED', env.PANEL_KEY_LOGIN_ENABLED),
    issuer: env.PANEL_OIDC_ISSUER,
    clientId: env.PANEL_OIDC_CLIENT_ID,
    clientSecret: env.PANEL_OIDC_CLIENT_SECRET,
    scope: env.PANEL_OIDC_SCOPES,
    providerName: env.PANEL_OIDC_PROVIDER_NAME,
    allowedSubjects: list(env.PANEL_OIDC_ALLOWED_SUBJECTS),
    allowedEmails: list(env.PANEL_OIDC_ALLOWED_EMAILS),
  };
  const provided = Object.fromEntries(
    Object.entries(bootstrap).filter(([, value]) => value !== undefined),
  );
  return Object.keys(provided).length ? provided : null;
}

try {
  const port = Number(process.env.PANEL_PORT || 9002);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('PANEL_PORT must be a valid port');
  const { server, pool } = createPanelServer({
    adminKey: process.env.PANEL_ADMIN_KEY,
    gatewayKey: process.env.GATEWAY_KEY,
    dataDir: resolve(process.env.PANEL_DATA_DIR || 'data'),
    publicUrl: (process.env.PANEL_PUBLIC_URL || '').replace(/\/$/, ''),
    allowLocal: process.env.PANEL_ALLOW_LOCAL_UPSTREAM === 'true',
    ssoBootstrap: ssoBootstrapFromEnv(process.env),
  });
  server.listen(port, process.env.PANEL_HOST || '127.0.0.1', () => {
    console.log(
      `[panel] http://${process.env.PANEL_HOST || '127.0.0.1'}:${port}`,
    );
    pool.start();
  });
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      pool.stop();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    });
} catch (error) {
  console.error(`[panel] ${error.message}`);
  process.exit(1);
}