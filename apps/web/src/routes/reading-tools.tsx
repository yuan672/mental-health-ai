import { useState } from 'react';
import { usePersonalSettings } from '../app/personal-settings';
export function ReadingTools({ articleKey }: { articleKey: string }) {
  const settings = usePersonalSettings();
  const [error, setError] = useState('');
  if (!settings) return null;
  const reload = () => {
    setError('');
    void settings.reload();
  };
  const feedback =
    error || settings.error ? (
      <span role="alert" className="inline-error">
        {settings.error || error}
        <button type="button" className="text-button" disabled={settings.busy} onClick={reload}>
          重新读取
        </button>
      </span>
    ) : null;
  if (!settings.data) return feedback;
  const { data, busy } = settings,
    bookmarked = data.bookmarks.includes(articleKey);
  const run = (change: Parameters<typeof settings.update>[0]) => {
    setError('');
    void settings
      .update(change)
      .catch((e) => setError(e instanceof Error ? e.message : '暂时无法保存设置'));
  };
  return (
    <div className="reading-tools">
      <div role="group" aria-label="阅读字号">
        {([16, 18, 20] as const).map((size) => (
          <button
            className="button button-secondary button-small"
            key={size}
            type="button"
            aria-pressed={size === data.readingSize}
            disabled={busy || Boolean(settings.error)}
            onClick={() => run({ readingSize: size })}
          >
            {size === 16 ? '小' : size === 18 ? '中' : '大'}
          </button>
        ))}
      </div>
      <button
        className="button button-secondary"
        type="button"
        aria-pressed={bookmarked}
        disabled={busy || Boolean(settings.error) || (!bookmarked && data.bookmarks.length >= 100)}
        onClick={() =>
          run({
            bookmarks: bookmarked
              ? data.bookmarks.filter((key) => key !== articleKey)
              : [...data.bookmarks, articleKey],
          })
        }
      >
        {bookmarked ? '已收藏' : '收藏这篇文章'}
      </button>
      {feedback}
    </div>
  );
}
