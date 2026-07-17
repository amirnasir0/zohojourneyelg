import { setTimeout as sleep } from 'node:timers/promises';
import { accountsDomain, fetchWithNetworkRetry } from './zoho-http.js';

const DESK_DOMAINS: Record<string, string> = {
  in: 'desk.zoho.in',
  com: 'desk.zoho.com',
  eu: 'desk.zoho.eu',
  au: 'desk.zoho.com.au',
  jp: 'desk.zoho.jp',
  cn: 'desk.zoho.com.cn',
  ca: 'desk.zohocloud.ca',
};

export function deskApiDomain(dc: string): string {
  const domain = DESK_DOMAINS[dc];
  if (!domain) {
    throw new Error(`Unknown Zoho data center "${dc}"`);
  }
  return domain;
}

export interface DeskDepartment {
  id: string;
  name: string;
}

export interface DeskPicklistValue {
  value: string;
  // Only present on the Status field's allowedValues — Desk's own
  // Open/On Hold/Closed classification, independent of however the tenant
  // labels individual status values. Confirmed live 16 Jul.
  statusType?: string;
}

export interface DeskFieldMeta {
  apiName: string;
  displayLabel: string;
  allowedValues?: DeskPicklistValue[];
}

export interface DeskContact {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  // Link back to the CRM contact, when Desk-CRM integration has populated
  // it. Confirmed live 16 Jul that this is frequently null on existing Desk
  // contacts even when a CRM contact genuinely exists — don't assume it's
  // reliably populated; it's the *first* bridge step, not the only one.
  zohoCRMContact: { id: string; type?: string } | null;
  [key: string]: unknown;
}

export interface DeskAssignee {
  id: string;
  firstName: string | null;
  lastName: string | null;
}

export interface DeskTicket {
  id: string;
  ticketNumber: string;
  subject: string;
  description: string | null;
  status: string;
  // Desk's own Open/On Hold/Closed classification for this ticket's current
  // status value — present directly on the ticket object (not just in field
  // metadata), confirmed live. Use this for "is this ticket closed" checks
  // instead of a manually-maintained status list.
  statusType: string;
  category: string | null;
  priority: string | null;
  departmentId: string;
  contactId: string;
  assigneeId: string | null;
  // Only present when fetched with ?include=assignee (see getTicket/
  // getTicketsPage below) — avoids a separate agents API call/cache to
  // resolve an owner name. Confirmed live: works on BOTH the list and
  // single-ticket GET endpoints, unlike most `include=` combinations.
  assignee?: DeskAssignee | null;
  // Both only present on single-ticket GET, never on the list endpoint
  // (confirmed live 17 Jul — list responses omit description/cf/customFields
  // entirely, with no query param able to add them back). `cf` is keyed by
  // apiName with a `cf_` prefix (e.g. `cf.cf_co_owner`), `customFields` by
  // DISPLAY LABEL (e.g. `customFields['CO-OWNER']`) — same value, two keys.
  // Prefer `cf` (stable across label renames); see readCustomField() below.
  cf?: Record<string, unknown>;
  customFields?: Record<string, unknown>;
  createdTime: string;
  modifiedTime: string;
  [key: string]: unknown;
}

/**
 * Reads a custom field defensively: prefers `cf.cf_<apiName>` (stable across
 * a display-label rename in Desk settings), falling back to
 * `customFields[displayLabel]`. Only meaningful on a ticket fetched via
 * getTicket() — the list endpoint never populates either object.
 */
export function readCustomField(ticket: DeskTicket, apiName: string, displayLabel: string): string | null {
  const viaCf = ticket.cf?.[`cf_${apiName}`];
  if (typeof viaCf === 'string') {
    return viaCf;
  }
  const viaCustomFields = ticket.customFields?.[displayLabel];
  return typeof viaCustomFields === 'string' ? viaCustomFields : null;
}

export interface DeskPageResult<T> {
  records: T[];
  nextPageToken: string | undefined;
  moreRecords: boolean;
}

export interface CreateTicketInput {
  departmentId: string;
  contactId: string;
  subject: string;
  description?: string;
  category?: string;
}

export interface CreateContactInput {
  firstName: string | null;
  lastName: string;
  email: string | null;
  phone: string | null;
  crmContactId: string;
}

