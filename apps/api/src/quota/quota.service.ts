import { Injectable } from '@nestjs/common';
import { DatabaseError, QuotaExceededError, ValidationError } from '../common/errors';
import { QuotaPolicyService } from './quota-policy.service';
import { QuotaRepository, type DailyUsageRecord } from './quota.repository';

export type QuotaSnapshot = DailyUsageRecord & {
  remaining: number;
};

function snapshot(usage: DailyUsageRecord): QuotaSnapshot {
  return {
    ...usage,
    remaining: Math.max(0, usage.dailyLimit - usage.usedCount),
  };
}

@Injectable()
export class QuotaService {
  constructor(
    private readonly policy: QuotaPolicyService,
    private readonly repository: QuotaRepository,
  ) {}

  getDailyLimit(userId: string): number {
    return this.policy.getDailyLimit(userId);
  }

  async getUsage(userId: string, now = new Date()): Promise<QuotaSnapshot> {
    const usageDate = this.policy.getUsageDate(now);
    let usage: DailyUsageRecord | null;
    try {
      usage = await this.repository.getDailyUsage(userId, usageDate);
    } catch {
      throw new DatabaseError();
    }

    return snapshot(
      usage ?? {
        userId,
        usageDate,
        dailyLimit: this.policy.getDailyLimit(userId),
        usedCount: 0,
      },
    );
  }

  async canUseAI(userId: string, now = new Date()): Promise<boolean> {
    const usage = await this.getUsage(userId, now);
    return usage.usedCount < usage.dailyLimit;
  }

  async consumeQuota(
    userId: string,
    idempotencyKey: string,
    now = new Date(),
  ): Promise<QuotaSnapshot> {
    if (idempotencyKey.length < 1 || idempotencyKey.length > 128) {
      throw new ValidationError('额度消费幂等键无效');
    }

    const usageDate = this.policy.getUsageDate(now);
    let result;
    try {
      result = await this.repository.consume({
        userId,
        usageDate,
        dailyLimit: this.policy.getDailyLimit(userId),
        idempotencyKey,
        now,
      });
    } catch {
      throw new DatabaseError();
    }

    if (result.status === 'limit_reached') {
      throw new QuotaExceededError();
    }

    return snapshot(result.usage);
  }
}
