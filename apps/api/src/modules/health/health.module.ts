import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

/**
 * CR-2026-094 — deployment verification. PrismaService comes from the global
 * PrismaModule; nothing else is needed, and keeping this module dependency-free is
 * what lets /health answer even when most of the application is unhappy.
 */
@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
