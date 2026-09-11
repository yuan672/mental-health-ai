import { Injectable } from '@nestjs/common';

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

export const MOOD_TIME_ZONE = 'Asia/Shanghai' as const;
export type MoodHistoryDays = 7 | 30;

export type MoodDateRange = Readonly<{
  days: MoodHistoryDays;
  start: Date;
  end: Date;
  createdAtCeiling: Date;
  startDate: string;
  endDate: string;
}>;

function localDate(timestamp: Date): string {
  return new Date(timestamp.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

@Injectable()
export class MoodDateRangePolicy {
  create(now: Date, days: MoodHistoryDays): MoodDateRange {
    const shifted = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
    const currentLocalMidnightUtc = Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate(),
    );
    const start = new Date(currentLocalMidnightUtc - (days - 1) * 86_400_000 - SHANGHAI_OFFSET_MS);
    const end = new Date(currentLocalMidnightUtc + 86_400_000 - SHANGHAI_OFFSET_MS);

    return {
      days,
      start,
      end,
      createdAtCeiling: now,
      startDate: localDate(start),
      endDate: localDate(new Date(end.getTime() - 1)),
    };
  }

  localDate(timestamp: Date): string {
    return localDate(timestamp);
  }
}
