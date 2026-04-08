import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { OnEvent } from '@nestjs/event-emitter';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';

@WebSocketGateway({ cors: true, namespace: '/queue' })
export class QueueGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(QueueGateway.name);

  handleConnection(client: Socket) {
    const siteId = client.handshake.query.siteId as string;
    if (siteId) {
      client.join(`site:${siteId}`);
      this.logger.log(
        `Client ${client.id} joined queue room site:${siteId}`,
      );
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client ${client.id} disconnected`);
  }

  @OnEvent('queue.recomputed')
  handleQueueRecomputed(payload: { siteId: string; updatedAt: Date }) {
    this.server
      .to(`site:${payload.siteId}`)
      .emit('queue:updated', {
        siteId: payload.siteId,
        updatedAt: payload.updatedAt.toISOString(),
      });

    this.logger.log(
      `Broadcast queue:updated to site:${payload.siteId}`,
    );
  }
}
