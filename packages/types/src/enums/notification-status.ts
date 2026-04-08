export const NotificationChannel = {
  SMS: 'SMS',
  EMAIL: 'EMAIL',
  WHATSAPP: 'WHATSAPP',
} as const;

export type NotificationChannel =
  (typeof NotificationChannel)[keyof typeof NotificationChannel];

export const NotificationDeliveryStatus = {
  PENDING: 'PENDING',
  SCHEDULED: 'SCHEDULED',
  SENT: 'SENT',
  DELIVERED: 'DELIVERED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const;

export type NotificationDeliveryStatus =
  (typeof NotificationDeliveryStatus)[keyof typeof NotificationDeliveryStatus];
