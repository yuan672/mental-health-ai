import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMoodEntry, deleteAllMoodEntries, listMoodEntries, updateMoodEntry } from './mood';

const ENTRY_ID = '61000000-0000-4000-8000-000000000001';
const CLIENT_REQUEST_ID = '61000000-0000-4000-8000-000000000002';
const CREATED_AT = '2026-09-11T08:00:00.000Z';

const entry = {
  id: ENTRY_ID,
  moodScore: 3,
  emotion: 'calm',
  note: '合成记录',
  stateRevision: 1,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};

describe('Mood/Profile API client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.cookie = 'mh_csrf=; Max-Age=0; Path=/';
  });

  it('passes the opaque cursor unchanged and strictly parses the server trend contract', async () => {
    const cursor = 'opaque+/=cursor';
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        success: true,
        data: {
          days: 30,
          timeZone: 'Asia/Shanghai',
          period: { startDate: '2026-08-13', endDate: '2026-09-11' },
          entries: [entry],
          dailyTrend: [{ localDate: '2026-09-11', entryCount: 1, averageMoodScore: 3 }],
          nextCursor: null,
        },
      }),
    );
    vi.stubGlobal('fetch', fetcher);

    await listMoodEntries(30, cursor);

    const url = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(url.searchParams.get('cursor')).toBe(cursor);
    expect(url.searchParams.get('days')).toBe('30');
    expect(url.searchParams.get('limit')).toBe('20');
  });

  it('rejects response fields outside the public schema', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          success: true,
          data: {
            days: 7,
            timeZone: 'Asia/Shanghai',
            period: { startDate: '2026-09-05', endDate: '2026-09-11' },
            entries: [{ ...entry, internalUserId: 'must-not-pass' }],
            dailyTrend: [],
            nextCursor: null,
          },
        }),
      ),
    );

    await expect(listMoodEntries(7)).rejects.toMatchObject({ code: 'INVALID_API_RESPONSE' });
  });

  it('sends CSRF for create, patch, and delete-all without client-side persistence', async () => {
    document.cookie = 'mh_csrf=synthetic-csrf; Path=/';
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/mood-entries' && init?.method === 'DELETE') {
        return Response.json({ success: true, data: { deleted: true, entryCount: 4 } });
      }
      if (init?.method === 'PATCH') {
        return Response.json({ success: true, data: { entry: { ...entry, stateRevision: 2 } } });
      }
      return Response.json({
        success: true,
        data: { entry, disposition: 'created' },
      });
    });
    vi.stubGlobal('fetch', fetcher);

    await createMoodEntry({
      clientRequestId: CLIENT_REQUEST_ID,
      moodScore: 3,
      emotion: 'calm',
      note: '合成记录',
    });
    await updateMoodEntry(ENTRY_ID, {
      expectedRevision: 1,
      moodScore: 4,
      emotion: null,
      note: null,
    });
    await deleteAllMoodEntries();

    for (const [, init] of fetcher.mock.calls) {
      expect(new Headers(init?.headers).get('x-csrf-token')).toBe('synthetic-csrf');
      expect(init?.credentials).toBe('include');
    }
  });
});
