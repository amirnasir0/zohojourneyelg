import type { Contact } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    contact: { update: vi.fn() },
  },
}));

const { prisma } = await import('../src/lib/prisma.js');
const { resolveDeskContactId, createTicketForContact } = await import('../src/lib/desk-contact-bridge.js');

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

  it('resolves via phone/email search first (the fast, search-backed path) and caches the result', async () => {
    const contact = makeContact();
    deskClient.findContactByPhoneOrEmail.mockResolvedValue({ id: 'dc-by-phone' });

    const result = await resolveDeskContactId(deskClient as never, contact);

    expect(result).toBe('dc-by-phone');
    expect(deskClient.findContactByPhoneOrEmail).toHaveBeenCalledWith('+919999999999', 'uzeb@example.com');
    expect(deskClient.findContactByCrmId).not.toHaveBeenCalled();
    expect(prisma.contact.update).toHaveBeenCalledWith({ where: { id: 'local-1' }, data: { deskContactId: 'dc-by-phone' } });
  });

  it('falls back to the CRM-reference scan when phone/email search finds nothing', async () => {
    const contact = makeContact();
    deskClient.findContactByPhoneOrEmail.mockResolvedValue(null);
    deskClient.findContactByCrmId.mockResolvedValue({ id: 'dc-by-crm' });

    const result = await resolveDeskContactId(deskClient as never, contact);

    expect(result).toBe('dc-by-crm');
    expect(deskClient.findContactByCrmId).toHaveBeenCalledWith('zc1');
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

describe('createTicketForContact', () => {
  const ticketInput = { departmentId: 'dept1', subject: 'Panels not working', category: 'Defects' };

  it('creates the ticket directly using a cached deskContactId, no retry', async () => {
    const contact = makeContact({ deskContactId: 'dc-cached' });
    deskClient.createTicket.mockResolvedValue({ id: 't1' });

    const result = await createTicketForContact(deskClient as never, contact, ticketInput);

    expect(result).toEqual({ id: 't1' });
    expect(deskClient.createTicket).toHaveBeenCalledTimes(1);
    expect(deskClient.createTicket).toHaveBeenCalledWith({ ...ticketInput, contactId: 'dc-cached' });
    expect(prisma.contact.update).not.toHaveBeenCalled();
  });

  it('resolves fresh (no retry needed) when there was nothing cached to begin with', async () => {
    const contact = makeContact({ deskContactId: null });
    deskClient.findContactByPhoneOrEmail.mockResolvedValue({ id: 'dc-fresh' });
    deskClient.createTicket.mockResolvedValue({ id: 't1' });

    const result = await createTicketForContact(deskClient as never, contact, ticketInput);

    expect(result).toEqual({ id: 't1' });
    expect(deskClient.createTicket).toHaveBeenCalledTimes(1);
  });

  it('on a 404 from a cached deskContactId, clears the cache, re-resolves, and retries once', async () => {
    const contact = makeContact({ deskContactId: 'dc-stale' });
    const notFoundErr = new Error('Zoho Desk createTicket failed: status=404 body={"errorCode":"CONTACT_NOT_FOUND"}');
    deskClient.createTicket.mockRejectedValueOnce(notFoundErr).mockResolvedValueOnce({ id: 't1' });
    deskClient.findContactByPhoneOrEmail.mockResolvedValue({ id: 'dc-fresh' });

    const result = await createTicketForContact(deskClient as never, contact, ticketInput);

    expect(result).toEqual({ id: 't1' });
    expect(deskClient.createTicket).toHaveBeenCalledTimes(2);
    expect(deskClient.createTicket).toHaveBeenNthCalledWith(1, { ...ticketInput, contactId: 'dc-stale' });
    expect(prisma.contact.update).toHaveBeenCalledWith({ where: { id: 'local-1' }, data: { deskContactId: null } });
    expect(deskClient.createTicket).toHaveBeenNthCalledWith(2, { ...ticketInput, contactId: 'dc-fresh' });
  });

  it('does not retry a non-404 error even with a cached deskContactId', async () => {
    const contact = makeContact({ deskContactId: 'dc-cached' });
    const validationErr = new Error('Zoho Desk createTicket failed: status=400 body={"errorCode":"INVALID_DATA"}');
    deskClient.createTicket.mockRejectedValue(validationErr);

    await expect(createTicketForContact(deskClient as never, contact, ticketInput)).rejects.toThrow(validationErr);
    expect(deskClient.createTicket).toHaveBeenCalledTimes(1);
    expect(prisma.contact.update).not.toHaveBeenCalled();
  });

  it('does not retry a 404 when nothing was cached to begin with (a freshly-resolved ID failing is a real error)', async () => {
    const contact = makeContact({ deskContactId: null });
    deskClient.findContactByPhoneOrEmail.mockResolvedValue({ id: 'dc-fresh' });
    const notFoundErr = new Error('Zoho Desk createTicket failed: status=404 body={}');
    deskClient.createTicket.mockRejectedValue(notFoundErr);

    await expect(createTicketForContact(deskClient as never, contact, ticketInput)).rejects.toThrow(notFoundErr);
    expect(deskClient.createTicket).toHaveBeenCalledTimes(1);
  });
});
