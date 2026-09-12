import { Inject, Injectable } from '@nestjs/common';
import { AppError, ERROR_CODES, RateLimitError } from '../common/errors';
import { SecurityLoggingService } from '../security/security-logging.service';
import { HTTP_RATE_LIMIT_CONFIG, type HttpRateLimitConfiguration } from './http-abuse.types';

@Injectable()
export class CredentialWorkAdmissionService {
  private active = 0;

  constructor(
    @Inject(HTTP_RATE_LIMIT_CONFIG) private readonly config: HttpRateLimitConfiguration,
    private readonly securityLogger: SecurityLoggingService,
  ) {}

  async run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    this.assertUsable(signal);
    if (this.active >= this.config.credentialMaxConcurrency) {
      this.securityLogger.httpRateLimited('credential_work', 'network', 'concurrency_capacity');
      throw new RateLimitError();
    }
    this.active += 1;
    let started = false;
    try {
      this.assertUsable(signal);
      started = true;
      const result = await work();
      this.assertUsable(signal);
      return result;
    } finally {
      // Once native work starts, this path is reached only after that Promise settles.
      // Before-start cancellation also returns the acquired permit exactly once.
      void started;
      this.active -= 1;
    }
  }

  get activeCount(): number {
    return this.active;
  }

  private assertUsable(signal: AbortSignal): void {
    if (!signal.aborted) return;
    throw signal.reason ?? new AppError(ERROR_CODES.INTERNAL_ERROR, 503, '请求暂时无法完成');
  }
}
