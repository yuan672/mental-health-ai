import { useEffect, useState } from 'react';

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
export const diaryToday = (now = new Date()) => dayFormatter.format(now);
export function isWritableDiaryDay(day: string, today: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < '1900-01-01' || day > today) return false;
  const parsed = new Date(`${day}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
}
export function previousDiaryDay(day: string) {
  return new Date(new Date(`${day}T12:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10);
}

// Update the "today" shortcut at Shanghai midnight without changing the entry
// being edited. Its explicit date remains in the URL until the user chooses another.
export function useDiaryToday() {
  const [today, setToday] = useState(() => diaryToday());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const update = () => {
      clearTimeout(timer);
      const next = diaryToday();
      setToday(next);
      const midnight = new Date(`${next}T00:00:00+08:00`).getTime() + 86400000;
      timer = setTimeout(update, Math.max(1000, midnight - Date.now() + 50));
    };
    const onVisible = () => {
      if (!document.hidden) update();
    };
    update();
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  return today;
}
