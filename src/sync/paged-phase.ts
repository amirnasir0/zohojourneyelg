import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import type { ZohoClient, ZohoRecord } from '../lib/zoho-client.js';
import { nextPageCheckpoint, phaseTransitionCheckpoint, type SyncPhase } from './checkpoint.js';

// Module-level shutdown flag, checked between pages (not mid-page) so a
// SIGINT/SIGTERM never interrupts an in-flight batch write — the current
// page's transaction (data + checkpoint, atomic) always finishes before we
// stop. kill -9 can't be caught at all, which is fine: it doesn't need to
// be, since every page's checkpoint is already durable the instant its
// transaction commits, independent of any signal handling.
let shutdownRequested = false;
export function requestShutdown(): void {
  shutdownRequested = true;
}
export function resetShutdownFlag(): void {
  shutdownRequested = false;
}
// Shared with ticket-phase.ts, whose Desk pagination shape doesn't fit
// runPagedPhase below — same process-global flag, single source of truth.
export function isShutdownRequested(): boolean {
  return shutdownRequested;
}

export interface PagedPhaseArgs {
  syncKey: string;
  zohoClient: ZohoClient;
  phase: SyncPhase;
  module: string;
  fields: string[];
  sinceIso: string | undefined;
  runStartedAt: Date;
  startPageToken: string | undefined;
  startPagesDone: number;
  /** Phase to hand off to once this one's last page commits, or null if this is the last phase. */
  nextPhase: SyncPhase | null;
  writeBatch: (records: ZohoRecord[], extraOps: Prisma.PrismaPromise<unknown>[]) => Promise<{ written: number; issues: number }>;
  /** Called with each page's raw records as they're fetched — used by reconcile to accumulate Zoho IDs for cleanup without buffering full records. */
  onPageRecords?: (records: ZohoRecord[]) => void;
  logPrefix: string;
}

export interface PagedPhaseResult {
  written: number;
  stoppedForShutdown: boolean;
}

/**
 * Drives one phase (contacts or journeys) page by page: fetch one Zoho page,
 * write its batch, and commit the checkpoint cursor in the SAME transaction
 * as that batch's writes — so the checkpoint can never point past what's
 * actually been committed to the DB.
 */
export async function runPagedPhase(args: PagedPhaseArgs): Promise<PagedPhaseResult> {
  const { syncKey, zohoClient, phase, module, fields, sinceIso, runStartedAt, nextPhase, writeBatch, onPageRecords, logPrefix } = args;
  let pageToken = args.startPageToken;
  let pagesDone = args.startPagesDone;
  let totalWritten = 0;
  let moreRecords = true;

  while (moreRecords) {
    if (shutdownRequested) {
      console.log(`${logPrefix} shutdown requested, stopping before page ${pagesDone + 1} of ${phase} (checkpoint already durable through page ${pagesDone})`);
      return { written: totalWritten, stoppedForShutdown: true };
    }

    const page = await zohoClient.getRecordsPage(module, { fields, sinceIso, pageToken });
    pagesDone += 1;
    moreRecords = page.moreRecords;
    pageToken = page.nextPageToken;
    onPageRecords?.(page.records);

    const checkpointData = moreRecords
      ? nextPageCheckpoint(phase, pagesDone, pageToken, sinceIso, runStartedAt)
      : nextPhase
        ? phaseTransitionCheckpoint(nextPhase, sinceIso, runStartedAt)
        : null; // last page of the last phase — caller clears the checkpoint once both phases are done

    const extraOps: Prisma.PrismaPromise<unknown>[] = checkpointData
      ? [prisma.syncState.update({ where: { key: syncKey }, data: checkpointData })]
      : [];

    const { written } = await writeBatch(page.records, extraOps);
    totalWritten += written;

    console.log(`${logPrefix} ${phase} page ${pagesDone} done (${written} written, ${totalWritten} total so far), more=${moreRecords}`);
  }

  return { written: totalWritten, stoppedForShutdown: false };
}
