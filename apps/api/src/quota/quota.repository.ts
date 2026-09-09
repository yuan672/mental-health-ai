import { randomUUID } from 'node:crypto';
import { and, dailyUsageQuotas, eq, quotaConsumptions, sql } from '@mental-health/database';
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export type DailyUsageRecord = {
  userId: string;
  usageDate: string;
  dailyLimit: number;
  usedCount: number;
};

export type QuotaConsumeResult =
  | { status: 'consumed' | 'already_consumed'; usage: DailyUsageRecord }
  | { status: 'limit_reached' };

class QuotaLimitReachedError extends Error {}

@Injectable()
export class QuotaRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async getDailyUsage(userId: string, usageDate: string): Promise<DailyUsageRecord | null> {
    const [usage] = await this.databaseService.database
      .select({
        userId: dailyUsageQuotas.userId,
        usageDate: dailyUsageQuotas.usageDate,
        dailyLimit: dailyUsageQuotas.dailyLimit,
        usedCount: dailyUsageQuotas.usedCount,
      })
      .from(dailyUsageQuotas)
      .where(and(eq(dailyUsageQuotas.userId, userId), eq(dailyUsageQuotas.usageDate, usageDate)))
      .limit(1);

    return usage ?? null;
  }

  async consume(input: {
    userId: string;
    usageDate: string;
    dailyLimit: number;
    idempotencyKey: string;
    now: Date;
  }): Promise<QuotaConsumeResult> {
    try {
      return await this.databaseService.database.transaction(async (transaction) => {
        const [insertedConsumption] = await transaction
          .insert(quotaConsumptions)
          .values({
            id: randomUUID(),
            userId: input.userId,
            usageDate: input.usageDate,
            idempotencyKey: input.idempotencyKey,
            createdAt: input.now,
          })
          .onConflictDoNothing({
            target: [
              quotaConsumptions.userId,
              quotaConsumptions.usageDate,
              quotaConsumptions.idempotencyKey,
            ],
          })
          .returning({ id: quotaConsumptions.id });

        if (!insertedConsumption) {
          const [existingUsage] = await transaction
            .select({
              userId: dailyUsageQuotas.userId,
              usageDate: dailyUsageQuotas.usageDate,
              dailyLimit: dailyUsageQuotas.dailyLimit,
              usedCount: dailyUsageQuotas.usedCount,
            })
            .from(dailyUsageQuotas)
            .where(
              and(
                eq(dailyUsageQuotas.userId, input.userId),
                eq(dailyUsageQuotas.usageDate, input.usageDate),
              ),
            )
            .limit(1);

          if (!existingUsage) {
            throw new Error('Quota consumption exists without a daily usage aggregate');
          }

          return { status: 'already_consumed', usage: existingUsage };
        }

        const [usage] = await transaction
          .insert(dailyUsageQuotas)
          .values({
            userId: input.userId,
            usageDate: input.usageDate,
            dailyLimit: input.dailyLimit,
            usedCount: 1,
            createdAt: input.now,
            updatedAt: input.now,
          })
          .onConflictDoUpdate({
            target: [dailyUsageQuotas.userId, dailyUsageQuotas.usageDate],
            set: {
              usedCount: sql`${dailyUsageQuotas.usedCount} + 1`,
              updatedAt: input.now,
            },
            setWhere: sql`${dailyUsageQuotas.usedCount} < ${dailyUsageQuotas.dailyLimit}`,
          })
          .returning({
            userId: dailyUsageQuotas.userId,
            usageDate: dailyUsageQuotas.usageDate,
            dailyLimit: dailyUsageQuotas.dailyLimit,
            usedCount: dailyUsageQuotas.usedCount,
          });

        if (!usage) {
          throw new QuotaLimitReachedError();
        }

        return { status: 'consumed', usage };
      });
    } catch (error) {
      if (error instanceof QuotaLimitReachedError) {
        return { status: 'limit_reached' };
      }
      throw error;
    }
  }
}
