import { randomUUID } from 'node:crypto';
import type {
  CreateMoodEntryResponse,
  DeleteMoodEntryResponse,
  DeleteMoodHistoryResponse,
  MoodCreationStatusResponse,
  MoodEntry,
  MoodEntryResponse,
  MoodHistoryResponse,
  NormalizedCreateMoodEntryRequest,
  NormalizedUpdateMoodEntryRequest,
} from '@mental-health/types';
import { Injectable } from '@nestjs/common';
import {
  DatabaseError,
  MoodStateChangedError,
  NotFoundError,
  ValidationError,
} from '../common/errors';
import { decodeOpaqueCursor, encodeOpaqueCursor } from '../common/pagination/opaque-cursor';
import { MoodDateRangePolicy, MOOD_TIME_ZONE, type MoodDateRange } from './mood-date-range.policy';
import { MoodRepository, type MoodEntryRecord } from './mood.repository';
import { moodHistoryCursorSchema, type MoodHistoryQuery } from './mood.schemas';

function toPublicEntry(record: MoodEntryRecord): MoodEntry {
  return {
    id: record.id,
    moodScore: record.moodScore,
    emotion: record.emotion,
    note: record.note,
    stateRevision: record.stateRevision,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

@Injectable()
export class MoodService {
  constructor(
    private readonly dateRangePolicy: MoodDateRangePolicy,
    private readonly repository: MoodRepository,
  ) {}

  async create(
    userId: string,
    input: NormalizedCreateMoodEntryRequest,
    now = new Date(),
  ): Promise<CreateMoodEntryResponse> {
    try {
      const result = await this.repository.create({
        id: randomUUID(),
        userId,
        clientRequestId: input.clientRequestId,
        moodScore: input.moodScore,
        emotion: input.emotion ?? null,
        note: input.note ?? null,
        stateRevision: 1,
        createdAt: now,
        updatedAt: now,
      });
      return {
        success: true,
        data: { entry: toPublicEntry(result.entry), disposition: result.disposition },
      };
    } catch {
      throw new DatabaseError();
    }
  }

  async creationStatus(
    userId: string,
    clientRequestId: string,
  ): Promise<MoodCreationStatusResponse> {
    let entry: MoodEntryRecord | null;
    try {
      entry = await this.repository.findByClientRequestId(userId, clientRequestId);
    } catch {
      throw new DatabaseError();
    }
    return entry
      ? { success: true, data: { status: 'present', entry: toPublicEntry(entry) } }
      : { success: true, data: { status: 'absent' } };
  }

  async get(userId: string, id: string): Promise<MoodEntryResponse> {
    let entry: MoodEntryRecord | null;
    try {
      entry = await this.repository.findOwnedById(userId, id);
    } catch {
      throw new DatabaseError();
    }
    if (!entry) throw new NotFoundError('心情记录不存在');
    return { success: true, data: { entry: toPublicEntry(entry) } };
  }

  async list(
    userId: string,
    query: MoodHistoryQuery,
    now = new Date(),
  ): Promise<MoodHistoryResponse> {
    const cursor = decodeOpaqueCursor(query.cursor, moodHistoryCursorSchema);
    if (cursor && cursor.days !== query.days) {
      throw new ValidationError('分页游标与查询范围不一致');
    }

    const range: MoodDateRange = cursor
      ? {
          days: cursor.days,
          start: new Date(cursor.rangeStart),
          end: new Date(cursor.rangeEnd),
          createdAtCeiling: new Date(cursor.createdAtCeiling),
          startDate: this.dateRangePolicy.localDate(new Date(cursor.rangeStart)),
          endDate: this.dateRangePolicy.localDate(
            new Date(new Date(cursor.rangeEnd).getTime() - 1),
          ),
        }
      : this.dateRangePolicy.create(now, query.days);
    if (
      range.start.getTime() >= range.end.getTime() ||
      range.createdAtCeiling.getTime() < range.start.getTime() ||
      range.createdAtCeiling.getTime() >= range.end.getTime() ||
      (cursor &&
        (new Date(cursor.createdAt).getTime() < range.start.getTime() ||
          new Date(cursor.createdAt).getTime() > range.createdAtCeiling.getTime()))
    ) {
      throw new ValidationError('分页游标无效');
    }

    let result: Awaited<ReturnType<MoodRepository['listWithTrend']>>;
    try {
      result = await this.repository.listWithTrend({
        userId,
        range,
        cursor: cursor ? { createdAt: new Date(cursor.createdAt), id: cursor.id } : null,
        limit: query.limit + 1,
      });
    } catch {
      throw new DatabaseError();
    }

    const hasNextPage = result.entries.length > query.limit;
    const page = result.entries.slice(0, query.limit);
    const last = page.at(-1);
    return {
      success: true,
      data: {
        days: query.days,
        timeZone: MOOD_TIME_ZONE,
        period: { startDate: range.startDate, endDate: range.endDate },
        entries: page.map(toPublicEntry),
        dailyTrend: result.dailyTrend,
        nextCursor:
          hasNextPage && last
            ? encodeOpaqueCursor({
                kind: 'mood-history',
                version: 1,
                days: query.days,
                rangeStart: range.start.toISOString(),
                rangeEnd: range.end.toISOString(),
                createdAtCeiling: range.createdAtCeiling.toISOString(),
                createdAt: last.createdAt.toISOString(),
                id: last.id,
              })
            : null,
      },
    };
  }

  async update(
    userId: string,
    id: string,
    input: NormalizedUpdateMoodEntryRequest,
    now = new Date(),
  ): Promise<MoodEntryResponse> {
    let result: Awaited<ReturnType<MoodRepository['update']>>;
    try {
      result = await this.repository.update({
        userId,
        id,
        expectedRevision: input.expectedRevision,
        moodScore: input.moodScore,
        emotion: input.emotion,
        note: input.note,
        now,
      });
    } catch {
      throw new DatabaseError();
    }
    if (result.kind === 'not_found') throw new NotFoundError('心情记录不存在');
    if (result.kind === 'state_changed') throw new MoodStateChangedError();
    return { success: true, data: { entry: toPublicEntry(result.entry) } };
  }

  async delete(
    userId: string,
    id: string,
    expectedRevision: number,
    now = new Date(),
  ): Promise<DeleteMoodEntryResponse> {
    let result: Awaited<ReturnType<MoodRepository['delete']>>;
    try {
      result = await this.repository.delete({ userId, id, expectedRevision, now });
    } catch {
      throw new DatabaseError();
    }
    if (result === 'not_found') throw new NotFoundError('心情记录不存在');
    if (result === 'state_changed') throw new MoodStateChangedError();
    return { success: true, data: { deleted: true } };
  }

  async deleteAll(userId: string, now = new Date()): Promise<DeleteMoodHistoryResponse> {
    let entryCount: number;
    try {
      entryCount = await this.repository.deleteAll(userId, now);
    } catch {
      throw new DatabaseError();
    }
    return { success: true, data: { deleted: true, entryCount } };
  }
}
