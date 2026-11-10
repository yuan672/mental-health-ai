import './mood-page.css';
import { CatArt, cats } from '../shared/cat-art';
import type {
  CreateMoodEntryRequest,
  MoodCat,
  MoodEmotion,
  MoodEntry,
  MoodHistoryResponse,
  UpdateMoodEntryRequest,
} from '@mental-health/types';
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiClientError } from '../api/client';
import {
  createMoodEntry,
  deleteAllMoodEntries,
  deleteMoodEntry,
  getMoodCreationStatus,
  getMoodEntry,
  listMoodEntries,
  updateMoodEntry,
} from '../api/mood';
import { ConfirmDialog } from '../shared/confirm-dialog';

const emotionOptions: ReadonlyArray<Readonly<{ value: MoodEmotion; label: string }>> = [
  { value: 'joyful', label: '愉快' },
  { value: 'calm', label: '平静' },
  { value: 'hopeful', label: '有希望' },
  { value: 'neutral', label: '一般' },
  { value: 'tired', label: '疲惫' },
  { value: 'stressed', label: '有压力' },
  { value: 'sad', label: '难过' },
  { value: 'angry', label: '生气' },
  { value: 'overwhelmed', label: '不堪重负' },
];

const emotionLabels = Object.fromEntries(
  emotionOptions.map(({ value, label }) => [value, label]),
) as Record<MoodEmotion, string>;

const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const shortDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric',
  day: 'numeric',
  timeZone: 'UTC',
});

type MoodDraft = Readonly<{
  catMood: MoodCat | null;
  moodScore: number | null;
  emotion: MoodEmotion | null;
  note: string;
}>;
type PendingCreate = Readonly<{
  request: CreateMoodEntryRequest;
  checkedAbsent: boolean;
}>;
type DeleteTarget = Readonly<{ kind: 'single'; entry: MoodEntry }> | Readonly<{ kind: 'all' }>;

const emptyDraft: MoodDraft = { catMood: null, moodScore: null, emotion: null, note: '' };

