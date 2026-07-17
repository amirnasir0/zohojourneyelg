import type { Contact } from '@prisma/client';
import { prisma } from './prisma.js';
import type { ZohoDeskClient } from './zoho-desk-client.js';

/**
 * Resolves a local Contact -> Desk contact ID, caching the result on
 * Contact.deskContactId after the first successful resolution:
 * 1. Already resolved — used verbatim, no Desk call.
 * 2. Search Desk by CRM contact reference, then by phone/email (see
 *    zoho-desk-client's scanContacts — a full-list client-side scan today,
 *    since Desk.search.READ scope isn't confirmed granted; swap in a real
 *    search call once it is, this function's contract doesn't change).
 * 3. Not found anywhere — create a new Desk contact bridged via
 *    zohoCRMContact so future lookups (by us or Desk's own CRM sync) find it
 *    by step 2 immediately.
 */
export async function resolveDeskContactId(deskClient: ZohoDeskClient, contact: Contact): Promise<string> {
  if (contact.deskContactId) {
    return contact.deskContactId;
  }

  const byCrmId = await deskClient.findContactByCrmId(contact.zohoContactId);
  if (byCrmId) {
    await prisma.contact.update({ where: { id: contact.id }, data: { deskContactId: byCrmId.id } });
    return byCrmId.id;
  }

  const byPhoneOrEmail = await deskClient.findContactByPhoneOrEmail(contact.mobileE164, contact.email);
  if (byPhoneOrEmail) {
    await prisma.contact.update({ where: { id: contact.id }, data: { deskContactId: byPhoneOrEmail.id } });
    return byPhoneOrEmail.id;
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
