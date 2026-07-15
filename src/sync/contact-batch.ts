import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import type { ZohoRecord } from '../lib/zoho-client.js';
import { ingestContactPhones } from './phone-ingest.js';
import { withBatchRetry } from './with-retry.js';

export interface ContactBatchIssue {
  zohoRecordId: string;
  field: string;
  rawValue: string;
  reason: string;
}

export interface ContactUpsertItem {
  zohoContactId: string;
  mobileE164: string;
  altMobileE164: string | null;
  fullName: string | null;
  email: string | null;
  raw: ZohoRecord;
}

export interface ContactBatchPlan {
  upserts: ContactUpsertItem[];
  issues: ContactBatchIssue[];
}

/**
 * Pure planning step for a batch write: given raw records and a map of
 * mobile_e164 -> zohoContactId for contacts that ALREADY own that number in
 * the DB (fetched by the caller in one bulk query), decides what to upsert
 * and what to skip. Duplicate mobiles are caught two ways — against existing
 * DB state, and against other records in this same batch — since a batched
 * $transaction has no per-row unique-constraint recovery: a conflict would
 * roll back the whole batch, so conflicts must be filtered out beforehand.
 */
export function planContactBatch(
  rawRecords: ZohoRecord[],
  phoneFields: string[],
  existingMobileOwners: ReadonlyMap<string, string>,
): ContactBatchPlan {
  const issues: ContactBatchIssue[] = [];
  const upserts: ContactUpsertItem[] = [];
  const claimedInBatch = new Map<string, string>();

  for (const raw of rawRecords) {
    const zohoContactId = String(raw.id);
    const { mobileE164, altMobileE164, issues: phoneIssues } = ingestContactPhones(raw, phoneFields);

    for (const issue of phoneIssues) {
      issues.push({ zohoRecordId: zohoContactId, field: issue.field, rawValue: issue.rawValue, reason: issue.reason });
    }

    if (!mobileE164) {
      continue;
    }

    const existingOwner = existingMobileOwners.get(mobileE164);
    if (existingOwner && existingOwner !== zohoContactId) {
      issues.push({ zohoRecordId: zohoContactId, field: 'mobile_e164', rawValue: mobileE164, reason: 'DUPLICATE_MOBILE' });
      continue;
    }

    const claimant = claimedInBatch.get(mobileE164);
    if (claimant && claimant !== zohoContactId) {
      issues.push({ zohoRecordId: zohoContactId, field: 'mobile_e164', rawValue: mobileE164, reason: 'DUPLICATE_MOBILE' });
      continue;
    }
    claimedInBatch.set(mobileE164, zohoContactId);

    upserts.push({
      zohoContactId,
      mobileE164,
      altMobileE164,
      fullName: typeof raw.Full_Name === 'string' ? raw.Full_Name : null,
      email: typeof raw.Email === 'string' ? raw.Email : null,
      raw,
    });
  }

  return { upserts, issues };
}

export interface ContactBatchResult {
  written: number;
  issues: number;
}

/**
 * Writes one batch (~200 records): one bulk read to find existing owners of
 * any candidate mobile number in this batch, then at most one $transaction
 * for the upserts and one createMany for the issues — a handful of round
 * trips per batch instead of one per record.
 */
export async function writeContactBatch(rawRecords: ZohoRecord[], phoneFields: string[]): Promise<ContactBatchResult> {
  const candidates = new Set<string>();
  for (const raw of rawRecords) {
    const { mobileE164, altMobileE164 } = ingestContactPhones(raw, phoneFields);
    if (mobileE164) candidates.add(mobileE164);
    if (altMobileE164) candidates.add(altMobileE164);
  }

  const existing =
    candidates.size > 0
      ? await withBatchRetry(() =>
          prisma.contact.findMany({
            where: { mobileE164: { in: [...candidates] } },
            select: { mobileE164: true, zohoContactId: true },
          }),
        )
      : [];
  const existingMobileOwners = new Map(existing.map((c) => [c.mobileE164, c.zohoContactId]));

  const { upserts, issues } = planContactBatch(rawRecords, phoneFields, existingMobileOwners);

  if (upserts.length > 0) {
    await withBatchRetry(() =>
      prisma.$transaction(
        upserts.map((item) =>
          prisma.contact.upsert({
            where: { zohoContactId: item.zohoContactId },
            create: {
              zohoContactId: item.zohoContactId,
              mobileE164: item.mobileE164,
              altMobileE164: item.altMobileE164,
              fullName: item.fullName,
              email: item.email,
              raw: item.raw as Prisma.InputJsonValue,
              syncedAt: new Date(),
            },
            update: {
              mobileE164: item.mobileE164,
              altMobileE164: item.altMobileE164,
              fullName: item.fullName,
              email: item.email,
              raw: item.raw as Prisma.InputJsonValue,
              syncedAt: new Date(),
            },
          }),
        ),
      ),
    );
  }

  if (issues.length > 0) {
    await withBatchRetry(() =>
      prisma.syncIssue.createMany({
        data: issues.map((i) => ({ zohoRecordId: i.zohoRecordId, recordType: 'contact', field: i.field, rawValue: i.rawValue, reason: i.reason })),
        skipDuplicates: true,
      }),
    );
  }

  return { written: upserts.length, issues: issues.length };
}
