import { safeOperationalPath } from '../src/common/http/safe-request-path';
import {
  diaryContentSchema,
  pageWriteSchema,
  settingsUpdateSchema,
} from '../src/diary/diary.schemas';

describe('Diary boundaries', () => {
  it('keeps personal notebook dates and IDs out of operational paths', () => {
    expect(
      safeOperationalPath('/diary/notebooks/private-id/entries/2026-09-14/photos?secret=hidden'),
    ).toBe('/diary/notebooks/:bookId/entries/:day/photos');
    expect(safeOperationalPath('/diary/notebooks/private-id/photos/private-photo')).toBe(
      '/diary/notebooks/:bookId/photos/:photoId',
    );
  });
  it('counts Unicode code points and allows an incomplete draft without allowing it to publish', () => {
    const draft = {
      title: '猫'.repeat(80),
      body: '🙂'.repeat(10000),
      mood: null,
      weather: null,
      photoIds: [],
    };
    expect(diaryContentSchema.safeParse(draft).success).toBe(true);
    expect(diaryContentSchema.safeParse({ ...draft, body: draft.body + '🙂' }).success).toBe(false);
    expect(
      pageWriteSchema.safeParse({ expectedRevision: 0, content: draft, publish: false }).success,
    ).toBe(true);
    expect(
      pageWriteSchema.safeParse({ expectedRevision: 0, content: draft, publish: true }).success,
    ).toBe(false);
  });
  it('rejects settings ownership injection and unsupported reading sizes', () => {
    const settings = {
      displayName: '',
      cat: 'happy',
      readingSize: 18,
      bookmarks: [],
      expectedRevision: 0,
    };
    expect(settingsUpdateSchema.safeParse({ ...settings, userId: 'foreign' }).success).toBe(false);
    expect(settingsUpdateSchema.safeParse({ ...settings, readingSize: 100 }).success).toBe(false);
    expect(
      settingsUpdateSchema.safeParse({ ...settings, bookmarks: ['duplicate', 'duplicate'] })
        .success,
    ).toBe(false);
  });
});