function codePointLength(value: string): number {
  return Array.from(value.trim()).length;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function isUnknownMutationResult(error: unknown): boolean {
  return (
    !(error instanceof ApiClientError) ||
    error.code === 'INVALID_API_RESPONSE' ||
    error.status >= 500
  );
}

function normalizedPayload(draft: MoodDraft) {
  const note = draft.note.trim();
  return {
    catMood: draft.catMood,
    moodScore: draft.moodScore,
    emotion: draft.emotion,
    note: note.length === 0 ? null : note,
  };
}

function calendarDates(startDate: string, endDate: string): string[] {
  const [startYear, startMonth, startDay] = startDate.split('-').map(Number);
  const [endYear, endMonth, endDay] = endDate.split('-').map(Number);
  const dates: string[] = [];
  const cursor = new Date(Date.UTC(startYear!, startMonth! - 1, startDay!));
  const end = Date.UTC(endYear!, endMonth! - 1, endDay!);
  while (cursor.getTime() <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

const scoreLabels = ['很低落', '有些低落', '还好', '不错', '很好'];
const catHints: Record<MoodCat, string> = {
  happy: '有一点开心，也值得被记住。',
  sad: '委屈的时候，也可以先照顾自己的感受。',
  angry: '愿意的话，可以写下让你生气的事。',
  surprised: '把这个意料之外的瞬间，记在这里。',
  shy: '不急，按自己的节奏表达就好。',
  sleepy: '有些累了，今天也可以慢一点。',
  hopeful: '把心里的小期待，留在这里。',
  relaxed: '这一刻的松弛，值得留一份记录。',
};
type MoodSelection = Pick<MoodEntry, 'catMood' | 'moodScore' | 'emotion'>;
function moodLabel(entry: MoodSelection) {
  return entry.catMood
    ? cats[entry.catMood].label
    : entry.moodScore
      ? scoreLabels[entry.moodScore - 1]
      : '已记录';
}
function MoodIdentity({ entry }: { entry: MoodSelection }) {
  return (
    <>
      {entry.catMood ? (
        <CatArt mood={entry.catMood} className="mood-mini" />
      ) : (
        <span className="legacy-mood-mark" aria-hidden="true">
          ♡
        </span>
      )}
      <strong>{moodLabel(entry)}</strong>
    </>
  );
}
const localDayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
function MoodFields({
  value,
  onChange,
  prefix,
  disabled = false,
}: {
  value: MoodDraft;
  onChange: (next: MoodDraft) => void;
  prefix: string;
  disabled?: boolean;
}) {
  const count = codePointLength(value.note);
  const [playing, setPlaying] = useState<MoodCat | null>(null);
  return (
    <div className="mood-fields">
      <p id={`${prefix}-help`} className="mood-help">
        哪只小猫像现在的你？选一个就好，也可以写下发生的小事。
      </p>
      <fieldset disabled={disabled} aria-describedby={`${prefix}-help`}>
        <legend className="sr-only">选择此刻的心情</legend>
        <div className="cat-mood-options">
          {(Object.keys(cats) as MoodCat[]).map((cat) => (
            <label
              key={cat}
              className={`cat-mood-option${playing === cat ? ' is-playing' : ''}`}
              data-cat={cat}
              onClick={() => {
                if (!disabled) setPlaying(cat);
              }}
              onAnimationEnd={() => setPlaying(null)}
            >
              <input
                type="radio"
                aria-label={cats[cat].label}
                name={`${prefix}-cat`}
                value={cat}
                checked={value.catMood === cat}
                onChange={() =>
                  onChange({ ...value, catMood: cat, moodScore: null, emotion: null })
                }
              />
              <span className="cat-mood-tile">
                <span className="cat-selection" aria-hidden="true">
                  已选择
                </span>
                <span className="cat-stage">
                  <CatArt mood={cat} />
                </span>
                <span className="cat-name">{cats[cat].label}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <p className="cat-mood-feedback" role="status">
        {value.catMood
          ? `${cats[value.catMood].label} · ${catHints[value.catMood]}`
          : value.moodScore
            ? '这是一份旧版记录。可以保留原来的感受，也可以重新选一只小猫。'
            : '心情不需要打分，选一个最贴近此刻的感受就好。'}
      </p>
      <label htmlFor={`${prefix}-note`} className="cat-mood-note-label">
        想说的话<span>选填</span>
      </label>
      <textarea
        id={`${prefix}-note`}
        rows={3}
        value={value.note}
        disabled={disabled}
        placeholder="发生了什么？或者只留下一句话，也很好。"
        aria-describedby={count ? `${prefix}-note-help` : undefined}
        aria-invalid={count > 500 || undefined}
        onChange={(event) => onChange({ ...value, note: event.target.value })}
      />
      {count ? (
        <p
          id={`${prefix}-note-help`}
          className={count > 500 ? 'inline-error character-count' : 'character-count'}
        >
          {count}/500{count > 500 ? '，稍微缩短一点再保存吧。' : ''}
        </p>
      ) : null}
    </div>
  );
}

export function MoodPage() {
  const [days, setDays] = useState<7 | 30>(7);
  const [history, setHistory] = useState<MoodHistoryResponse['data'] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<MoodDraft>(emptyDraft);
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);
  const [editing, setEditing] = useState<Readonly<{ entry: MoodEntry; draft: MoodDraft }> | null>(
    null,
  );
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [deleteCount, setDeleteCount] = useState<number | null>(null);
  const mountedRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const mutationGenerationRef = useRef(0);
  const loadControllerRef = useRef<AbortController | null>(null);
  const mutationControllerRef = useRef<AbortController | null>(null);
  const mutationBusyRef = useRef(false);

  const loadHistory = useCallback(
    async (selectedDays: 7 | 30, cursor: string | null, mode: 'replace' | 'append') => {
      const controller = new AbortController();
      const generation = ++loadGenerationRef.current;
      loadControllerRef.current?.abort();
      loadControllerRef.current = controller;
      if (mode === 'append') setLoadingMore(true);
      else setLoading(true);
      setError(null);
      try {
        const response = await listMoodEntries(selectedDays, cursor, controller.signal);
        if (
          !mountedRef.current ||
          controller.signal.aborted ||
          generation !== loadGenerationRef.current
        )
          return false;
        setHistory((previous) => {
          if (mode === 'replace' || !previous) return response.data;
          const known = new Set(previous.entries.map((entry) => entry.id));
          return {
            ...response.data,
            entries: [
              ...previous.entries,
              ...response.data.entries.filter((entry) => !known.has(entry.id)),
            ],
          };
        });
        if (mode === 'replace') setEditing(null);
        setStale(false);
        return true;
      } catch (reason) {
        if (
          !isAbortError(reason) &&
          mountedRef.current &&
          generation === loadGenerationRef.current
        ) {
          setStale(true);
          setError('暂时无法读取心情记录。当前显示内容可能已经变化，请刷新后再操作。');
        }
        return false;
      } finally {
        if (mountedRef.current && generation === loadGenerationRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
        if (loadControllerRef.current === controller) loadControllerRef.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    void Promise.resolve().then(() => loadHistory(days, null, 'replace'));
    return () => {
      mountedRef.current = false;
      loadGenerationRef.current += 1;
      mutationGenerationRef.current += 1;
      loadControllerRef.current?.abort();
      mutationControllerRef.current?.abort();
      mutationBusyRef.current = false;
    };
  }, [days, loadHistory]);

  const runMutation = useCallback(async <T,>(operation: (signal: AbortSignal) => Promise<T>) => {
    if (mutationBusyRef.current) return null;
    mutationBusyRef.current = true;
    const controller = new AbortController();
    const generation = ++mutationGenerationRef.current;
    mutationControllerRef.current?.abort();
    mutationControllerRef.current = controller;
    setMutationBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await operation(controller.signal);
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        generation !== mutationGenerationRef.current
      )
        return null;
      return result;
    } finally {
      if (mountedRef.current && generation === mutationGenerationRef.current) {
        setMutationBusy(false);
      }
      mutationBusyRef.current = false;
      if (mutationControllerRef.current === controller) mutationControllerRef.current = null;
    }
  }, []);

  const refresh = useCallback(() => loadHistory(days, null, 'replace'), [days, loadHistory]);

  const submitCreate = async (event: FormEvent) => {
    event.preventDefault();
    if (mutationBusyRef.current || pendingCreate || !draft.catMood) return;
    if (codePointLength(draft.note) > 500) {
      setError('心情备注不能超过 500 个 Unicode 字符。');
      return;
    }
    const request: CreateMoodEntryRequest = {
      clientRequestId: globalThis.crypto.randomUUID(),
      ...normalizedPayload(draft),
    };
    try {
      const response = await runMutation((signal) => createMoodEntry(request, signal));
      if (!response) return;
      setDraft(emptyDraft);
      setPendingCreate(null);
      setNotice(
        response.data.disposition === 'created'
          ? '心情记录已保存。'
          : '已找到同一请求当前仍存在的记录，并显示服务器上的最新内容。',
      );
      await refresh();
    } catch (reason) {
      if (isAbortError(reason) || !mountedRef.current) return;
      if (isUnknownMutationResult(reason)) {
        setPendingCreate({ request, checkedAbsent: false });
        setError(null);
      } else {
        setError(reason instanceof Error ? reason.message : '无法保存心情记录');
      }
    }
  };

  const checkUnknownCreate = async () => {
    if (!pendingCreate || mutationBusyRef.current) return;
    try {
      const response = await runMutation((signal) =>
        getMoodCreationStatus(pendingCreate.request.clientRequestId, signal),
      );
      if (!response) return;
      if (response.data.status === 'present') {
        setPendingCreate(null);
        setDraft(emptyDraft);
        setNotice('服务器当前存在这条记录；这只表示它现在可见。');
        await refresh();
      } else {
        setPendingCreate({ ...pendingCreate, checkedAbsent: true });
        setError(null);
      }
    } catch (reason) {
      if (!isAbortError(reason) && mountedRef.current) {
        setError('暂时无法核对创建结果，请稍后使用同一请求标识再次核对。');
      }
    }
  };

  const startFreshCreate = () => {
    setPendingCreate(null);
    setError(null);
    setNotice('已放弃继续核对旧请求。下一次提交会使用新的请求标识，但不会取消可能迟到的旧请求。');
  };

  const reconcileEntry = useCallback(
    async (entryId: string, message: string) => {
      try {
        const response = await runMutation((signal) => getMoodEntry(entryId, signal));
        if (!response) return false;
        if (!mountedRef.current) return false;
        const refreshed = await refresh();
        if (!refreshed) {
          if (mountedRef.current) {
            setStale(true);
            setError('已读取服务器记录，但无法同步完整列表与趋势。重新加载成功前不能继续修改。');
          }
          return false;
        }
        if (!mountedRef.current) return false;
        setNotice(message);
        return true;
      } catch (reason) {
        if (reason instanceof ApiClientError && reason.status === 404) {
          if (!mountedRef.current) return false;
          const refreshed = await refresh();
          if (!refreshed) {
            if (mountedRef.current) {
              setStale(true);
              setError('服务器当前已看不到这条记录，但完整列表刷新失败。请稍后重新加载。');
            }
            return false;
          }
          if (!mountedRef.current) return false;
          setNotice('服务器当前已看不到这条记录；无法判断是哪一次请求造成的结果。');
          return true;
        }
        if (!isAbortError(reason) && mountedRef.current) {
          setStale(true);
          setError('无法读取服务器最新记录。刷新成功前不能继续使用旧修订提交。');
        }
        return false;
      }
    },
    [refresh, runMutation],
  );

  const reloadStaleHistory = async () => {
    const discardedEdit = Boolean(editing);
    const refreshed = await refresh();
    if (refreshed && discardedEdit && mountedRef.current) {
      setNotice('已读取服务器最新记录。原编辑草稿未提交，请重新打开记录后再决定是否修改。');
    }
  };

  const submitEdit = async (event: FormEvent) => {
    event.preventDefault();
    if (
      !editing ||
      mutationBusyRef.current ||
      stale ||
      (!editing.draft.catMood && !editing.draft.moodScore)
    )
      return;
    if (codePointLength(editing.draft.note) > 500) {
      setError('心情备注不能超过 500 个 Unicode 字符。');
      return;
    }
    const input: UpdateMoodEntryRequest = {
      expectedRevision: editing.entry.stateRevision,
      ...normalizedPayload(editing.draft),
    };
    try {
      const response = await runMutation((signal) =>
        updateMoodEntry(editing.entry.id, input, signal),
      );
      if (!response) return;
      setEditing(null);
      setNotice('心情记录已更新。');
      await refresh();
    } catch (reason) {
      if (isAbortError(reason) || !mountedRef.current) return;
      if (reason instanceof ApiClientError && reason.status === 409) {
        await reconcileEntry(
          editing.entry.id,
          '记录已经变化，已读取服务器当前内容。请重新决定是否修改。',
        );
      } else if (reason instanceof ApiClientError && reason.status === 404) {
        setEditing(null);
        setNotice('服务器当前已看不到这条记录。');
        await refresh();
      } else if (isUnknownMutationResult(reason)) {
        await reconcileEntry(
          editing.entry.id,
          '修改结果无法确认，已读取服务器当前内容。请核对后再进行新的操作。',
        );
      } else {
        setError(reason instanceof Error ? reason.message : '无法更新心情记录');
      }
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget || mutationBusyRef.current || stale) return;
    const target = deleteTarget;
    try {
      if (target.kind === 'all') {
        const response = await runMutation((signal) => deleteAllMoodEntries(signal));
        if (!response) return;
        setDeleteTarget(null);
        setDeleteCount(response.data.entryCount);
        setEditing(null);
        setNotice(`服务器实际删除了 ${response.data.entryCount} 条心情记录。`);
        await refresh();
        return;
      }
      const response = await runMutation((signal) =>
        deleteMoodEntry(target.entry.id, target.entry.stateRevision, signal),
      );
      if (!response) return;
      setDeleteTarget(null);
      setEditing(null);
      setNotice('心情记录已删除。');
      await refresh();
    } catch (reason) {
      if (isAbortError(reason) || !mountedRef.current) return;
      setDeleteTarget(null);
      if (target.kind === 'single' && reason instanceof ApiClientError && reason.status === 409) {
        await reconcileEntry(
          target.entry.id,
          '记录已经变化，已读取服务器当前内容。请重新决定是否删除。',
        );
      } else if (
        target.kind === 'single' &&
        reason instanceof ApiClientError &&
        reason.status === 404
      ) {
        setNotice('服务器当前已看不到这条记录。');
        await refresh();
      } else if (target.kind === 'single' && isUnknownMutationResult(reason)) {
        await reconcileEntry(
          target.entry.id,
          '删除结果无法确认，已读取服务器当前状态。不会自动重复删除。',
        );
      } else if (target.kind === 'all' && isUnknownMutationResult(reason)) {
        const refreshed = await refresh();
        if (refreshed) {
          setNotice('删除全部的结果无法确认，已重新读取当前记录。不会自动重复删除。');
        } else {
          setStale(true);
          setError('删除全部的结果无法确认，重新读取也失败。请稍后刷新，不要直接重复删除。');
        }
      } else {
        setError(reason instanceof Error ? reason.message : '无法删除心情记录');
      }
    }
  };

  const trendRows = useMemo(() => {
    if (!history) return [];
    const trend = new Map(history.dailyTrend.map((item) => [item.localDate, item]));
    return calendarDates(history.period.startDate, history.period.endDate).map((date) => {
      const value = trend.get(date) ?? null;
      const latest =
        value?.latestEntry ??
        history.entries.find(
          (entry) => localDayFormatter.format(new Date(entry.createdAt)) === date,
        ) ??
        null;
      return { date, value, latest };
    });
  }, [history]);

  return (
    <main className="mood-page cozy-mood-page" aria-labelledby="mood-title">
      <header className="mood-header">
        <p className="eyebrow">情绪日记</p>
        <h1 id="mood-title">心情记录</h1>
        <p>接纳自己当下的感受，无论是晴朗还是阴雨。</p>
      </header>

      {error ? (
        <div className="mood-feedback" role="alert">
          <p>{error}</p>
          {stale ? (
            <button
              type="button"
              className="button button-secondary"
              disabled={loading}
              onClick={() => void reloadStaleHistory()}
            >
              重新加载
            </button>
          ) : null}
        </div>
      ) : null}
      {pendingCreate ? (
        <div className="mood-feedback" role="status" aria-live="polite">
          <p>
            {pendingCreate.checkedAbsent
              ? '服务器当前未看到这条记录；这不证明原请求失败、取消，也不保证它以后不会提交。'
              : '本次创建结果暂时无法确认。不会自动重新提交原创建请求。'}
          </p>
          <div className="mood-inline-actions">
            <button
              type="button"
              className="button button-secondary"
              disabled={mutationBusy || loading}
              onClick={() => void checkUnknownCreate()}
            >
              核对创建结果
            </button>
            {pendingCreate.checkedAbsent ? (
              <button type="button" className="button button-quiet" onClick={startFreshCreate}>
                放弃核对并开始新的记录
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      {notice ? (
        <p className="inline-success" role="status" aria-live="polite">
          {notice}
        </p>
      ) : null}

      <section className="mood-card mood-compose" aria-labelledby="check-in-title">
        <h2 id="check-in-title">记录此刻的心情</h2>
        <form onSubmit={(event) => void submitCreate(event)}>
          <MoodFields
            value={draft}
            onChange={setDraft}
            prefix="create-mood"
            disabled={mutationBusy || Boolean(pendingCreate)}
          />
          <div className="cat-mood-actions">
            <button
              type="submit"
              className="button"
              disabled={
                mutationBusy ||
                Boolean(pendingCreate) ||
                !draft.catMood ||
                codePointLength(draft.note) > 500
              }
            >
              {mutationBusy ? '正在提交…' : '记下这份心情'}
            </button>
            <p>鼠标停留或轻点小猫，看看它的小动作。</p>
          </div>
        </form>
      </section>

      <section className="mood-section" aria-labelledby="trend-title">
        <div className="mood-section-heading">
          <div>
            <h2 id="trend-title">心情轨迹</h2>
          </div>
          <div className="range-switch" aria-label="心情轨迹范围">
            {([7, 30] as const).map((range) => (
              <button
                key={range}
                type="button"
                className={`button button-secondary${days === range ? ' active' : ''}`}
                aria-pressed={days === range}
                disabled={mutationBusy || loading}
                onClick={() => {
                  if (days === range) return;
                  setDays(range);
                  setHistory(null);
                  setEditing(null);
                  setError(null);
                  setNotice(null);
                }}
              >
                {range} 天
              </button>
            ))}
          </div>
        </div>
        <p className="mood-section-help">看看这些天的心情，每天展示最近一次记录。</p>
        {loading && !history ? <p aria-busy="true">正在加载心情记录…</p> : null}
        {!loading && history && history.entries.length === 0 ? (
          <p className="mood-empty">这段时间还没有心情记录。</p>
        ) : null}
        {history ? (
          <ul className="mood-trend-list" aria-label={`${days} 天每日趋势`}>
            {trendRows.map(({ date, value, latest }) => (
              <li key={date}>
                <time dateTime={date}>
                  {shortDateFormatter.format(new Date(`${date}T00:00:00Z`))}
                </time>
                {latest ? (
                  <MoodIdentity entry={latest} />
                ) : (
                  <span className="cat-day-empty">{value ? '已记录' : '未记录'}</span>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="mood-section" aria-labelledby="history-title">
        <div className="mood-section-heading">
          <h2 id="history-title">历史明细</h2>
          <button
            type="button"
            className="button button-quiet button-small mood-delete-all"
            disabled={mutationBusy || loading || stale || !history}
            onClick={() => setDeleteTarget({ kind: 'all' })}
          >
            清空记录
          </button>
        </div>
        {deleteCount !== null ? (
          <p className="muted">最近一次实际删除：{deleteCount} 条。</p>
        ) : null}
        <ul className="mood-entry-list">
          {history?.entries.map((entry) => (
            <li key={entry.id} className="mood-entry">
              {editing?.entry.id === entry.id ? (
                <form onSubmit={(event) => void submitEdit(event)}>
                  <h3>编辑记录</h3>
                  <MoodFields
                    value={editing.draft}
                    onChange={(next) => setEditing({ ...editing, draft: next })}
                    prefix={`edit-${entry.id}`}
                    disabled={mutationBusy || loading || stale}
                  />
                  <div className="mood-inline-actions">
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={mutationBusy}
                      onClick={() => setEditing(null)}
                    >
                      取消编辑
                    </button>
                    <button
                      type="submit"
                      className="button"
                      disabled={
                        mutationBusy ||
                        loading ||
                        stale ||
                        (!editing.draft.catMood && !editing.draft.moodScore) ||
                        codePointLength(editing.draft.note) > 500
                      }
                    >
                      保存修改
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="mood-entry-heading">
                    <div>
                      <MoodIdentity entry={entry} />
                      {!entry.catMood ? (
                        <span className="legacy-mood-label">
                          旧记录{entry.emotion ? ` · ${emotionLabels[entry.emotion]}` : ''}
                        </span>
                      ) : null}
                    </div>
                    <time
                      dateTime={entry.createdAt}
                      title={dateTimeFormatter.format(new Date(entry.createdAt))}
                    >
                      {localDayFormatter.format(new Date(entry.createdAt)) ===
                      history?.period.endDate
                        ? '今天'
                        : localDayFormatter
                            .format(new Date(entry.createdAt))
                            .slice(5)
                            .replace('-', '/')}
                    </time>
                  </div>
                  {entry.note ? <p className="mood-note">{entry.note}</p> : null}
                  <div className="mood-inline-actions">
                    <button
                      type="button"
                      className="button button-secondary button-small"
                      disabled={mutationBusy || loading || stale}
                      onClick={() =>
                        setEditing({
                          entry,
                          draft: {
                            catMood: entry.catMood ?? null,
                            moodScore: entry.moodScore,
                            emotion: entry.emotion,
                            note: entry.note ?? '',
                          },
                        })
                      }
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="button button-quiet button-small mood-delete-button"
                      disabled={mutationBusy || loading || stale}
                      onClick={() => setDeleteTarget({ kind: 'single', entry })}
                    >
                      删除
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
        {history?.nextCursor ? (
          <button
            type="button"
            className="button button-secondary mood-load-more"
            disabled={loading || loadingMore || stale}
            onClick={() => void loadHistory(days, history.nextCursor, 'append')}
          >
            {loadingMore ? '正在加载…' : '加载更多'}
          </button>
        ) : null}
      </section>

      <footer className="mood-page-footer">
        <p>♡ 每一种感受，都有被看见的位置。</p>
        <small>这里不是医疗诊断、持续监测或紧急响应渠道。</small>
      </footer>

      <ConfirmDialog
        open={deleteTarget !== null}
        title={deleteTarget?.kind === 'all' ? '删除全部心情记录？' : '删除这条心情记录？'}
        confirmLabel={deleteTarget?.kind === 'all' ? '删除全部' : '删除记录'}
        destructive
        busy={mutationBusy}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
      >
        {deleteTarget?.kind === 'all' ? (
          <>
            <p>这会删除账号下的全部心情记录，包括当前 7 天或 30 天窗口之外的记录。</p>
            <p>删除后无法撤销；独立 Audit 和备份按各自尚待确认的政策处理。</p>
          </>
        ) : (
          <p>这条心情记录将被永久删除，删除后无法撤销。</p>
        )}
      </ConfirmDialog>
    </main>
  );
}
