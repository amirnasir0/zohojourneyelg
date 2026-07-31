import type { TenantConfig } from '../config/types.js';

export type DocumentStatusValue = 'NOT_UPLOADED' | 'UPLOADED' | 'SUBMITTED_FOR_REVIEW' | 'APPROVED' | 'REJECTED';

export interface DocumentRowLike {
  documentKey: string;
  fileName: string | null;
  fileSize: number | null;
  zohoAttachmentId: string | null;
  status: DocumentStatusValue;
  uploadedById: string | null;
  uploadedAt: Date | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
}

export interface DocumentItemView {
  key: string;
  display_name: string;
  status: DocumentStatusValue;
  file_name: string | null;
  file_size: number | null;
  uploaded_at: Date | null;
  reviewed_at: Date | null;
  review_note: string | null;
  zoho_attachment_id?: string | null;
  uploaded_by?: string | null;
}

export interface DocumentStageGroupView {
  stage_group_key: string;
  group_label: string;
  requires_approval: boolean;
  group_status: 'COMPLETED' | 'PENDING';
  documents: DocumentItemView[];
}

// Empty group -> vacuously COMPLETED. requires_approval groups need every
// document APPROVED; others just need every document past NOT_UPLOADED
// (UPLOADED/SUBMITTED_FOR_REVIEW/APPROVED all count).
function computeGroupStatus(requiresApproval: boolean, items: DocumentItemView[]): 'COMPLETED' | 'PENDING' {
  if (items.length === 0) {
    return 'COMPLETED';
  }
  if (requiresApproval) {
    return items.every((d) => d.status === 'APPROVED') ? 'COMPLETED' : 'PENDING';
  }
  return items.every((d) => d.status !== 'NOT_UPLOADED') ? 'COMPLETED' : 'PENDING';
}

/**
 * Merges tenant-configured document stage-groups with a contact's actual
 * (sparse — only created on first staff upload) Document rows, synthesizing
 * NOT_UPLOADED placeholders for any configured key with no row yet. Shared
 * by both the staff and customer GET routes so they can never disagree on
 * what's COMPLETED/PENDING. includeInternalFields adds zoho_attachment_id/
 * uploaded_by — internal ids the customer app has no use for.
 */
export function buildDocumentChecklist(tenantConfig: TenantConfig, rows: DocumentRowLike[], includeInternalFields: boolean): DocumentStageGroupView[] {
  const rowsByKey = new Map(rows.map((r) => [r.documentKey, r]));

  return tenantConfig.documents.stage_groups.map((group) => {
    const documents: DocumentItemView[] = group.documents.map((def) => {
      const row = rowsByKey.get(def.key);
      const item: DocumentItemView = {
        key: def.key,
        display_name: def.display_name,
        status: row?.status ?? 'NOT_UPLOADED',
        file_name: row?.fileName ?? null,
        file_size: row?.fileSize ?? null,
        uploaded_at: row?.uploadedAt ?? null,
        reviewed_at: row?.reviewedAt ?? null,
        review_note: row?.reviewNote ?? null,
      };
      if (includeInternalFields) {
        item.zoho_attachment_id = row?.zohoAttachmentId ?? null;
        item.uploaded_by = row?.uploadedById ?? null;
      }
      return item;
    });

    return {
      stage_group_key: group.stage_group_key,
      group_label: group.group_label,
      requires_approval: group.requires_approval,
      group_status: computeGroupStatus(group.requires_approval, documents),
      documents,
    };
  });
}
