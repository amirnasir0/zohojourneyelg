import type { OtpProvider, OtpSendParams } from './types.js';

const INTERAKT_API_URL = 'https://api.interakt.ai/v1/public/message/';

export class InteraktProvider implements OtpProvider {
  constructor(private readonly template: string) {}

  async send({ mobile, otp }: OtpSendParams): Promise<boolean> {
    const apiKey = process.env.INTERAKT_API_KEY;
    if (!apiKey) {
      if (process.env.NODE_ENV === 'development') {
        console.log(`[interakt-stub] would send WhatsApp OTP ${otp} to ${mobile} via template "${this.template}"`);
        return true;
      }
      console.error('[interakt] INTERAKT_API_KEY not set — refusing to fake-succeed outside development');
      return false;
    }

    try {
      const res = await fetch(INTERAKT_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          countryCode: '+91',
          phoneNumber: mobile.replace('+91', ''),
          type: 'Template',
          template: {
            name: this.template,
            languageCode: 'en',
            bodyValues: [otp],
          },
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '<unreadable body>');
        console.error(`[interakt] send failed: status=${res.status} body=${body}`);
      }

      return res.ok;
    } catch (err) {
      console.error('[interakt] send threw', err);
      return false;
    }
  }
}
