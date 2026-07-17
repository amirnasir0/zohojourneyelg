import type { Prisma } from '@prisma/client';
import type { TenantConfig } from '../config/types.js';
import { prisma } from '../lib/prisma.js';
import type { ZohoDeskClient } from '../lib/zoho-desk-client.js';
import { nextPageCheckpoint } from './checkpoint.js';
import { isShutdownRequested } from './paged-phase.js';
import { writeTicketBatch } from './ticket-batch.js';

export interface TicketPhaseArgs {
  syncKey: string;
  deskClient: ZohoDeskClient;
  tenantConfig: TenantConfig;
  runStartedAt: Date;
  startPageToken: string | undefined;
  startPagesDone: number;
  /** Used by reconcile to accumulate Desk ticket IDs for cleanup, same role as paged-phase.ts's onPageRecords. */
  onPageRecords?: (deskTicketIds: string[]) => void;
  logPrefix: string;
}

export interface TicketPhaseResult {
  written: number;
  stoppedForShutdown: boolean;
}

/**
 * Drives the tickets phase page by page. Doesn't reuse runPagedPhase
 * (paged-phase.ts) — Desk's list endpoint takes no sinceIso/fields params,
 * uses offset pagination, and (confirmed live) omits description/cf/
 * customFields entirely, so every page needs a diff-then-detail-fetch step
 * runPagedPhase has no hook for. 'tickets' is always the LAST phase (no
 * nextPhase handoff), unlike contacts->journeys.
 */
export async function runTicketPhase(args: TicketPhaseArgs): Promise<TicketPhaseResult> {
  const { syncKey, deskClient, tenantConfig, runStartedAt, onPageRecords, logPrefix } = args;
  let pageToken: string | undefined = args.startPageToken;
  let pagesDone = args.startPagesDone;
  let totalWritten = 0;
  let moreRecords = true;

  while (moreRecords) {
    if (isShutdownRequested()) {
      console.log(`${logPrefix} shutdown requested, stopping before page ${pagesDone + 1} of tickets (checkpoint already durable through page ${pagesDone})`);
      return { written: totalWritten, stoppedForShutdown: true };
    }

    const page = await deskClient.getTicketsPage({ pageToken });
    pagesDone += 1;
    moreRecords = page.moreRecords;
    pageToken = page.nextPageToken;
    onPageRecords?.(page.records.map((t) => t.id));

    const existing =
      page.records.length > 0
        ? await prisma.ticket.findMany({
            where: { deskTicketId: { in: page.records.map((t) => t.id) } },
            select: { deskTicketId: true, updatedAt: true },
          })
        : [];
    const knownUpdatedAtMs = new Map(existing.map((t) => [t.deskTicketId, t.updatedAt.getTime()]));

    const changed = page.records.filter((t) => knownUpdatedAtMs.get(t.id) !== new Date(t.modifiedTime).getTime());

    // Sequential, not concurrent — the client's own 429 backoff already
    // serializes retries, and ticket volume (support tickets, not customers)
    // is small enough that this isn't a throughput concern.
    const detailed = [];
    for (const t of changed) {
      const full = await deskClient.getTicket(t.id);
      if (full) {
        detailed.push(full);
      }
    }

    const checkpointData = moreRecords ? nextPageCheckpoint('tickets', pagesDone, pageToken, undefined, runStartedAt) : null;
    const extraOps: Prisma.PrismaPromise<unknown>[] = checkpointData ? [prisma.syncState.update({ where: { key: syncKey }, data: checkpointData })] : [];

    const { written } = await writeTicketBatch(detailed, tenantConfig, extraOps);
    totalWritten += written;

    console.log(
      `${logPrefix} tickets page ${pagesDone} done (${written} written of ${changed.length} changed / ${page.records.length} listed, ${totalWritten} total so far), more=${moreRecords}`,
    );
  }

  return { written: totalWritten, stoppedForShutdown: false };
}
