import { loadTenantConfig } from '../config/loader.js';
import { accountsDomain } from '../lib/zoho-client.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} env var is required`);
    process.exit(1);
  }
  return value;
}

const code = process.argv[2];
const redirectUri = process.argv[3] ?? process.env.ZOHO_REDIRECT_URI;

if (!code || !redirectUri) {
  console.error('Usage: zoho-authorize.ts <grant-code> [redirect-uri]');
  console.error('(redirect-uri may also be supplied via ZOHO_REDIRECT_URI env var; it must match the one used to generate the grant code)');
  process.exit(1);
}

const configPath = requireEnv('TENANT_CONFIG_PATH');
const tenantConfig = loadTenantConfig(configPath);

const clientId = requireEnv('ZOHO_CLIENT_ID');
const clientSecret = requireEnv('ZOHO_CLIENT_SECRET');

const url = `https://${accountsDomain(tenantConfig.zoho.dc)}/oauth/v2/token`;
const params = new URLSearchParams({
  grant_type: 'authorization_code',
  client_id: clientId,
  client_secret: clientSecret,
  redirect_uri: redirectUri,
  code,
});

const res = await fetch(url, { method: 'POST', body: params });
const data = (await res.json()) as { access_token?: string; refresh_token?: string; error?: string; expires_in?: number };

if (!res.ok || data.error || !data.refresh_token) {
  console.error('Token exchange failed:', data);
  process.exit(1);
}

console.log(`Access token (expires in ${data.expires_in ?? '?'}s, not needed for setup):`);
console.log(data.access_token);
console.log();
console.log('Refresh token — put this in .env as ZOHO_REFRESH_TOKEN:');
console.log(data.refresh_token);
