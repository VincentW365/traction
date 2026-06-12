import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { SandboxContextService } from './sandbox-context.service';
import { SandboxContextInterceptor } from './sandbox-context.interceptor';

/**
 * CR-2026-023 — provides the request-scoped dev-login sandbox context (@Global so
 * any service can read it) + registers the global interceptor that populates it.
 */
@Global()
@Module({
  providers: [
    SandboxContextService,
    { provide: APP_INTERCEPTOR, useClass: SandboxContextInterceptor },
  ],
  exports: [SandboxContextService],
})
export class SandboxModule {}
