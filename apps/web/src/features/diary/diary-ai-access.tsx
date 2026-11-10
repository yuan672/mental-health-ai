import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { DiaryNotebook } from '@mental-health/types';
import { diaryMemoryApi, type DiaryAccessPolicy } from '../../api/diary-memory';
import { diaryApi } from '../../api/diary';
import { ConfirmDialog } from '../../shared/confirm-dialog';
import { CatArt } from '../../shared/cat-art';
import './diary-ai-access.css';

const changedEvent = 'diary-ai-access-changed';
const label = (p: DiaryAccessPolicy | null) =>
  !p
    ? 'AI 日记读取权限'
    : p.mode === 'none'
      ? '日记参考已关闭'
      : p.mode === 'all'
        ? '可参考全部日记'
        : `可参考 ${p.notebookIds.length} 本日记`;
export function DiaryAiAccess({ disabled = false }: { disabled?: boolean }) {
  const [policy, setPolicy] = useState<DiaryAccessPolicy | null>(null);
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false);
  const [books, setBooks] = useState<DiaryNotebook[]>([]),
    [draft, setDraft] = useState<DiaryAccessPolicy | null>(null);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [unresolved, setUnresolved] = useState(false);
  const mounted = useRef(false),
    submitting = useRef(false),
    read = useRef<AbortController | null>(null);
  const applyPolicy = useCallback((next: DiaryAccessPolicy) => {
    setPolicy((current) => (current && current.revision > next.revision ? current : next));
  }, []);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    const refresh = () => {
      void diaryMemoryApi
        .policy(controller.signal)
        .then((r) => {
          if (!controller.signal.aborted) applyPolicy(r.data.policy);
        })
        .catch(() => {});
    };
    refresh();
    window.addEventListener(changedEvent, refresh);
    window.addEventListener('focus', refresh);
    return () => {
      mounted.current = false;
      controller.abort();
      read.current?.abort();
      window.removeEventListener(changedEvent, refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [applyPolicy]);
  const loadEditor = async () => {
    read.current?.abort();
    const controller = new AbortController();
    read.current = controller;
    setOpen(true);
    setLoading(true);
    setError('');
    setNotice('');
    setDraft(null);
    try {
      const [access, notebooks] = await Promise.all([
        diaryMemoryApi.policy(controller.signal),
        diaryApi.list(controller.signal),
      ]);
      if (controller.signal.aborted) return;
      applyPolicy(access.data.policy);
      setDraft(access.data.policy);
      setBooks(notebooks.data.books);
      setUnresolved(false);
    } catch {
      if (!controller.signal.aborted) setError('暂时无法读取权限，请重新读取。');
    } finally {
      if (mounted.current && !controller.signal.aborted) setLoading(false);
    }
  };
  const close = useCallback(() => {
    read.current?.abort();
    setOpen(false);
  }, []);
  const save = async () => {
    if (
      !draft ||
      submitting.current ||
      unresolved ||
      (draft.mode === 'selected' && !draft.notebookIds.length)
    )
      return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await diaryMemoryApi.save({
        mode: draft.mode,
        notebookIds: draft.mode === 'selected' ? draft.notebookIds : [],
        expectedRevision: draft.revision,
      });
      if (!mounted.current) return;
      applyPolicy(result.data.policy);
      setOpen(false);
      setNotice('AI 日记读取权限已保存');
      window.dispatchEvent(new Event(changedEvent));
    } catch (reason) {
      if (!mounted.current) return;
      setUnresolved(true);
      setError(
        (reason instanceof Error ? reason.message : '保存结果暂时无法确认') +
          '。请先重新读取当前设置，再决定是否修改。',
      );
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <div className="diary-ai-access">
      <button
        type="button"
        className="button button-secondary button-small"
        disabled={disabled}
        onClick={() => void loadEditor()}
        aria-label="AI 日记读取权限"
      >
        {label(policy)}
      </button>
      {notice && (
        <span role="status" className="muted">
          {notice}
        </span>
      )}
      <ConfirmDialog
        open={open}
        title="AI 可以参考哪些日记？"
        confirmLabel="保存设置"
        busy={busy}
        confirmDisabled={
          loading ||
          !draft ||
          unresolved ||
          (draft.mode === 'selected' && !draft.notebookIds.length)
        }
        onClose={close}
        onConfirm={() => void save()}
      >
        <p>
          开启后，近期已保存日记的文字、日期、心情和天气会随聊天发送给当前 AI
          服务商（当前为硅基流动），帮助它理解你的近况。
        </p>
        <p className="muted">每次只选最近 7 天的少量相关片段；草稿和照片不读取，无痕聊天不读取。</p>
        {loading && <p aria-busy="true">正在读取日记权限…</p>}
        {draft && (
          <fieldset className="diary-ai-modes" disabled={busy || unresolved}>
            <legend>读取范围</legend>
            {(
              [
                ['none', '完全不允许', '任何日记本都不向 AI 开放。'],
                ['selected', '仅允许指定日记本', '只参考你勾选的日记本，新建的不会自动加入。'],
                ['all', '允许所有日记本', '包含现有及以后新建的全部日记本。'],
              ] as const
            ).map(([mode, title, description]) => (
              <label className="diary-ai-mode" key={mode}>
                <input
                  type="radio"
                  name="diary-access-mode"
                  checked={draft.mode === mode}
                  onChange={() => setDraft({ ...draft, mode })}
                />
                <span>
                  <strong>{title}</strong>
                  <small>{description}</small>
                </span>
              </label>
            ))}
            {draft.mode === 'selected' && (
              <div className="diary-ai-books" role="group" aria-label="允许读取的日记本">
                {!books.length && <p>还没有日记本，可以先在书架创建一本。</p>}
                {books.map((book) => (
                  <label key={book.id} className="diary-ai-book">
                    <input
                      type="checkbox"
                      checked={draft.notebookIds.includes(book.id)}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          notebookIds: e.target.checked
                            ? [...draft.notebookIds, book.id]
                            : draft.notebookIds.filter((id) => id !== book.id),
                        })
                      }
                    />
                    <CatArt mood={book.cat} />
                    <span>{book.name}</span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>
        )}
        <p className="muted">
          关闭后，后续聊天不再检索日记。已发送的内容无法撤回，既有聊天回复也会保留；需要时可以新建对话或删除旧对话。
        </p>
        {error && (
          <div role="alert" className="inline-error">
            {error}
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => void loadEditor()}
            >
              重新读取权限
            </button>
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}

export function DiaryTurnReferences({ turnId }: { turnId: string | null }) {
  const [data, setData] = useState<
    Awaited<ReturnType<typeof diaryMemoryApi.references>>['data'] | null
  >(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(async () => {
      setData(null);
      setError(false);
      if (!turnId) return;
      try {
        const response = await diaryMemoryApi.references(turnId, controller.signal);
        if (!controller.signal.aborted) setData(response.data);
      } catch {
        if (!controller.signal.aborted) setError(true);
      }
    });
    return () => controller.abort();
  }, [turnId]);
  if (error) return <p className="muted">暂时无法读取本次日记参考记录。</p>;
  if (!data?.recorded) return null;
  return (
    <details className="diary-turn-references">
      <summary>本次提供给 AI 的日记（{data.entries.length} 篇）</summary>
      <p className="muted">
        这些片段曾作为背景提供，并不表示回复使用了每一篇。链接打开的是当前保存版本。
      </p>
      <ul>
        {data.entries.map((entry) => (
          <li key={entry.notebookId + entry.day}>
            {entry.day} ·{' '}
            {entry.available ? (
              <Link to={`/app/diary/${entry.notebookId}/${entry.day}`}>{entry.title}</Link>
            ) : (
              entry.title
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
