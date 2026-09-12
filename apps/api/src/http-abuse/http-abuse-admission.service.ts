import { Injectable } from '@nestjs/common';
import { RateLimitError } from '../common/errors';
import { SecurityLoggingService } from '../security/security-logging.service';
import { ProcessLocalTokenBucketStore } from './process-local-token-bucket.store';
import type { HttpRateLimitIdentityKind, HttpRateLimitPolicy } from './http-abuse.types';

@Injectable()
export class HttpAbuseAdmissionService {
  constructor(
    private readonly buckets: ProcessLocalTokenBucketStore,
    private readonly securityLogger: SecurityLoggingService,
  ) {}

  admit(policy: HttpRateLimitPolicy, key: string, identityKind: HttpRateLimitIdentityKind): void {
    const result = this.buckets.consume(policy, `${identityKind}:${key}`);
    if (result.allowed) return;
    this.securityLogger.httpRateLimited(policy, identityKind, result.reason);
    throw new RateLimitError(undefined, result.retryAfterSeconds);
  }

  rejectConcurrency(policy: HttpRateLimitPolicy, identityKind: HttpRateLimitIdentityKind): never {
    this.securityLogger.httpRateLimited(policy, identityKind, 'concurrency_capacity');
    throw new RateLimitError();
  }
}
