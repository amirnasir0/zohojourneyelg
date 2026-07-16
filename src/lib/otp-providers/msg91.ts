import type { OtpProvider, OtpSendParams } from './types.js';

const MSG91_API_URL = 'https://control.msg91.com/api/v5/otp';

export class Msg91Provider implements OtpProvider {
  async send({ mobile, otp }: OtpSendParams): Promise<boolean> {
    const apiKey = process.env.MSG91_API_KEY;
    if (!apiKey) {
      if (process.env.NODE_ENV === 'development') {
        console.log(`[msg91-stub] would send SMS OTP ${otp} to ${mobile}`);
        return true;
      }
      console.error('[msg91] MSG91_API_KEY not set — refusing to fake-succeed outside development');
      return false;
    }

    try {
      const url = new URL(MSG91_API_URL);
      url.searchParams.set('otp', otp);
      url.searchParams.set('mobile', mobile.replace('+', ''));

      const res = await fetch(url, {
        method: 'POST',
        headers: { authkey: apiKey },
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '<unreadable body>');
        console.error(`[msg91] send failed: status=${res.status} body=${body}`);
      }

      return res.ok;
    } catch (err) {
      console.error('[msg91] send threw', err);
      return false;
    }
  }
}
