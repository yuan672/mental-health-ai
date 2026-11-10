import {
  DIARY_CAT_VALUES,
  DIARY_WEATHER_VALUES,
  type DiaryCat,
  type DiaryContent,
  type DiaryNotebook,
  type DiaryPage as Page,
  type DiaryPhoto,
  type DiaryEntrySummary,
} from '@mental-health/types';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { Link, Navigate, useBlocker, useNavigate, useParams } from 'react-router';
import { diaryApi } from '../api/diary';
import { CatArt, cats, weathers, WeatherArt } from '../shared/cat-art';
import { CozyIcon } from '../shared/cozy-icon';
import { ConfirmDialog } from '../shared/confirm-dialog';
import { DiaryAiAccess } from '../features/diary/diary-ai-access';
import {
  BOOK_CLOSE_MS,
  BOOK_OPEN_MS,
  captureNotebookReturn,
  createBookModel,
  disposeNotebookReturn,
  returnNotebookToShelf,
  runBookTimeline,
  skipBookMotion,
  waitForRouteCat,
  type NotebookReturn,
} from '../features/diary/book-motion';
import '../features/diary/book-motion.css';
import { capturePaperTurn, playPaperTurn } from '../features/diary/paper-turn';
import '../features/diary/paper-turn.css';
import {
  diaryToday,
  isWritableDiaryDay,
  previousDiaryDay,
  useDiaryToday,
} from '../features/diary/diary-dates';

const blank = (): DiaryContent => ({
  title: '',
  body: '',
  mood: null,
  weather: null,
  photoIds: [],
});
const message = (e: unknown) => (e instanceof Error ? e.message : '暂时无法连接，请稍后重试');
const count = (s: string) => Array.from(s).length;
type DiaryTurn = {
  day: string;
  book: DiaryNotebook;
  page: Page;
  entries: DiaryEntrySummary[];
  before: string | null;
  surface: ReturnType<typeof capturePaperTurn>;
};

function CatPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: DiaryCat | null;
  onChange: (cat: DiaryCat) => void;
  disabled?: boolean;
}) {
  return (
    <div className="cat-picker" role="group" aria-label="选择小猫心情">
      {DIARY_CAT_VALUES.map((cat) => (
        <button
          key={cat}
          type="button"
          className={`cat-choice ${value === cat ? 'chosen' : ''}`}
          aria-pressed={value === cat}
          disabled={disabled}
          onClick={() => onChange(cat)}
        >
          <CatArt mood={cat} />
          <span>{cats[cat].label}</span>
        </button>
      ))}
    </div>
  );
}

