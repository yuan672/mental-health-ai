import { Injectable } from '@nestjs/common';
import { env } from '../../config/env';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

@Injectable()
export class RiskEventRetentionPolicy {
  getRetentionUntil(createdAt: Date): Date {
    return new Date(createdAt.getTime() + env.RISK_EVENT_RETENTION_DAYS * MILLISECONDS_PER_DAY);
  }
}

@Injectable()
export class AuditRetentionPolicy {
  getRetentionUntil(createdAt: Date): Date {
    return new Date(createdAt.getTime() + env.AUDIT_RETENTION_DAYS * MILLISECONDS_PER_DAY);
  }
}
