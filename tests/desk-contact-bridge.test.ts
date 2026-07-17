import type { Contact } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    contact: { update: vi.fn() },
  },
}));

const { prisma } = await import('../src/lib/prisma.js');
const { resolveDeskContactId } = await import('../src/lib/desk-contact-bridge.js');

const deskClient = {
  getDepartments: vi.fn(),
  getTicketFields: vi.fn(),
  getTicketsPage: vi.fn(),
  getTicket: vi.fn(),
  createTicket: vi.fn(),
  findContactByCrmId: vi.fn(),
  findContactByPhoneOrEmail: vi.fn(),
  createContact: vi.fn(),
};

function makeContact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 'local-1',
    zohoContactId: 'zc1',
    deskContactId: null,
    mobileE164: '+919999999999',
    altMobileE164: null,
    fullName: 'Uzeb Sayyad',
    email: 'uzeb@example.com',
    raw: {},
    syncedAt: new Date(),
    ...overrides,
  } as Contact;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveDeskContactId', () => {
  it('returns the cached deskContactId without calling Desk at all', async () => {
    const contact = makeContact({ deskContactId: 'dc-cached' });
    const result = await resolveDeskContactId(deskClient as never, contact);

    expect(result).toBe('dc-cached');
    expect(deskClient.findContactByCrmId).not.toHaveBeenCalled();
    expect(deskClient.findContactByPhoneOrEmail).not.toHaveBeenCalled();
    expect(deskClient.createContact).not.toHaveBeenCalled();
  });

  it('resolves via CRM contact reference first and caches the result', async () => {
    const contact = makeContact();
    deskClient.findContactByCrmId.mockResolvedValue({ id: 'dc-by-crm' });

    const result = await resolveDeskContactId(deskClient as never, contact);

    expect(result).toBe('dc-by-crm');
    expect(deskClient.findContactByCrmId).toHaveBeenCalledWith('zc1');
    expect(deskClient.findContactByPhoneOrEmail).not.toHaveBeenCalled();
    expect(prisma.contact.update).toHaveBeenCalledWith({ where: { id: 'local-1' }, data: { deskContactId: 'dc-by-crm' } });
  });

  it('falls back to phone/email search when the CRM reference does not resolve', async () => {
    const contact = makeContact();
    deskClient.findContactByCrmId.mockResolvedValue(null);
    deskClient.findContactByPhoneOrEmail.mockResolvedValue({ id: 'dc-by-phone' });

    const result = await resolveDeskContactId(deskClient as never, contact);

    expect(result).toBe('dc-by-phone');
    expect(deskClient.findContactByPhoneOrEmail).toHaveBeenCalledWith('+919999999999', 'uzeb@example.com');
    expect(deskClient.createContact).not.toHaveBeenCalled();
  });

  it('creates a new Desk contact when neither lookup finds one, splitting full_name into first/last', async () => {
    const contact = makeContact({ fullName: 'Uzeb Sayyad' });
    deskClient.findContactByCrmId.mockResolvedValue(null);
    deskClient.findContactByPhoneOrEmail.mockResolvedValue(null);
    deskClient.createContact.mockResolvedValue({ id: 'dc-new' });

    const result = await resolveDeskContactId(deskClient as never, contact);

    expect(result).toBe('dc-new');
    expect(deskClient.createContact).toHaveBeenCalledWith({
      firstName: 'Uzeb',
      lastName: 'Sayyad',
      email: 'uzeb@example.com',
      phone: '+919999999999',
      crmContactId: 'zc1',
    });
    expect(prisma.contact.update).toHaveBeenCalledWith({ where: { id: 'local-1' }, data: { deskContactId: 'dc-new' } });
  });

  it('treats a single-word full_name as lastName only, with null firstName', async () => {
    const contact = makeContact({ fullName: 'Cher' });
    deskClient.findContactByCrmId.mockResolvedValue(null);
    deskClient.findContactByPhoneOrEmail.mockResolvedValue(null);
    deskClient.createContact.mockResolvedValue({ id: 'dc-new' });

    await resolveDeskContactId(deskClient as never, contact);

    expect(deskClient.createContact).toHaveBeenCalledWith(expect.objectContaining({ firstName: null, lastName: 'Cher' }));
  });

  it('falls back to "Customer" as lastName when full_name is null', async () => {
    const contact = makeContact({ fullName: null });
    deskClient.findContactByCrmId.mockResolvedValue(null);
    deskClient.findContactByPhoneOrEmail.mockResolvedValue(null);
    deskClient.createContact.mockResolvedValue({ id: 'dc-new' });

    await resolveDeskContactId(deskClient as never, contact);

    expect(deskClient.createContact).toHaveBeenCalledWith(expect.objectContaining({ firstName: null, lastName: 'Customer' }));
  });
});
