import { describe, expect, it } from 'vitest';
import type { TenantConfig } from '../src/config/types.js';
import { buildDocumentChecklist, type DocumentRowLike } from '../src/lib/document-view.js';

const tenantConfig = {
  documents: {
    stage_groups: [
      {
        stage_group_key: 'documents_required',
        group_label: 'Documents Required',
        requires_approval: true,
        documents: [
          { key: 'aadhaar_card', display_name: 'Aadhaar Card' },
          { key: 'pan_card', display_name: 'PAN Card' },
        ],
      },
      {
        stage_group_key: 'sales_order_draft',
        group_label: 'Sales Order Draft',
        requires_approval: false,
        documents: [{ key: 'draft_sales_order', display_name: 'Draft Sales Order' }],
      },
      {
        stage_group_key: 'material_dispatched',
        group_label: 'Material Dispatched',
        requires_approval: true,
        documents: [],
      },
    ],
  },
} as unknown as TenantConfig;

function row(overrides: Partial<DocumentRowLike> & Pick<DocumentRowLike, 'documentKey' | 'status'>): DocumentRowLike {
  return {
    fileName: null,
    fileSize: null,
    zohoAttachmentId: null,
    uploadedById: null,
    uploadedAt: null,
    reviewedAt: null,
    reviewNote: null,
    ...overrides,
  };
}

describe('buildDocumentChecklist', () => {
  it('synthesizes NOT_UPLOADED placeholders for configured keys with no row', () => {
    const groups = buildDocumentChecklist(tenantConfig, [], false);
    const required = groups.find((g) => g.stage_group_key === 'documents_required')!;
    expect(required.documents).toEqual([
      expect.objectContaining({ key: 'aadhaar_card', status: 'NOT_UPLOADED' }),
      expect.objectContaining({ key: 'pan_card', status: 'NOT_UPLOADED' }),
    ]);
  });

  it('an empty group is vacuously COMPLETED', () => {
    const groups = buildDocumentChecklist(tenantConfig, [], false);
    expect(groups.find((g) => g.stage_group_key === 'material_dispatched')?.group_status).toBe('COMPLETED');
  });

  it('a requires_approval group is PENDING until every document is APPROVED', () => {
    const rows = [row({ documentKey: 'aadhaar_card', status: 'UPLOADED' }), row({ documentKey: 'pan_card', status: 'APPROVED' })];
    const groups = buildDocumentChecklist(tenantConfig, rows, false);
    expect(groups.find((g) => g.stage_group_key === 'documents_required')?.group_status).toBe('PENDING');
  });

  it('a requires_approval group is COMPLETED once every document is APPROVED', () => {
    const rows = [row({ documentKey: 'aadhaar_card', status: 'APPROVED' }), row({ documentKey: 'pan_card', status: 'APPROVED' })];
    const groups = buildDocumentChecklist(tenantConfig, rows, false);
    expect(groups.find((g) => g.stage_group_key === 'documents_required')?.group_status).toBe('COMPLETED');
  });

  it('a non-requires_approval group is COMPLETED once every document is at least UPLOADED', () => {
    const rows = [row({ documentKey: 'draft_sales_order', status: 'UPLOADED' })];
    const groups = buildDocumentChecklist(tenantConfig, rows, false);
    expect(groups.find((g) => g.stage_group_key === 'sales_order_draft')?.group_status).toBe('COMPLETED');
  });

  it('omits zoho_attachment_id/uploaded_by unless includeInternalFields is true', () => {
    const rows = [row({ documentKey: 'aadhaar_card', status: 'UPLOADED', zohoAttachmentId: 'z1', uploadedById: 'staff-1' })];

    const customerView = buildDocumentChecklist(tenantConfig, rows, false);
    const customerDoc = customerView.find((g) => g.stage_group_key === 'documents_required')?.documents.find((d) => d.key === 'aadhaar_card');
    expect(customerDoc?.zoho_attachment_id).toBeUndefined();
    expect(customerDoc?.uploaded_by).toBeUndefined();

    const staffView = buildDocumentChecklist(tenantConfig, rows, true);
    const staffDoc = staffView.find((g) => g.stage_group_key === 'documents_required')?.documents.find((d) => d.key === 'aadhaar_card');
    expect(staffDoc?.zoho_attachment_id).toBe('z1');
    expect(staffDoc?.uploaded_by).toBe('staff-1');
  });
});
