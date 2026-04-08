import { Global, Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { StubNotificationProvider } from './providers/stub.provider';
import { NOTIFICATION_PROVIDER } from './providers/notification-provider.interface';

@Global()
@Module({
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    {
      provide: NOTIFICATION_PROVIDER,
      useClass: StubNotificationProvider,
    },
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
