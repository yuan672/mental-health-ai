import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { directNetworkIdentity } from './network-identity';
import { HttpAbuseAdmissionService } from './http-abuse-admission.service';
import { HTTP_INGRESS_METADATA, type HttpIngressMetadata } from './http-abuse.metadata';

@Injectable()
export class IngressRateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly admission: HttpAbuseAdmissionService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const metadata = this.reflector.getAllAndOverride<HttpIngressMetadata>(HTTP_INGRESS_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (metadata?.skip) return true;
    const request = context.switchToHttp().getRequest<Request>();
    const key = directNetworkIdentity(request);
    const lane = metadata?.lane ?? 'standard';
    this.admission.admit(`network_${lane === 'mixed' ? 'mixed_probe' : lane}`, key, 'network');
    for (const policy of metadata?.additionalPolicies ?? []) {
      this.admission.admit(policy, key, 'network');
    }
    return true;
  }
}