function NotebookShelf({
  returning,
  onReturned,
}: {
  returning: NotebookReturn | null;
  onReturned: () => void;
}) {
  const navigate = useNavigate();
  const [books, setBooks] = useState<DiaryNotebook[]>(returning?.books ?? []),
    [loading, setLoading] = useState(!returning),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<{ id: string; revision?: number } | null>(null),
    [name, setName] = useState(''),
    [cat, setCat] = useState<DiaryCat>('relaxed'),
    [remove, setRemove] = useState<DiaryNotebook | null>(null);
  const shelfRef = useRef<HTMLElement>(null),
    restored = useRef(Boolean(returning)),
    mounted = useRef(false),
    readGeneration = useRef(0);
  const load = useCallback(async () => {
    const generation = ++readGeneration.current;
    setLoading(true);
    try {
      const r = await diaryApi.list();
      if (mounted.current && generation === readGeneration.current) {
        setBooks(r.data.books);
        setError('');
      }
    } catch (e) {
      if (mounted.current && generation === readGeneration.current) setError(message(e));
    } finally {
      if (mounted.current && generation === readGeneration.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    if (!restored.current) void Promise.resolve().then(load);
    return () => {
      mounted.current = false;
      readGeneration.current += 1;
    };
  }, [load]);
  useLayoutEffect(() => {
    if (!returning || !shelfRef.current) return;
    const controller = new AbortController();
    void returnNotebookToShelf(shelfRef.current, returning, controller.signal).then((complete) => {
      if (complete && !controller.signal.aborted) onReturned();
    });
    return () => controller.abort();
  }, [returning, onReturned]);
  async function saveBook() {
    if (!editor) return;
    setBusy(true);
    setError('');
    try {
      const input = { name: name.trim(), cat };
      const r = editor.revision
        ? await diaryApi.rename(editor.id, { ...input, expectedRevision: editor.revision })
        : await diaryApi.create({ id: editor.id, ...input });
      setEditor(null);
      if (editor.revision) await load();
      else navigate(`/app/diary/${r.data.book.id}`);
    } catch (e) {
      setError(`${message(e)}。可关闭窗口并重新读取书架核对；新建重试不会重复创建。`);
    } finally {
      setBusy(false);
    }
  }
  async function deleteBook() {
    if (!remove) return;
    setBusy(true);
    setError('');
    try {
      await diaryApi.remove(remove.id, remove.revision);
      setRemove(null);
      await load();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const edit = (book?: DiaryNotebook) => {
    setError('');
    setName(book?.name ?? '');
    setCat(book?.cat ?? 'relaxed');
    setEditor({
      id: book?.id ?? crypto.randomUUID(),
      ...(book ? { revision: book.revision } : {}),
    });
  };
  return (
    <main ref={shelfRef} className="diary-page shelf-page">
      <header className="cozy-page-heading">
        <div>
          <p className="eyebrow">给自己的日记</p>
          <h1>我的小书架</h1>
          <p>一段日子，一本日记。想写的时候，就打开它。</p>
        </div>
        <button className="button" onClick={() => edit()}>
          <CozyIcon name="plus" /> 新建日记本
        </button>
      </header>
      <DiaryAiAccess disabled={busy} />
      {error && !editor && !remove ? (
        <div className="inline-error" role="alert">
          {error}{' '}
          <button className="text-button" onClick={() => void load()}>
            重新读取书架
          </button>
        </div>
      ) : null}
      {loading ? (
        <p aria-busy="true">小猫正在整理书架…</p>
      ) : (
        <section className="bookshelf" aria-label="我的日记本">
          <div className="shelf-intro">
            <div>
              <h2>
                {books.length ? `${books.length} 本日记 · 都在这里` : '给今天，留一个小小的位置。'}
              </h2>
              <p>{books.length ? '慢慢写，也慢慢翻。' : '创建第一本日记，写下自己的故事。'}</p>
            </div>
            <CatArt mood="sleepy" />
          </div>
          <div className="shelf-books">
            {books.map((book) => (
              <article className="shelf-item" key={book.id}>
                <Link
                  className="notebook-cover"
                  to={`/app/diary/${book.id}`}
                  data-notebook-id={book.id}
                  aria-label={`打开${book.name}`}
                >
                  <span className="cover-kicker">给自己的日记</span>
                  <h2>{book.name}</h2>
                  <CatArt mood={book.cat} />
                  <span>一点心情 · 一件小事</span>
                  <i className="book-ribbon" />
                </Link>
                <p className="muted">最近整理 {book.updatedAt.slice(0, 10)}</p>
                <div className="shelf-item-actions">
                  <button className="text-button" onClick={() => edit(book)}>
                    改个名字
                  </button>
                  <button
                    className="text-button danger-text"
                    onClick={() => {
                      setError('');
                      setRemove(book);
                    }}
                  >
                    删除
                  </button>
                </div>
              </article>
            ))}
            <button className="new-notebook" onClick={() => edit()}>
              <CozyIcon name="plus" />
              <strong>再放一本新日记</strong>
              <span>
                给下一段日子
                <br />
                留一点空白
              </span>
            </button>
          </div>
        </section>
      )}
      <ConfirmDialog
        open={Boolean(editor)}
        title={editor?.revision ? '给这本日记换个名字' : '新的一本，叫什么呢？'}
        confirmLabel={editor?.revision ? '保存名字' : '放到书架上'}
        confirmDisabled={!name.trim() || count(name.trim()) > 24}
        busy={busy}
        onClose={() => {
          setEditor(null);
          setError('');
        }}
        onConfirm={() => void saveBook()}
      >
        <label htmlFor="notebook-name">日记本名字</label>
        <input
          id="notebook-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例如：我在学校的日子"
        />
        <p className="muted">{count(name.trim())}/24 字 · 选一只封面小猫</p>
        <CatPicker value={cat} onChange={setCat} disabled={busy} />
        {error ? (
          <p role="alert" className="inline-error">
            {error}
          </p>
        ) : null}
      </ConfirmDialog>
      <ConfirmDialog
        open={Boolean(remove)}
        title="删除这本日记？"
        confirmLabel="删除日记本"
        destructive
        busy={busy}
        onClose={() => {
          setRemove(null);
          setError('');
        }}
        onConfirm={() => void deleteBook()}
      >
        <p>「{remove?.name}」中的日记、草稿和照片都会被删除，无法撤销。</p>
        {error ? (
          <p role="alert" className="inline-error">
            {error}
          </p>
        ) : null}
      </ConfirmDialog>
    </main>
  );
}

function Photo({
  bookId,
  photo,
  onOpen,
}: {
  bookId: string;
  photo: DiaryPhoto;
  onOpen: () => void;
}) {
  return (
    <button
      className="diary-photo"
      type="button"
      onClick={onOpen}
      aria-label={`查看照片：${photo.name}`}
    >
      <img
        src={diaryApi.photoUrl(bookId, photo.id)}
        alt={photo.name}
        loading="lazy"
        onError={(e) => {
          e.currentTarget.alt = '照片暂时无法读取，请重新加载';
        }}
      />
    </button>
  );
}

function OpenNotebook({
  bookId,
  day,
  animateOpening,
  onEntered,
  onClosed,
  turn,
  onTurn,
  onTurnConsumed,
}: {
  bookId: string;
  day: string;
  animateOpening: boolean;
  onEntered: () => void;
  onClosed: (returning: NotebookReturn | null) => void;
  turn: DiaryTurn | null;
  onTurn: (turn: DiaryTurn) => void;
  onTurnConsumed: () => void;
}) {
  const today = useDiaryToday();
  const [initialTurn] = useState(turn);
  const [book, setBook] = useState<DiaryNotebook | null>(initialTurn?.book ?? null),
    [page, setPage] = useState<Page | null>(initialTurn?.page ?? null),
    [entries, setEntries] = useState<DiaryEntrySummary[]>(initialTurn?.entries ?? []),
    [before, setBefore] = useState<string | null>(initialTurn?.before ?? null);
  const [value, setValue] = useState<DiaryContent>(
      () => initialTurn?.page.draft ?? initialTurn?.page.saved ?? blank(),
    ),
    [baseline, setBaseline] = useState(() =>
      initialTurn
        ? JSON.stringify(initialTurn.page.draft ?? initialTurn.page.saved ?? blank())
        : '',
    ),
    [step, setStep] = useState<'mood' | 'weather' | 'write' | 'read'>(
      initialTurn?.page.saved ? 'read' : initialTurn?.page.draft ? 'write' : 'mood',
    );
  const [loading, setLoading] = useState(!initialTurn),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [uncertain, setUncertain] = useState(false),
    [history, setHistory] = useState(false),
    [deleteOpen, setDeleteOpen] = useState(false),
    [preview, setPreview] = useState<DiaryPhoto | null>(null),
    [closing, setClosing] = useState(false),
    [closeConfirm, setCloseConfirm] = useState(false),
    [newDayOpen, setNewDayOpen] = useState(false),
    [entryDay, setEntryDay] = useState(today),
    [turnConfirm, setTurnConfirm] = useState<string | null>(null),
    [reloadOpen, setReloadOpen] = useState(false),
    [uploadFailed, setUploadFailed] = useState(false);
  const mounted = useRef(false),
    readGeneration = useRef(0),
    busyRef = useRef(false),
    closeController = useRef<AbortController | null>(null),
    closeModel = useRef<ReturnType<typeof createBookModel>>(null),
    turnController = useRef<AbortController | null>(null),
    seeded = useRef(Boolean(initialTurn)),
    rootRef = useRef<HTMLElement>(null),
    bookRef = useRef<HTMLDivElement>(null),
    leavingConfirmed = useRef(false),
    uploadPending = useRef<{ file: File; id: string } | null>(null);
  const dirty = Boolean(page) && JSON.stringify(value) !== baseline;
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      !leavingConfirmed.current &&
      (dirty || busy) &&
      currentLocation.pathname !== nextLocation.pathname,
  );
  const applyPage = (next: Page, read = false) => {
    setPage(next);
    const nextValue = next.draft ?? next.saved ?? blank();
    setValue(nextValue);
    setBaseline(JSON.stringify(nextValue));
    setStep(read && next.saved ? 'read' : next.draft ? 'write' : 'mood');
  };
  const load = useCallback(async () => {
    const generation = ++readGeneration.current;
    setLoading(true);
    setError('');
    try {
      const [a, b] = await Promise.all([diaryApi.entries(bookId), diaryApi.page(bookId, day)]);
      if (!mounted.current || generation !== readGeneration.current) return;
      setBook(a.data.book);
      setEntries(a.data.entries);
      setBefore(a.data.nextBefore);
      applyPage(b.data.page, true);
      setUncertain(false);
    } catch (e) {
      if (mounted.current && generation === readGeneration.current) setError(message(e));
    } finally {
      if (mounted.current && generation === readGeneration.current) setLoading(false);
    }
  }, [bookId, day]);
  useEffect(() => {
    mounted.current = true;
    if (!seeded.current) void Promise.resolve().then(load);
    return () => {
      mounted.current = false;
      readGeneration.current += 1;
      closeController.current?.abort();
      closeModel.current?.dispose();
      turnController.current?.abort();
    };
  }, [load]);
  useLayoutEffect(() => {
    onTurnConsumed();
    if (!initialTurn || !rootRef.current || !bookRef.current) return;
    const controller = new AbortController();
    void playPaperTurn(rootRef.current, bookRef.current, initialTurn.surface, controller.signal);
    return () => controller.abort();
  }, [initialTurn, onTurnConsumed]);
  useLayoutEffect(() => {
    if (loading || initialTurn || !animateOpening || !rootRef.current || !bookRef.current) return;
    const controller = new AbortController();
    const model = skipBookMotion() ? null : createBookModel(rootRef.current, bookRef.current);
    model?.paint(0);
    void (async () => {
      if (model && (await waitForRouteCat(controller.signal))) {
        await runBookTimeline(BOOK_OPEN_MS, (progress) => model.paint(progress), controller.signal);
      }
      model?.dispose();
      if (!controller.signal.aborted) onEntered();
    })();
    return () => {
      controller.abort();
      model?.dispose();
    };
  }, [loading, initialTurn, animateOpening, onEntered]);
  useEffect(() => {
    if (!dirty && !busy) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, busy]);
  const change = (patch: Partial<DiaryContent>) => {
    setValue((v) => ({ ...v, ...patch }));
    setNotice('');
  };
  const enterBusy = () => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError('');
    return true;
  };
  const leaveBusy = () => {
    busyRef.current = false;
    if (mounted.current) setBusy(false);
  };
  async function save(publish: boolean) {
    if (!page || uncertain || !enterBusy()) return;
    try {
      const r = await diaryApi.save(bookId, day, {
        expectedRevision: page.revision,
        content: value,
        publish,
      });
      if (!mounted.current) return;
      applyPage(r.data.page, publish);
      if (!publish) setStep('write');
      setNotice(publish ? '这一页已经保存好了。' : '草稿已保存到账号。');
      try {
        const updated = await diaryApi.entries(bookId);
        if (mounted.current) {
          setEntries(updated.data.entries);
          setBefore(updated.data.nextBefore);
        }
      } catch {
        if (mounted.current) setError('这一页已保存，日记目录暂时刷新失败。稍后重新打开即可。');
      }
    } catch (e) {
      if (mounted.current) {
        setError(`${message(e)}。请先核对服务器上的这一页，当前输入仍保留在这里。`);
        setUncertain(true);
      }
    } finally {
      leaveBusy();
    }
  }
  async function reconcile() {
    if (!enterBusy()) return;
    try {
      const r = await diaryApi.page(bookId, day);
      if (!mounted.current) return;
      setPage(r.data.page);
      setUncertain(false);
      const stored = r.data.page.draft ?? r.data.page.saved ?? blank();
      setBaseline(JSON.stringify(stored));
      setNotice(
        JSON.stringify(value) === JSON.stringify(stored)
          ? '已核对，当前内容已在账号中。'
          : '已读取最新版本，当前输入仍保留。请对照后决定保存当前输入，或重新读取服务器内容。',
      );
    } catch (e) {
      setError(message(e));
    } finally {
      leaveBusy();
    }
  }
  async function upload(files: File[]) {
    if (!page || !enterBusy()) return;
    setUploadFailed(false);
    let selected = [...value.photoIds];
    try {
      if (selected.length + files.length > 6) throw new Error('一页最多选 6 张照片');
      for (const file of files) {
        if (file.size > 10 * 1024 * 1024) throw new Error('每张照片请小于 10 MB');
        const pending =
          uploadPending.current?.file === file
            ? uploadPending.current
            : { file, id: crypto.randomUUID() };
        uploadPending.current = pending;
        const r = await diaryApi.upload(bookId, day, file, pending.id);
        if (!mounted.current) return;
        uploadPending.current = null;
        selected = [...selected, r.data.photo.id];
        setPage((p) =>
          p
            ? { ...p, photos: [...p.photos.filter((x) => x.id !== r.data.photo.id), r.data.photo] }
            : p,
        );
        change({ photoIds: selected });
      }
      setNotice('照片已上传，保存这一页后会与日记一起留存。');
    } catch (e) {
      setError(message(e));
      setUploadFailed(Boolean(uploadPending.current));
    } finally {
      leaveBusy();
    }
  }
  async function cleanPhoto(photo: DiaryPhoto) {
    if (!enterBusy()) return;
    try {
      await diaryApi.removePhoto(bookId, photo.id);
      setPage((p) => (p ? { ...p, photos: p.photos.filter((x) => x.id !== photo.id) } : p));
    } catch (e) {
      setError(message(e));
    } finally {
      leaveBusy();
    }
  }
  async function deletePage() {
    if (!page || !enterBusy()) return;
    try {
      await diaryApi.remove(bookId, page.revision, day);
      setDeleteOpen(false);
      applyPage({ day, revision: 0, saved: null, draft: null, photos: [], updatedAt: null });
      setEntries((v) => v.filter((e) => e.day !== day));
      setNotice('这一页已删除。');
    } catch (e) {
      setError(message(e));
      setUncertain(true);
    } finally {
      leaveBusy();
    }
  }
  async function more() {
    if (!before || !enterBusy()) return;
    try {
      const r = await diaryApi.entries(bookId, before);
      setEntries((v) => [
        ...v,
        ...r.data.entries.filter((e) => !v.some((old) => old.day === e.day)),
      ]);
      setBefore(r.data.nextBefore);
    } catch (e) {
      setError(message(e));
    } finally {
      leaveBusy();
    }
  }
  const beginClose = async () => {
    if (closeController.current || busyRef.current || !book) return;
    const controller = new AbortController();
    closeController.current = controller;
    leavingConfirmed.current = true;
    setCloseConfirm(false);
    setClosing(true);
    setError('');
    const model =
      !skipBookMotion() && rootRef.current && bookRef.current
        ? createBookModel(rootRef.current, bookRef.current)
        : null;
    closeModel.current = model;
    try {
      // Fetch the destination while closing, so the closed cover never lands on a spinner.
      const [shelf, complete] = await Promise.all([
        diaryApi.list(controller.signal),
        model
          ? runBookTimeline(
              BOOK_CLOSE_MS,
              (progress) => model.paint(1 - progress),
              controller.signal,
            )
          : Promise.resolve(true),
      ]);
      if (!complete || controller.signal.aborted || !mounted.current) return;
      const returning =
        model && !skipBookMotion() ? captureNotebookReturn(model, bookId, shelf.data.books) : null;
      onClosed(returning);
    } catch (e) {
      if (!controller.signal.aborted && mounted.current) {
        controller.abort();
        model?.paint(1);
        model?.dispose();
        closeModel.current = null;
        closeController.current = null;
        leavingConfirmed.current = false;
        setClosing(false);
        setError(`书架暂时没有取回来，日记和当前输入仍在这里。${message(e)}`);
      }
    }
  };
  const closeBook = () => {
    if (busyRef.current || closeController.current) return;
    if (dirty) setCloseConfirm(true);
    else void beginClose();
  };
  const openNewDay = () => {
    if (busyRef.current || closeController.current) return;
    setEntryDay(diaryToday());
    setNewDayOpen(true);
  };
  const beginTurn = async (targetDay: string) => {
    if (!isWritableDiaryDay(targetDay, diaryToday()) || !enterBusy()) return;
    setTurnConfirm(null);
    const controller = new AbortController();
    turnController.current = controller;
    try {
      const [notebook, next] = await Promise.all([
        diaryApi.entries(bookId, undefined, controller.signal),
        diaryApi.page(bookId, targetDay, controller.signal),
      ]);
      if (!mounted.current || controller.signal.aborted) return;
      const surface = bookRef.current
        ? capturePaperTurn(bookRef.current, targetDay > day ? 'forward' : 'back')
        : null;
      leavingConfirmed.current = true;
      onTurn({
        day: targetDay,
        book: notebook.data.book,
        page: next.data.page,
        entries: notebook.data.entries,
        before: notebook.data.nextBefore,
        surface,
      });
    } catch (e) {
      if (!controller.signal.aborted && mounted.current)
        setError(`暂时没能翻到那一天，当前内容仍保留。${message(e)}`);
    } finally {
      leaveBusy();
    }
  };
  const requestDay = (targetDay: string) => {
    if (targetDay === day || busyRef.current || closeController.current) return;
    if (dirty) setTurnConfirm(targetDay);
    else void beginTurn(targetDay);
  };
  const followDayLink = (event: MouseEvent<HTMLAnchorElement>, targetDay: string) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0)
      return;
    event.preventDefault();
    requestDay(targetDay);
  };
  const openChosenDay = () => {
    if (!isWritableDiaryDay(entryDay, diaryToday()) || busyRef.current) return;
    setNewDayOpen(false);
    // Opening an existing day only reads it; never clear or save an existing entry.
    if (entryDay === day) setStep(page?.saved || page?.draft ? 'write' : 'mood');
    else requestDay(entryDay);
  };
  const chronological = [...new Set([today, day, ...entries.map((e) => e.day)])].sort();
  const index = chronological.indexOf(day),
    older = chronological[index - 1],
    newer = chronological[index + 1];
  const selected = step === 'read' && page?.saved ? page.saved : value;
  const visiblePhotos = page?.photos.filter((p) => selected.photoIds.includes(p.id)) ?? [];
  const unusedPhotos =
    page?.photos.filter(
      (p) =>
        !value.photoIds.includes(p.id) &&
        !page.saved?.photoIds.includes(p.id) &&
        !page.draft?.photoIds.includes(p.id),
    ) ?? [];
  const publishable =
    value.mood &&
    value.weather &&
    (value.body.trim() || value.photoIds.length) &&
    count(value.body.trim()) <= 10000 &&
    count(value.title.trim()) <= 80;
  return (
    <main ref={rootRef} className="diary-page open-notebook">
      <header className="cozy-page-heading">
        <div>
          <p className="eyebrow">给自己的日记</p>
          <h1>{book?.name ?? '日记本'}</h1>
          <p>一页今天，一页回忆。慢慢写，也慢慢翻。</p>
        </div>
        <div className="heading-actions">
          <button
            className="button"
            onClick={openNewDay}
            disabled={loading || busy || closing || !page}
          >
            <CozyIcon name="plus" /> 写新一天
          </button>
          {day !== today ? (
            <Link
              className="text-button"
              to={`/app/diary/${bookId}/${today}`}
              onClick={(event) => followDayLink(event, today)}
            >
              记录今天
            </Link>
          ) : null}
          <button className="text-button" onClick={() => setHistory((v) => !v)}>
            <CozyIcon name="read" /> 过往日记
          </button>
          <button
            className="button button-secondary"
            onClick={closeBook}
            disabled={closing || busy}
          >
            合上日记本
          </button>
        </div>
      </header>
      {error ? (
        <div role="alert" className="inline-error diary-feedback">
          {error}
          {uncertain ? (
            <button className="text-button" disabled={busy} onClick={() => void reconcile()}>
              核对服务器内容
            </button>
          ) : !page ? (
            <button onClick={() => void load()} className="text-button">
              重新读取
            </button>
          ) : null}
          {uploadFailed ? (
            <button
              className="text-button"
              disabled={busy}
              onClick={() => {
                if (uploadPending.current) void upload([uploadPending.current.file]);
              }}
            >
              重试这张照片
            </button>
          ) : null}
        </div>
      ) : null}
      {notice ? (
        <p role="status" className="success-note diary-feedback">
          {notice}
        </p>
      ) : null}
      {history ? (
        <section className="diary-history" aria-label="过往日记">
          <h2>翻到那一天</h2>
          <div className="history-days">
            <Link
              to={`/app/diary/${bookId}/${today}`}
              onClick={(event) => followDayLink(event, today)}
            >
              记录今天
            </Link>
            {entries.map((e) => (
              <Link
                key={e.day}
                to={`/app/diary/${bookId}/${e.day}`}
                onClick={(event) => followDayLink(event, e.day)}
                aria-current={day === e.day ? 'page' : undefined}
              >
                <span>{e.day}</span>
                <strong>{e.title || '没有标题的一天'}</strong>
                <small>{e.hasDraft ? '有草稿' : e.published ? '已保存' : ''}</small>
              </Link>
            ))}
          </div>
          {!entries.length ? <p>这里还没有日记，先写下今天吧。</p> : null}
          {before ? (
            <button className="text-button" disabled={busy} onClick={() => void more()}>
              更早的日记
            </button>
          ) : null}
        </section>
      ) : null}
      {loading ? (
        <div className="diary-loading" aria-busy="true">
          <CatArt mood="happy" />
          <p>把书轻轻打开…</p>
        </div>
      ) : page && book ? (
        <>
          <div className="book-tabs" role="group" aria-label="记录步骤">
            {(['mood', 'weather', 'write'] as const).map((s, i) => (
              <button key={s} aria-pressed={step === s} onClick={() => setStep(s)} disabled={busy}>
                <CozyIcon name={i === 0 ? 'smile' : i === 1 ? 'sun' : 'pen'} />
                {['选心情', '选天气', '写日记'][i]}
              </button>
            ))}
          </div>
          <div ref={bookRef} className="diary-book" aria-label="打开的日记本">
            <div className="book-motion-cover-template" hidden aria-hidden="true">
              <span className="diary-entry-cover-caption">给自己的日记</span>
              <strong>{book.name}</strong>
              <CatArt mood={book.cat} />
              <p>
                一点心情，一件小事。
                <br />
                慢慢写，慢慢记。
              </p>
            </div>
            <section className="paper-page paper-left">
              <div className="page-running-head">
                <span>{book.name}</span>
                <span>日子慢慢，心事轻放</span>
              </div>
              <div className="paper-date">
                <span>
                  {day.slice(0, 4)} 年 {Number(day.slice(5, 7))} 月
                </span>
                <strong>{day.slice(8)}</strong>
                <span>
                  {new Intl.DateTimeFormat('zh-CN', {
                    weekday: 'long',
                    timeZone: 'Asia/Shanghai',
                  }).format(new Date(`${day}T12:00:00+08:00`))}
                </span>
              </div>
              <h2>{day === today ? '今天，也值得被记住。' : '那一天，也是珍贵的一页。'}</h2>
              <div className="paper-cat">
                <CatArt mood={selected.mood ?? book.cat} />
                <p>{selected.mood ? cats[selected.mood].label : '慢慢感受，不急着选择。'}</p>
              </div>
              <p className="paper-verse">
                不必写成一个完整的故事。
                <br />
                一点心情，一件小事，
                <br />
                就是今天留下的痕迹。
              </p>
              <div className="paper-summary">
                <span>
                  <CozyIcon name="smile" />
                  {selected.mood ? cats[selected.mood].label : '心情：待选择'}
                </span>
                <span>
                  {selected.weather ? (
                    <WeatherArt weather={selected.weather} />
                  ) : (
                    <CozyIcon name="sun" />
                  )}
                  {selected.weather ? weathers[selected.weather].label : '天气：待选择'}
                </span>
              </div>
              <button className="text-button" onClick={() => setHistory((v) => !v)}>
                翻看过往日记 <CozyIcon name="arrow" />
              </button>
              <small className="paper-number">{String(index * 2 + 1).padStart(2, '0')}</small>
            </section>
            <section
              className="paper-page paper-right"
              key={step}
              aria-label={step === 'read' ? '阅读日记' : day === today ? '记录今天' : '记录这一天'}
            >
              {step === 'mood' ? (
                <>
                  <h2>{day === today ? '今天' : '那天'}，你更像哪只小猫？</h2>
                  <p className="muted">先听听自己的心情，什么感受都可以。</p>
                  <CatPicker
                    value={value.mood}
                    onChange={(mood) => change({ mood })}
                    disabled={busy}
                  />
                  <div className="book-step-footer">
                    <span>选一只最贴近今天感受的小猫。</span>
                    <button
                      className="button"
                      disabled={!value.mood || busy}
                      onClick={() => setStep('weather')}
                    >
                      接着选天气 <CozyIcon name="arrow" />
                    </button>
                  </div>
                </>
              ) : null}
              {step === 'weather' ? (
                <>
                  <h2>{day === today ? '今天' : '那天'}，窗外是什么模样？</h2>
                  <p className="muted">把这一刻的天气，也留在这一页。</p>
                  <div className="weather-picker">
                    {DIARY_WEATHER_VALUES.map((weather) => (
                      <button
                        key={weather}
                        className={value.weather === weather ? 'chosen' : ''}
                        type="button"
                        aria-pressed={value.weather === weather}
                        disabled={busy}
                        onClick={() => change({ weather })}
                      >
                        <WeatherArt weather={weather} />
                        <span>{weathers[weather].label}</span>
                      </button>
                    ))}
                  </div>
                  <div className="book-step-footer">
                    <button className="text-button" onClick={() => setStep('mood')}>
                      ← 回到心情
                    </button>
                    <button
                      className="button"
                      disabled={!value.weather || busy}
                      onClick={() => setStep('write')}
                    >
                      开始写日记 <CozyIcon name="arrow" />
                    </button>
                  </div>
                </>
              ) : null}
              {step === 'write' ? (
                <>
                  <h2>这一页，写给自己。</h2>
                  <p className="muted">不用斟酌开头，就从现在想到的开始。</p>
                  <label className="sr-only" htmlFor="diary-title">
                    日记标题
                  </label>
                  <input
                    className="diary-title-input"
                    id="diary-title"
                    value={value.title}
                    onChange={(e) => change({ title: e.target.value })}
                    disabled={busy}
                    placeholder="给今天起个名字（选填）"
                  />
                  <label className="sr-only" htmlFor="diary-body">
                    日记正文
                  </label>
                  <textarea
                    className="diary-body-input"
                    id="diary-body"
                    value={value.body}
                    onChange={(e) => change({ body: e.target.value })}
                    disabled={busy}
                    placeholder={'今天，发生了什么？\n\n也许是一件小事，也许只是一种感觉……'}
                  />
                  <div className="diary-word-count">
                    <span>慢慢写，不着急。</span>
                    <span className={count(value.body.trim()) > 10000 ? 'danger-text' : ''}>
                      {count(value.body.trim())}/10000
                    </span>
                  </div>
                  <section className="diary-photos" aria-label="日记照片">
                    <div className="photo-toolbar">
                      <label className={`button button-secondary ${busy ? 'disabled' : ''}`}>
                        <CozyIcon name="image" /> 添加照片
                        <input
                          className="sr-only"
                          type="file"
                          multiple
                          accept="image/png,image/jpeg,image/webp,image/gif"
                          disabled={busy || value.photoIds.length >= 6}
                          onChange={(e) => {
                            const files = Array.from(e.target.files ?? []);
                            e.target.value = '';
                            if (files.length) void upload(files);
                          }}
                        />
                      </label>
                      <small>最多 6 张 · 每张 10 MB</small>
                    </div>
                    <div className="photo-grid">
                      {visiblePhotos.map((photo) => (
                        <figure key={photo.id}>
                          <Photo bookId={bookId} photo={photo} onOpen={() => setPreview(photo)} />
                          <button
                            type="button"
                            className="photo-remove"
                            disabled={busy}
                            onClick={() =>
                              change({ photoIds: value.photoIds.filter((id) => id !== photo.id) })
                            }
                            aria-label={`从这一页移除${photo.name}`}
                          >
                            ×
                          </button>
                        </figure>
                      ))}
                    </div>
                    {unusedPhotos.length ? (
                      <details>
                        <summary>未放入日记的照片（{unusedPhotos.length}）</summary>
                        {unusedPhotos.map((photo) => (
                          <div className="unused-photo" key={photo.id}>
                            <span>{photo.name}</span>
                            <button
                              className="text-button"
                              disabled={busy || value.photoIds.length >= 6}
                              onClick={() => change({ photoIds: [...value.photoIds, photo.id] })}
                            >
                              添加到这一页
                            </button>
                            <button
                              className="text-button danger-text"
                              disabled={busy}
                              onClick={() => void cleanPhoto(photo)}
                            >
                              删除照片
                            </button>
                          </div>
                        ))}
                      </details>
                    ) : null}
                  </section>
                  <div className="book-step-footer">
                    <button
                      className="button button-secondary"
                      disabled={
                        busy ||
                        uncertain ||
                        count(value.title.trim()) > 80 ||
                        count(value.body.trim()) > 10000
                      }
                      onClick={() => void save(false)}
                    >
                      暂存草稿
                    </button>
                    <button
                      className="button"
                      disabled={busy || uncertain || !publishable}
                      onClick={() => void save(true)}
                    >
                      {busy ? '正在保存…' : '保存这一页'}
                    </button>
                  </div>
                  {!value.mood || !value.weather ? (
                    <p className="muted">选好心情和天气，就可以保存完整的一页。也可以先存草稿。</p>
                  ) : null}
                  {count(value.title.trim()) > 80 ? (
                    <p className="inline-error">标题最多 80 字。</p>
                  ) : null}
                </>
              ) : null}
              {step === 'read' && page.saved ? (
                <>
                  <div className="reading-day">
                    <h2>{page.saved.title || '没有标题的一天'}</h2>
                    <p>
                      {page.saved.mood ? cats[page.saved.mood].label : ''} ·{' '}
                      {page.saved.weather ? weathers[page.saved.weather].label : ''}
                    </p>
                  </div>
                  <p className="diary-reading-body">{page.saved.body}</p>
                  <div className="photo-grid">
                    {visiblePhotos.map((photo) => (
                      <Photo
                        key={photo.id}
                        bookId={bookId}
                        photo={photo}
                        onOpen={() => setPreview(photo)}
                      />
                    ))}
                  </div>
                  <div className="book-step-footer">
                    <button className="text-button danger-text" onClick={() => setDeleteOpen(true)}>
                      删除这一页
                    </button>
                    <button className="button button-secondary" onClick={() => setStep('write')}>
                      {page.draft ? '继续编辑草稿' : '编辑这一页'}
                    </button>
                    <button className="button" onClick={openNewDay} disabled={busy}>
                      <CozyIcon name="plus" /> 写新一天
                    </button>
                  </div>
                </>
              ) : null}
              <div className="paper-bottom">
                <span>
                  {dirty ? '有未保存的修改' : page.revision ? '已同步到账号' : '空白的一页'}
                </span>
                {page.revision ? (
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => setReloadOpen(true)}
                  >
                    重新读取
                  </button>
                ) : null}
                <small className="paper-number">{String(index * 2 + 2).padStart(2, '0')}</small>
              </div>
            </section>
            <button
              className="page-edge edge-left"
              aria-label="上一篇日记"
              disabled={!older || busy}
              onClick={() => {
                if (older) requestDay(older);
              }}
            >
              ‹<span>上一篇</span>
            </button>
            <button
              className="page-edge edge-right"
              aria-label={newer ? '下一篇日记' : '写新一天的日记'}
              disabled={busy}
              onClick={() => (newer ? requestDay(newer) : openNewDay())}
            >
              ›<span>{!newer ? '写新一天' : newer === today ? '回到今天' : '下一篇'}</span>
            </button>
          </div>
          <p className="book-caption">点击页边翻看日记，或选择“写新一天”，为另一天留下一页。</p>
        </>
      ) : null}
      <ConfirmDialog
        open={newDayOpen}
        title="新的一页，想记录哪一天？"
        confirmLabel="打开这一天"
        confirmDisabled={!isWritableDiaryDay(entryDay, today)}
        busy={busy}
        onClose={() => setNewDayOpen(false)}
        onConfirm={openChosenDay}
      >
        <label htmlFor="diary-entry-day">日记日期</label>
        <input
          id="diary-entry-day"
          type="date"
          min="1900-01-01"
          max={today}
          value={entryDay}
          onChange={(event) => setEntryDay(event.target.value)}
          aria-describedby="diary-entry-day-help"
        />
        <div className="diary-date-shortcuts">
          <button className="button button-secondary" onClick={() => setEntryDay(today)}>
            今天
          </button>
          <button
            className="button button-secondary"
            onClick={() => setEntryDay(previousDiaryDay(today))}
          >
            昨天
          </button>
        </div>
        <p id="diary-entry-day-help" className="muted">
          可以记录今天，也可以补写过去的一天。已写过的日期会打开原来的日记。
        </p>
        {entryDay && !isWritableDiaryDay(entryDay, today) ? (
          <p className="inline-error" role="alert">
            请选择今天或过去的有效日期。
          </p>
        ) : null}
      </ConfirmDialog>
      <ConfirmDialog
        open={closeConfirm || Boolean(turnConfirm) || blocker.state === 'blocked'}
        title="这一页还没有保存"
        confirmLabel="放下修改并离开"
        busy={busy}
        onClose={() => {
          setCloseConfirm(false);
          setTurnConfirm(null);
          if (blocker.state === 'blocked') blocker.reset();
        }}
        onConfirm={() => {
          if (closeConfirm) void beginClose();
          else if (turnConfirm) void beginTurn(turnConfirm);
          else if (blocker.state === 'blocked') blocker.proceed();
        }}
      >
        <p>文字和选择还有未保存的修改。可以取消离开，先暂存草稿。</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={reloadOpen}
        title="重新读取账号中的内容？"
        confirmLabel="重新读取"
        onClose={() => setReloadOpen(false)}
        onConfirm={() => {
          setReloadOpen(false);
          void load();
        }}
      >
        <p>这会用服务器中的日记或草稿替换当前输入，未保存的修改会丢失。</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={deleteOpen}
        title="删除这一天的记录？"
        confirmLabel="删除这一页"
        busy={busy}
        destructive
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => void deletePage()}
      >
        <p>正文、草稿和当天照片都会被删除，无法撤销。</p>
        {error ? (
          <p className="inline-error" role="alert">
            {error}
          </p>
        ) : null}
      </ConfirmDialog>
      <ConfirmDialog
        open={Boolean(preview)}
        title="这一刻的照片"
        confirmLabel="看好了"
        onClose={() => setPreview(null)}
        onConfirm={() => setPreview(null)}
      >
        {preview ? (
          <img
            className="photo-lightbox"
            src={diaryApi.photoUrl(bookId, preview.id)}
            alt={preview.name}
          />
        ) : null}
      </ConfirmDialog>
    </main>
  );
}

