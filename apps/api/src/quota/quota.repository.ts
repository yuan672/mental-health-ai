import { randomUUID } from 'node:crypto';
import {
  and,
  dailyUsageQuotas,
  eq,
  gt,
  quotaConsumptions,
  sql,
  type AppTransaction,
} from '@mental-health/database';
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

export class QuotaLimitReachedError extends Error {}

export type QuotaRefundResult =
  { status: 'refunded'; usage: DailyUsageRecord } | { status: 'not_consumed' };

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
      return await this.databaseService.database.transaction((transaction) =>
        this.consumeWithinTransaction(transaction, input),
      );
    } catch (error) {
      if (error instanceof QuotaLimitReachedError) {
        return { status: 'limit_reached' };
      }
      throw error;
    }
  }

  async consumeWithinTransaction(
    transaction: AppTransaction,
    input: {
      userId: string;
      usageDate: string;
      dailyLimit: number;
      idempotencyKey: string;
      now: Date;
    },
  ): Promise<QuotaConsumeResult> {
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
  }

  async refund(userId: string, idempotencyKey: string, now: Date): Promise<QuotaRefundResult> {
    return this.databaseService.database.transaction(async (transaction) => {
      const matching = await transaction
        .select({ id: quotaConsumptions.id, usageDate: quotaConsumptions.usageDate })
        .from(quotaConsumptions)
        .where(
          and(
            eq(quotaConsumptions.userId, userId),
            eq(quotaConsumptions.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(2)
        .for('update');

      if (matching.length === 0) {
        return { status: 'not_consumed' };
      }
      if (matching.length > 1) {
        throw new Error('Quota refund key matches more than one consumption');
      }

      const consumption = matching[0];
      if (!consumption) {
        return { status: 'not_consumed' };
      }
      const [deleted] = await transaction
        .delete(quotaConsumptions)
        .where(eq(quotaConsumptions.id, consumption.id))
        .returning({ usageDate: quotaConsumptions.usageDate });
      if (!deleted) {
        return { status: 'not_consumed' };
      }

      const [usage] = await transaction
        .update(dailyUsageQuotas)
        .set({ usedCount: sql`${dailyUsageQuotas.usedCount} - 1`, updatedAt: now })
        .where(
          and(
            eq(dailyUsageQuotas.userId, userId),
            eq(dailyUsageQuotas.usageDate, consumption.usageDate),
            gt(dailyUsageQuotas.usedCount, 0),
          ),
        )
        .returning({
          userId: dailyUsageQuotas.userId,
          usageDate: dailyUsageQuotas.usageDate,
          dailyLimit: dailyUsageQuotas.dailyLimit,
          usedCount: dailyUsageQuotas.usedCount,
        });

      if (!usage) {
        throw new Error('Quota consumption exists without a refundable aggregate');
      }
      return { status: 'refunded', usage };
    });
  }
}
