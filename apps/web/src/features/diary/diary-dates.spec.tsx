import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { diaryToday, isWritableDiaryDay, previousDiaryDay, useDiaryToday } from './diary-dates';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe('diary calendar dates', () => {
  it('uses Shanghai midnight rather than the computer timezone', () => {
    expect(diaryToday(new Date('2026-09-14T15:59:59Z'))).toBe('2026-09-14');
    expect(diaryToday(new Date('2026-09-14T16:00:00Z'))).toBe('2026-09-15');
  });
  it('accepts real past days and leap days without allowing future or overflow dates', () => {
    expect(isWritableDiaryDay('2024-02-29', '2026-09-14')).toBe(true);
    expect(isWritableDiaryDay('2026-02-29', '2026-09-14')).toBe(false);
    expect(isWritableDiaryDay('2026-09-15', '2026-09-14')).toBe(false);
    expect(isWritableDiaryDay('', '2026-09-14')).toBe(false);
    expect(previousDiaryDay('2026-01-01')).toBe('2025-12-31');
  });
  it('updates today after midnight and releases its timer when unmounted', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-14T15:59:59Z'));
    const { result, unmount } = renderHook(useDiaryToday);
    expect(result.current).toBe('2026-09-14');
    act(() => vi.advanceTimersByTime(1100));
    expect(result.current).toBe('2026-09-15');
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('refreshes today when returning to a tab after midnight', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-14T10:00:00Z'));
    const { result, unmount } = renderHook(useDiaryToday);
    vi.setSystemTime(new Date('2026-09-15T02:00:00Z'));
    act(() => window.dispatchEvent(new Event('focus')));
    expect(result.current).toBe('2026-09-15');
    unmount();
  });
});
