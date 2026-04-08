export interface SendNotificationInput {
  channel: 'SMS' | 'EMAIL';
  recipient: string;
  templateKey: string;
  templateData: Record<string, unknown>;
}

export interface SendNotificationResult {
  success: boolean;
  providerReference?: string;
  failureReason?: string;
}

export interface NotificationProvider {
  send(input: SendNotificationInput): Promise<SendNotificationResult>;
}

export const NOTIFICATION_PROVIDER = 'NOTIFICATION_PROVIDER';