export interface ZohoDeskClient {
  getDepartments(): Promise<DeskDepartment[]>;
  getTicketFields(): Promise<DeskFieldMeta[]>;
  // No confirmed server-side "modified since" filter for Desk's ticket list
  // (unlike CRM's If-Modified-Since support) — every call does a full page
  // walk; the caller's idempotent upsert makes repeated full pulls cheap
  // when nothing changed. Revisit if ticket volume grows enough to matter.
  getTicketsPage(opts: { pageToken?: string | undefined }): Promise<DeskPageResult<DeskTicket>>;
  getTicket(id: string): Promise<DeskTicket | null>;
  createTicket(input: CreateTicketInput): Promise<DeskTicket>;
  findContactByCrmId(crmContactId: string): Promise<DeskContact | null>;
  findContactByPhoneOrEmail(phone: string | null, email: string | null): Promise<DeskContact | null>;
  createContact(input: CreateContactInput): Promise<DeskContact>;
}

const PAGE_SIZE = 100;
const MAX_429_RETRIES = 3;
const TOKEN_EXPIRY_SAFETY_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
// Full-contact-list scan cap for the bridge's search fallback — protects
// against pathological pagination if search scope (Desk.search.READ) still
// isn't granted and the contact base is large. Revisit once dedicated
// search is confirmed working (see findContactByCrmId/findContactByPhoneOrEmail).
const MAX_CONTACT_SCAN_PAGES = 200;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} env var is required`);
  }
  return value;
}

class ZohoDeskApiClient implements ZohoDeskClient {
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;
  private refreshPromise: Promise<string> | null = null;

  constructor(
    private readonly dc: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly refreshToken: string,
    private readonly orgId: string,
  ) {}

  private async refreshAccessToken(): Promise<string> {
    const url = `https://${accountsDomain(this.dc)}/oauth/v2/token`;
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.refreshToken,
    });

    const res = await fetchWithNetworkRetry(url, { method: 'POST', body: params, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }, '[zoho-desk-client]');
    const data = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };

    if (!res.ok || !data.access_token) {
      throw new Error(`Zoho Desk token refresh failed: ${data.error ?? res.status}`);
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
    opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
    retriedAuth = false,
    retries429 = 0,
  ): Promise<Response> {
    const token = await this.getAccessToken();
    const url = `https://${deskApiDomain(this.dc)}/api/v1${path}`;

    const res = await fetchWithNetworkRetry(
      url,
      {
        method: opts.method ?? 'GET',
        ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          // Desk requires this on every request (unlike CRM v8, which scopes
          // entirely via the OAuth token) — confirmed live 16 Jul.
          orgId: this.orgId,
          ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
          ...opts.headers,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
      '[zoho-desk-client]',
    );

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

  async getDepartments(): Promise<DeskDepartment[]> {
    const res = await this.request('/departments');
    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable body>');
      throw new Error(`Zoho Desk getDepartments failed: status=${res.status} body=${body}`);
    }
    const data = (await res.json()) as { data?: DeskDepartment[] };
    return data.data ?? [];
  }

  async getTicketFields(): Promise<DeskFieldMeta[]> {
    // Confirmed live: /ticketFields 404s, /organizationFields?module=tickets
    // is the real endpoint.
    const res = await this.request('/organizationFields?module=tickets');
    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable body>');
      throw new Error(`Zoho Desk getTicketFields failed: status=${res.status} body=${body}`);
    }
    const data = (await res.json()) as { data?: DeskFieldMeta[] };
    return data.data ?? [];
  }

  // Cheap for discovering IDs/modifiedTime/status across every ticket — but
  // confirmed live this response omits description/cf/customFields
  // entirely (no query param adds them back). Callers needing those fields
  // must follow up with getTicket(id) for tickets that are new or whose
  // modifiedTime has changed since the last sync, not for every row.
  async getTicketsPage(opts: { pageToken?: string | undefined }): Promise<DeskPageResult<DeskTicket>> {
    const from = opts.pageToken ? Number(opts.pageToken) : 1;
    const params = new URLSearchParams({ from: String(from), limit: String(PAGE_SIZE), include: 'assignee' });

    const res = await this.request(`/tickets?${params.toString()}`);
    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable body>');
      throw new Error(`Zoho Desk getTicketsPage failed: status=${res.status} body=${body}`);
    }

    const data = (await res.json()) as { data?: DeskTicket[] };
    const records = data.data ?? [];
    // Desk's list response carries no explicit "more records" flag —
    // a full page implies there might be another; a short page means we've
    // reached the end. Worst case on an exact-multiple boundary is one
    // harmless extra empty-result request.
    const moreRecords = records.length === PAGE_SIZE;
    return { records, nextPageToken: moreRecords ? String(from + PAGE_SIZE) : undefined, moreRecords };
  }

  // Note: Desk's own web UI refers to tickets as "Cases" in its URLs
  // (webUrl on a ticket looks like ".../ShowHomePage.do#Cases/dv/<id>") even
  // though every API path, field name, and the module param on
  // organizationFields all say "tickets" — a UI-only rename, not an API one.
  // Confirmed live 16-17 Jul; don't let a "Cases" sighting in a webUrl or the
  // Desk admin UI lead you to go looking for a /cases endpoint.
  async getTicket(id: string): Promise<DeskTicket | null> {
    const res = await this.request(`/tickets/${encodeURIComponent(id)}?include=assignee`);
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable body>');
      throw new Error(`Zoho Desk getTicket failed: id=${id} status=${res.status} body=${body}`);
    }
    return (await res.json()) as DeskTicket;
  }

  async createTicket(input: CreateTicketInput): Promise<DeskTicket> {
    const res = await this.request('/tickets', {
      method: 'POST',
      body: {
        departmentId: input.departmentId,
        contactId: input.contactId,
        subject: input.subject,
        description: input.description,
        category: input.category,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable body>');
      throw new Error(`Zoho Desk createTicket failed: status=${res.status} body=${body}`);
    }
    return (await res.json()) as DeskTicket;
  }

  /**
   * Dedicated /contacts/search and the generic /search endpoint both
   * currently reject with SCOPE_MISMATCH / return empty (Desk.search.READ
   * not yet granted — confirmed live 16 Jul) and /contacts doesn't accept
   * email/searchStr as filter query params (422s). Until that scope lands,
   * this walks the full contact list client-side. Works correctly today,
   * just not efficiently at scale — swap the body for a real search call
   * once Desk.search.READ is confirmed on the token.
   */
  private async scanContacts(predicate: (c: DeskContact) => boolean): Promise<DeskContact | null> {
    let from = 1;
    for (let page = 0; page < MAX_CONTACT_SCAN_PAGES; page++) {
      const res = await this.request(`/contacts?from=${from}&limit=${PAGE_SIZE}`);
      if (!res.ok) {
        const body = await res.text().catch(() => '<unreadable body>');
        throw new Error(`Zoho Desk contact scan failed: status=${res.status} body=${body}`);
      }
      const data = (await res.json()) as { data?: DeskContact[] };
      const records = data.data ?? [];
      const match = records.find(predicate);
      if (match) {
        return match;
      }
      if (records.length < PAGE_SIZE) {
        return null;
      }
      from += PAGE_SIZE;
    }
    return null;
  }

  async findContactByCrmId(crmContactId: string): Promise<DeskContact | null> {
    return this.scanContacts((c) => c.zohoCRMContact?.id === crmContactId);
  }

  async findContactByPhoneOrEmail(phone: string | null, email: string | null): Promise<DeskContact | null> {
    if (!phone && !email) {
      return null;
    }
    return this.scanContacts((c) => (phone !== null && (c.phone === phone || c.mobile === phone)) || (email !== null && c.email === email));
  }

  async createContact(input: CreateContactInput): Promise<DeskContact> {
    const res = await this.request('/contacts', {
      method: 'POST',
      body: {
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        phone: input.phone,
        zohoCRMContact: { id: input.crmContactId },
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable body>');
      throw new Error(`Zoho Desk createContact failed: status=${res.status} body=${body}`);
    }
    return (await res.json()) as DeskContact;
  }
}

export function createZohoDeskClient(dc: string, orgId: string): ZohoDeskClient {
  return new ZohoDeskApiClient(
    dc,
    requireEnv('ZOHO_DESK_CLIENT_ID'),
    requireEnv('ZOHO_DESK_CLIENT_SECRET'),
    requireEnv('ZOHO_DESK_REFRESH_TOKEN'),
    orgId,
  );
}
