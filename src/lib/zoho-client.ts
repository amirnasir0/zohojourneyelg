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

export interface ZohoPageResult {
  records: ZohoRecord[];
  nextPageToken: string | undefined;
  moreRecords: boolean;
}

export interface ZohoClient {
  getRecordsPage(module: string, opts: { fields: string[]; sinceIso?: string | undefined; pageToken?: string | undefined }): Promise<ZohoPageResult>;
  getRecord(module: string, id: string, fields: string[]): Promise<ZohoRecord | null>;
  getModuleFields(module: string): Promise<ZohoField[]>;
}

const PAGE_SIZE = 200;
const MAX_429_RETRIES = 3;
const TOKEN_EXPIRY_SAFETY_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

// Fix 6: on an unreliable connection, fetch() itself can throw before any
// response arrives (dropped wifi, DNS blip, sleep/wake, a stalled socket).
// That's distinct from a received HTTP error status (401/429/4xx), which is
// handled separately below and is never retried here.
const RETRYABLE_NETWORK_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED']);
const MAX_NETWORK_RETRIES = 5;
const NETWORK_RETRY_BASE_MS = 2_000;
const NETWORK_RETRY_MAX_MS = 30_000;

export function isRetryableNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const code = (err as NodeJS.ErrnoException).code ?? (err.cause as NodeJS.ErrnoException | undefined)?.code;
  if (code && RETRYABLE_NETWORK_CODES.has(code)) {
    return true;
  }
  if (err.name === 'TimeoutError' || err.name === 'AbortError') {
    return true;
  }
  const causeMessage = err.cause instanceof Error ? err.cause.message : undefined;
  return /socket hang up/i.test(err.message) || (causeMessage ? /socket hang up/i.test(causeMessage) : false);
}

export function networkBackoffDelayMs(attempt: number): number {
  return Math.min(NETWORK_RETRY_BASE_MS * 2 ** attempt, NETWORK_RETRY_MAX_MS);
}

async function fetchWithNetworkRetry(url: string, init: RequestInit): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_NETWORK_RETRIES; attempt++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      lastErr = err;
      if (!isRetryableNetworkError(err) || attempt === MAX_NETWORK_RETRIES - 1) {
        throw err;
      }
      const delay = networkBackoffDelayMs(attempt);
      console.error(`[zoho-client] network error (attempt ${attempt + 1}/${MAX_NETWORK_RETRIES}), retrying in ${delay}ms...`, err);
      await sleep(delay);
    }
  }
  throw lastErr;
}

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

    const res = await fetchWithNetworkRetry(url, { method: 'POST', body: params, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
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

    const res = await fetchWithNetworkRetry(url, {
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

  /**
   * Fetches exactly one page. Callers that need every record for a module
   * loop this themselves (see incremental.ts/reconcile.ts) instead of this
   * client buffering the whole module in memory — that's what lets a sync
   * run checkpoint its Zoho cursor page-by-page and resume mid-module after
   * a crash instead of restarting the module from scratch.
   */
  async getRecordsPage(module: string, opts: { fields: string[]; sinceIso?: string | undefined; pageToken?: string | undefined }): Promise<ZohoPageResult> {
    const headers: Record<string, string> = {};
    if (opts.sinceIso) {
      headers['If-Modified-Since'] = new Date(opts.sinceIso).toUTCString();
    }

    const params = new URLSearchParams({
      fields: opts.fields.join(','),
      per_page: String(PAGE_SIZE),
      sort_by: 'Modified_Time',
      sort_order: 'asc',
    });
    // Zoho v8's page/per_page pagination hard-caps at 2000 records
    // (DISCRETE_PAGINATION_LIMIT_EXCEEDED); page_token is the cursor that
    // works beyond that, so we switch to it as soon as Zoho hands us one.
    if (opts.pageToken) {
      params.set('page_token', opts.pageToken);
    }

    const res = await this.request(`/crm/v8/${module}?${params.toString()}`, { headers });

    if (res.status === 304 || res.status === 204) {
      return { records: [], nextPageToken: undefined, moreRecords: false };
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable body>');
      throw new Error(`Zoho getRecordsPage failed: module=${module} status=${res.status} body=${body}`);
    }

    const data = (await res.json()) as {
      data?: ZohoRecord[];
      info?: { more_records?: boolean; next_page_token?: string };
    };
    const records = data.data ?? [];
    const moreRecords = Boolean(data.info?.more_records && data.info?.next_page_token);
    return { records, nextPageToken: data.info?.next_page_token, moreRecords };
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
