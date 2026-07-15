import { setTimeout as sleep } from 'node:timers/promises';

const ACCOUNTS_DOMAINS: Record<string, string> = {
  in: 'accounts.zoho.in',
  com: 'accounts.zoho.com',
  eu: 'accounts.zoho.eu',
  au: 'accounts.zoho.com.au',
  jp: 'accounts.zoho.jp',
  cn: 'accounts.zoho.com.cn',
  ca: 'accounts.zohocloud.ca',
};

const API_DOMAINS: Record<string, string> = {
  in: 'www.zohoapis.in',
  com: 'www.zohoapis.com',
  eu: 'www.zohoapis.eu',
  au: 'www.zohoapis.com.au',
  jp: 'www.zohoapis.jp',
  cn: 'www.zohoapis.com.cn',
  ca: 'www.zohoapis.ca',
};

export function accountsDomain(dc: string): string {
  const domain = ACCOUNTS_DOMAINS[dc];
  if (!domain) {
    throw new Error(`Unknown Zoho data center "${dc}"`);
  }
  return domain;
}

export function apiDomain(dc: string): string {
  const domain = API_DOMAINS[dc];
  if (!domain) {
    throw new Error(`Unknown Zoho data center "${dc}"`);
  }
  return domain;
}

export interface ZohoRecord {
  id: string;
  [key: string]: unknown;
}

export interface ZohoField {
  api_name: string;
}

export interface ZohoClient {
  getRecords(module: string, opts: { fields: string[]; sinceIso?: string }): Promise<ZohoRecord[]>;
  getRecord(module: string, id: string, fields: string[]): Promise<ZohoRecord | null>;
  getModuleFields(module: string): Promise<ZohoField[]>;
}

const PAGE_SIZE = 200;
const MAX_429_RETRIES = 3;
const TOKEN_EXPIRY_SAFETY_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} env var is required`);
  }
  return value;
}

class ZohoApiClient implements ZohoClient {
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;
  private refreshPromise: Promise<string> | null = null;

  constructor(
    private readonly dc: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly refreshToken: string,
  ) {}

  private async refreshAccessToken(): Promise<string> {
    const url = `https://${accountsDomain(this.dc)}/oauth/v2/token`;
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.refreshToken,
    });

    const res = await fetch(url, { method: 'POST', body: params, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const data = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };

    if (!res.ok || !data.access_token) {
      throw new Error(`Zoho token refresh failed: ${data.error ?? res.status}`);
    }

    this.accessToken = data.access_token;
    this.accessTokenExpiresAt = Date.now() + (data.expires_in ?? 3600) * 1000 - TOKEN_EXPIRY_SAFETY_MS;
    return this.accessToken;
  }

  // Mutex via shared in-flight promise: concurrent callers await the same refresh.
  private async getAccessToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.accessToken && Date.now() < this.accessTokenExpiresAt) {
      return this.accessToken;
    }
    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshAccessToken().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  private async request(
    path: string,
    opts: { headers?: Record<string, string> } = {},
    retriedAuth = false,
    retries429 = 0,
  ): Promise<Response> {
    const token = await this.getAccessToken();
    const url = `https://${apiDomain(this.dc)}${path}`;

    const res = await fetch(url, {
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        ...opts.headers,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (res.status === 401 && !retriedAuth) {
      await this.getAccessToken(true);
      return this.request(path, opts, true, retries429);
    }

    if (res.status === 429 && retries429 < MAX_429_RETRIES) {
      const retryAfterHeader = res.headers.get('Retry-After');
      const waitMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : 2 ** retries429 * 2000;
      await sleep(waitMs);
      return this.request(path, opts, retriedAuth, retries429 + 1);
    }

    return res;
  }

  async getRecords(module: string, opts: { fields: string[]; sinceIso?: string }): Promise<ZohoRecord[]> {
    const records: ZohoRecord[] = [];
    let moreRecords = true;
    // Zoho v8's page/per_page pagination hard-caps at 2000 records
    // (DISCRETE_PAGINATION_LIMIT_EXCEEDED); page_token is the cursor that
    // works beyond that, so we switch to it as soon as Zoho hands us one.
    let pageToken: string | undefined;

    const headers: Record<string, string> = {};
    if (opts.sinceIso) {
      headers['If-Modified-Since'] = new Date(opts.sinceIso).toUTCString();
    }

    while (moreRecords) {
      const params = new URLSearchParams({
        fields: opts.fields.join(','),
        per_page: String(PAGE_SIZE),
        sort_by: 'Modified_Time',
        sort_order: 'asc',
      });
      if (pageToken) {
        params.set('page_token', pageToken);
      }

      const res = await this.request(`/crm/v8/${module}?${params.toString()}`, { headers });

      if (res.status === 304 || res.status === 204) {
        break;
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '<unreadable body>');
        throw new Error(`Zoho getRecords failed: module=${module} status=${res.status} body=${body}`);
      }

      const data = (await res.json()) as {
        data?: ZohoRecord[];
        info?: { more_records?: boolean; next_page_token?: string };
      };
      records.push(...(data.data ?? []));
      moreRecords = Boolean(data.info?.more_records && data.info?.next_page_token);
      pageToken = data.info?.next_page_token;
      console.log(`[zoho-client] ${module}: fetched page (+${data.data?.length ?? 0} records, ${records.length} total so far), more=${moreRecords}`);
    }

    console.log(`[zoho-client] ${module}: pagination complete, ${records.length} records total`);
    return records;
  }

  /**
   * Single-record fetch by ID — used by webhook handlers when the notified
   * record doesn't exist locally yet, instead of running a full sync pass.
   */
  async getRecord(module: string, id: string, fields: string[]): Promise<ZohoRecord | null> {
    const params = new URLSearchParams({ fields: fields.join(',') });
    const res = await this.request(`/crm/v8/${module}/${encodeURIComponent(id)}?${params.toString()}`);

    if (res.status === 404) {
      return null;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable body>');
      throw new Error(`Zoho getRecord failed: module=${module} id=${id} status=${res.status} body=${body}`);
    }

    const data = (await res.json()) as { data?: ZohoRecord[] };
    return data.data?.[0] ?? null;
  }

  async getModuleFields(module: string): Promise<ZohoField[]> {
    const res = await this.request(`/crm/v8/settings/fields?module=${encodeURIComponent(module)}`);

    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable body>');
      throw new Error(`Zoho getModuleFields failed: module=${module} status=${res.status} body=${body}`);
    }

    const data = (await res.json()) as { fields?: ZohoField[] };
    return data.fields ?? [];
  }
}

export function createZohoClient(dc: string): ZohoClient {
  return new ZohoApiClient(dc, requireEnv('ZOHO_CLIENT_ID'), requireEnv('ZOHO_CLIENT_SECRET'), requireEnv('ZOHO_REFRESH_TOKEN'));
}
