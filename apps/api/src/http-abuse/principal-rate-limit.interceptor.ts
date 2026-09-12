import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Observable } from 'rxjs';
import type { AuthenticatedRequest } from '../auth/authenticated-request';
import type { StaffAuthenticatedRequest } from '../admin/staff-authenticated-request';
import { HttpAbuseAdmissionService } from './http-abuse-admission.service';
import { HTTP_PRINCIPAL_METADATA, type HttpPrincipalMetadata } from './http-abuse.metadata';

@Injectable()
export class PrincipalRateLimitInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly admission: HttpAbuseAdmissionService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const metadata = this.reflector.getAllAndOverride<HttpPrincipalMetadata>(
      HTTP_PRINCIPAL_METADATA,
      [context.getHandler(), context.getClass()],
    );
    if (!metadata || metadata.policy === 'manual') return next.handle();
    const request = context
      .switchToHttp()
      .getRequest<AuthenticatedRequest & Partial<StaffAuthenticatedRequest>>();
    const key =
      metadata.identityKind === 'staff'
        ? request.staffSession?.id
        : request.authenticatedSession?.userId;
    if (!key) throw new Error('Authenticated principal is unavailable for HTTP admission');
    this.admission.admit(metadata.policy, key, metadata.identityKind);
    return next.handle();
  }
}
