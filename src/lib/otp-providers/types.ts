export interface OtpSendParams {
  mobile: string;
  otp: string;
}

export interface OtpProvider {
  send(params: OtpSendParams): Promise<boolean>;
}
