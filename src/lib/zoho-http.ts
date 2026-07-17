import { setTimeout as sleep } from 'node:timers/promises';

// Shared across every Zoho product client (CRM, Desk, ...) — the accounts
// server, network-error classification, and backoff are identical
// regardless of which product API is being called.
const ACCOUNTS_DOMAINS: Record<string, string> = {
  in: 'accounts.zoho.in',
  com: 'accounts.zoho.com',
  eu: 'accounts.zoho.eu',
  au: 'accounts.zoho.com.au',
  jp: 'accounts.zoho.jp',
  cn: 'accounts.zoho.com.cn',
  ca: 'accounts.zohocloud.ca',
};

export function accountsDomain(dc: string): string {
  const domain = ACCOUNTS_DOMAINS[dc];
  if (!domain) {
    throw new Error(`Unknown Zoho data center "${dc}"`);
  }
  return domain;
}

// On an unreliable connection, fetch() itself can throw before any response
// arrives (dropped wifi, DNS blip, sleep/wake, a stalled socket). That's
// distinct from a received HTTP error status (401/429/4xx), which each
// client handles itself and is never retried here.
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

export async function fetchWithNetworkRetry(url: string, init: RequestInit, logPrefix = '[zoho-http]'): Promise<Response> {
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
      console.error(`${logPrefix} network error (attempt ${attempt + 1}/${MAX_NETWORK_RETRIES}), retrying in ${delay}ms...`, err);
      await sleep(delay);
    }
  }
  throw lastErr;
}
