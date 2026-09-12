import { Global, Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { CredentialWorkAdmissionService } from './credential-work-admission.service';
import { httpRateLimitConfiguration, monotonicClock } from './http-abuse.config';
import { HttpAbuseAdmissionService } from './http-abuse-admission.service';
import { IngressRateLimitGuard } from './ingress-rate-limit.guard';
import { PrincipalRateLimitInterceptor } from './principal-rate-limit.interceptor';
import { ProcessLocalTokenBucketStore } from './process-local-token-bucket.store';
import { HTTP_RATE_LIMIT_CONFIG, MONOTONIC_CLOCK } from './http-abuse.types';
import { SecurityModule } from '../security/security.module';

@Global()
@Module({
  imports: [SecurityModule],
  providers: [
    { provide: HTTP_RATE_LIMIT_CONFIG, useFactory: httpRateLimitConfiguration },
    { provide: MONOTONIC_CLOCK, useValue: monotonicClock },
    ProcessLocalTokenBucketStore,
    HttpAbuseAdmissionService,
    CredentialWorkAdmissionService,
    { provide: APP_GUARD, useClass: IngressRateLimitGuard },
    { provide: APP_INTERCEPTOR, useClass: PrincipalRateLimitInterceptor },
  ],
  exports: [
    HTTP_RATE_LIMIT_CONFIG,
    ProcessLocalTokenBucketStore,
    HttpAbuseAdmissionService,
    CredentialWorkAdmissionService,
  ],
})
export class HttpAbuseProtectionModule {}
