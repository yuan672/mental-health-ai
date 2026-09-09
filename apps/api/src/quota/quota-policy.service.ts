import { Injectable } from '@nestjs/common';
import { env } from '../config/env';

@Injectable()
export class QuotaPolicyService {
  private readonly dateFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: env.QUOTA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  getDailyLimit(userId: string): number {
    void userId;
    return env.FREE_DAILY_AI_LIMIT;
  }

  getUsageDate(now: Date): string {
    const parts = new Map(
      this.dateFormatter
        .formatToParts(now)
        .filter((part) => part.type === 'year' || part.type === 'month' || part.type === 'day')
        .map((part) => [part.type, part.value]),
    );

    const year = parts.get('year');
    const month = parts.get('month');
    const day = parts.get('day');
    if (!year || !month || !day) {
      throw new Error('Unable to calculate quota usage date');
    }

    return `${year}-${month}-${day}`;
  }
}
