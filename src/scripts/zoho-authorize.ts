import { loadTenantConfig } from '../config/loader.js';
import { accountsDomain } from '../lib/zoho-http.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} env var is required`);
    process.exit(1);
  }
  return value;
}

const args = process.argv.slice(2).filter((arg) => !arg.startsWith('--target='));
const targetArg = process.argv.find((arg) => arg.startsWith('--target='));
const target = targetArg ? targetArg.slice('--target='.length) : 'crm';

if (target !== 'crm' && target !== 'desk') {
  console.error(`Unknown --target "${target}" — expected "crm" or "desk"`);
  process.exit(1);
}

const code = args[0];
const redirectUri = args[1] ?? process.env.ZOHO_REDIRECT_URI;

if (!code || !redirectUri) {
  console.error('Usage: zoho-authorize.ts <grant-code> [redirect-uri] [--target=crm|desk]');
  console.error('(redirect-uri may also be supplied via ZOHO_REDIRECT_URI env var; it must match the one used to generate the grant code)');
  console.error('(--target defaults to crm; Desk uses its own OAuth client/scope, so grant codes for the two are not interchangeable)');
  process.exit(1);
}

const configPath = requireEnv('TENANT_CONFIG_PATH');
const tenantConfig = loadTenantConfig(configPath);

const clientId = requireEnv(target === 'desk' ? 'ZOHO_DESK_CLIENT_ID' : 'ZOHO_CLIENT_ID');
const clientSecret = requireEnv(target === 'desk' ? 'ZOHO_DESK_CLIENT_SECRET' : 'ZOHO_CLIENT_SECRET');

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

const refreshTokenEnvVar = target === 'desk' ? 'ZOHO_DESK_REFRESH_TOKEN' : 'ZOHO_REFRESH_TOKEN';

console.log(`Access token (expires in ${data.expires_in ?? '?'}s, not needed for setup):`);
console.log(data.access_token);
console.log();
console.log(`Refresh token — put this in .env as ${refreshTokenEnvVar}:`);
console.log(data.refresh_token);
