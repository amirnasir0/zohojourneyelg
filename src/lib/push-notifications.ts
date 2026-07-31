import { Expo, type ExpoPushMessage } from 'expo-server-sdk';
import { prisma } from './prisma.js';

const expo = new Expo();

/**
 * Best-effort push send — never throws. A push failure (no tokens, an
 * expired token, Expo's API being down) must never break the staff action
 * that triggered it (e.g. submit-for-review), same philosophy as the
 * cache-invalidation calls elsewhere in this codebase.
 */
export async function sendPushToContact(contactId: string, title: string, body: string, data?: Record<string, unknown>): Promise<void> {
  try {
    const tokens = await prisma.deviceToken.findMany({ where: { contactId } });
    if (tokens.length === 0) return;

    const messages: ExpoPushMessage[] = tokens
      .filter((t) => Expo.isExpoPushToken(t.token))
      .map((t) => ({ to: t.token, title, body, sound: 'default', ...(data !== undefined ? { data } : {}) }));
    if (messages.length === 0) return;

    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      await expo.sendPushNotificationsAsync(chunk);
    }
  } catch (err) {
    console.error('[push-notifications] sendPushToContact failed (non-fatal):', err);
  }
}