function NotebookWorkspace({
  bookId,
  day,
  onClosed,
}: {
  bookId: string;
  day: string;
  onClosed: (returning: NotebookReturn | null) => void;
}) {
  const [entered, setEntered] = useState(false);
  const navigate = useNavigate();
  const [turn, setTurn] = useState<DiaryTurn | null>(null);
  const onEntered = useCallback(() => setEntered(true), []);
  const onTurnConsumed = useCallback(() => setTurn(null), []);
  const onTurn = (next: DiaryTurn) => {
    setTurn(next);
    navigate(`/app/diary/${bookId}/${next.day}`);
  };
  return (
    <OpenNotebook
      key={day}
      bookId={bookId}
      day={day}
      animateOpening={!entered}
      onEntered={onEntered}
      onClosed={onClosed}
      turn={turn?.day === day ? turn : null}
      onTurn={onTurn}
      onTurnConsumed={onTurnConsumed}
    />
  );
}

export function DiaryPage() {
  const { bookId, day } = useParams();
  const navigate = useNavigate();
  const [returning, setReturning] = useState<NotebookReturn | null>(null);
  const onReturned = useCallback(() => setReturning(null), []);
  const onClosed = (snapshot: NotebookReturn | null) => {
    setReturning(snapshot);
    navigate('/app/diary');
  };
  useEffect(
    () => () => {
      if (returning) disposeNotebookReturn(returning);
    },
    [returning],
  );
  if (bookId && !day) return <Navigate replace to={`/app/diary/${bookId}/${diaryToday()}`} />;
  return bookId && day ? (
    <NotebookWorkspace key={bookId} bookId={bookId} day={day} onClosed={onClosed} />
  ) : (
    <NotebookShelf returning={returning} onReturned={onReturned} />
  );
}
