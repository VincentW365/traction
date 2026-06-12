import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { SandboxContextService } from './sandbox-context.service';

/**
 * Global interceptor (CR-2026-023). When the authenticated request carries a
 * dev-login sandbox claim (`request.user.sandboxRunId`), it wraps the handler in
 * the sandbox AsyncLocalStorage context. Requests WITHOUT the claim (every normal
 * username/password request, public routes) are returned untouched — zero wrapping,
 * zero behaviour change. Dev-login itself is env-gated, so no sandbox claim can
 * exist in production.
 */
@Injectable()
export class SandboxContextInterceptor implements NestInterceptor {
  constructor(private readonly sandbox: SandboxContextService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest();
    const runId: string | undefined = req?.user?.sandboxRunId;
    if (!runId) return next.handle(); // normal requests: untouched

    return new Observable((subscriber) => {
      this.sandbox.run(runId, () => next.handle().subscribe(subscriber));
    });
  }
}
