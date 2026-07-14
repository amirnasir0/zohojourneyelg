import type { TenantConfig } from '../../config/types.js';
import { InteraktProvider } from './interakt.js';
import { Msg91Provider } from './msg91.js';

export interface SendOtpResult {
  success: boolean;
  channel: 'whatsapp' | 'sms' | null;
}

export async function sendOtp(tenantConfig: TenantConfig, mobile: string, otp: string): Promise<SendOtpResult> {
  for (const channel of tenantConfig.notifications.otp_channel) {
    if (channel === 'whatsapp') {
      const provider = new InteraktProvider(tenantConfig.notifications.interakt_otp_template);
      if (await provider.send({ mobile, otp })) {
        return { success: true, channel: 'whatsapp' };
      }
    } else if (channel === 'sms_fallback') {
      const provider = new Msg91Provider();
      if (await provider.send({ mobile, otp })) {
        return { success: true, channel: 'sms' };
      }
    }
  }

  return { success: false, channel: null };
}
