import type { Contact } from '@prisma/client';
import { prisma } from './prisma.js';
import type { ZohoDeskClient } from './zoho-desk-client.js';

/**
 * Resolves a local Contact -> Desk contact ID, caching the result on
 * Contact.deskContactId after the first successful resolution:
 * 1. Already resolved — used verbatim, no Desk call.
 * 2. Search Desk by phone/email first — Desk.search.READ is confirmed
 *    granted and /contacts/search confirmed working live (17 Jul), so this
 *    is fast; falls back to a full-list scan internally only on a search
 *    error (see zoho-desk-client's findContactByPhoneOrEmail).
 * 3. Fall back to a CRM-contact-reference scan — Desk has no dedicated
 *    search parameter for the zohoCRMContact back-reference, so this is
 *    always a full-list scan; kept as the last resort specifically because
 *    it's the slow path, not the first check.
 * 4. Not found anywhere — create a new Desk contact bridged via
 *    zohoCRMContact so future lookups find it by step 2 immediately.
 */
export async function resolveDeskContactId(deskClient: ZohoDeskClient, contact: Contact): Promise<string> {
  if (contact.deskContactId) {
    return contact.deskContactId;
  }

  const byPhoneOrEmail = await deskClient.findContactByPhoneOrEmail(contact.mobileE164, contact.email);
  if (byPhoneOrEmail) {
    await prisma.contact.update({ where: { id: contact.id }, data: { deskContactId: byPhoneOrEmail.id } });
    return byPhoneOrEmail.id;
  }

  const byCrmId = await deskClient.findContactByCrmId(contact.zohoContactId);
  if (byCrmId) {
    await prisma.contact.update({ where: { id: contact.id }, data: { deskContactId: byCrmId.id } });
    return byCrmId.id;
  }

  const nameParts = (contact.fullName ?? 'Customer').trim().split(/\s+/);
  const firstName = nameParts.length > 1 ? nameParts.slice(0, -1).join(' ') : null;
  const lastName = nameParts.length > 1 ? nameParts[nameParts.length - 1]! : nameParts[0]!;

  const created = await deskClient.createContact({
    firstName,
    lastName,
    email: contact.email,
    phone: contact.mobileE164,
    crmContactId: contact.zohoContactId,
  });

  await prisma.contact.update({ where: { id: contact.id }, data: { deskContactId: created.id } });
  return created.id;
}
