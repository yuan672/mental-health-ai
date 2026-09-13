import {
  type ChangeEvent,
  type CSSProperties,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import weatherCloudAnimated from '../../assets/weather-cloud-animated.svg';
import weatherCloudStill from '../../assets/weather-cloud-still.svg';
import weatherDrizzleAnimated from '../../assets/weather-drizzle-animated.svg';
import weatherDrizzleStill from '../../assets/weather-drizzle-still.svg';
import weatherFogAnimated from '../../assets/weather-fog-animated.svg';
import weatherFogStill from '../../assets/weather-fog-still.svg';
import weatherPartlyAnimated from '../../assets/weather-partly-animated.svg';
import weatherPartlyStill from '../../assets/weather-partly-still.svg';
import weatherRainAnimated from '../../assets/weather-rain-animated.svg';
import weatherRainStill from '../../assets/weather-rain-still.svg';
import weatherSnowAnimated from '../../assets/weather-snow-animated.svg';
import weatherSnowStill from '../../assets/weather-snow-still.svg';
import weatherSunAnimated from '../../assets/weather-sun-animated.svg';
import weatherSunStill from '../../assets/weather-sun-still.svg';
import weatherThunderAnimated from '../../assets/weather-thunder-animated.svg';
import weatherThunderStill from '../../assets/weather-thunder-still.svg';
import weatherWindAnimated from '../../assets/weather-wind-animated.svg';
import weatherWindStill from '../../assets/weather-wind-still.svg';
import { useSession } from '../../app/session-provider';
import { CatArt } from '../../shared/cat-art';
import { ConfirmDialog } from '../../shared/confirm-dialog';
import { Icon } from '../../shared/icons';
import {
  createDiaryId,
  type DiaryDraft,
  type DiaryEntry,
  type DiaryMood,
  type DiaryNotebook,
  type DiaryPhoto,
  type DiaryShelf,
  type DiaryWeather,
  loadDiaryShelf,
  saveDiaryShelf,
} from './diary-store';

const moodOptions: ReadonlyArray<
  Readonly<{ id: DiaryMood; name: string; hint: string; duration: string }>
> = [
  { id: 'happy', name: '开心', hint: '有一点开心，也值得被记住。', duration: '1.25s' },
  { id: 'sad', name: '委屈', hint: '委屈的时候，也可以先照顾自己的感受。', duration: '1.6s' },
  { id: 'angry', name: '生气', hint: '愿意的话，可以写下让你生气的事。', duration: '1.2s' },
  { id: 'surprised', name: '惊讶', hint: '把这个意料之外的瞬间，记在这里。', duration: '1.2s' },
  { id: 'shy', name: '害羞', hint: '不急，按自己的节奏表达就好。', duration: '1.7s' },
  { id: 'sleepy', name: '困倦', hint: '有些累了，今天也可以慢一点。', duration: '2.8s' },
  { id: 'hopeful', name: '期待', hint: '把心里的小期待，留在这里。', duration: '1.6s' },
  { id: 'relaxed', name: '放松', hint: '这一刻的松弛，值得留一份记录。', duration: '2.4s' },
];

const weatherOptions: ReadonlyArray<
  Readonly<{
    id: DiaryWeather;
    name: string;
    description: string;
    still: string;
    animated: string;
  }>
> = [
  {
    id: 'sun',
    name: '晴天',
    description: '暖暖日光',
    still: weatherSunStill,
    animated: weatherSunAnimated,
  },
  {
    id: 'partly',
    name: '多云',
    description: '云间见晴',
    still: weatherPartlyStill,
    animated: weatherPartlyAnimated,
  },
  {
    id: 'cloud',
    name: '阴天',
    description: '云朵层叠',
    still: weatherCloudStill,
    animated: weatherCloudAnimated,
  },
  {
    id: 'drizzle',
    name: '小雨',
    description: '雨丝轻落',
    still: weatherDrizzleStill,
    animated: weatherDrizzleAnimated,
  },
  {
    id: 'rain',
    name: '下雨',
    description: '雨点滴答',
    still: weatherRainStill,
    animated: weatherRainAnimated,
  },
  {
    id: 'thunder',
    name: '雷雨',
    description: '雷声阵阵',
    still: weatherThunderStill,
    animated: weatherThunderAnimated,
  },
  {
    id: 'snow',
    name: '下雪',
    description: '雪花轻舞',
    still: weatherSnowStill,
    animated: weatherSnowAnimated,
  },
  {
    id: 'wind',
    name: '有风',
    description: '微风拂过',
    still: weatherWindStill,
    animated: weatherWindAnimated,
  },
  {
    id: 'fog',
    name: '起雾',
    description: '薄雾朦胧',
    still: weatherFogStill,
    animated: weatherFogAnimated,
  },
];

type DiaryStep = 'mood' | 'weather' | 'write';
type NotebookDialog = Readonly<{ kind: 'create' } | { kind: 'rename'; bookId: string }>;

function dayKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dayLabel(day: string, weekday = false): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year!, month! - 1, date!).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    ...(weekday ? { weekday: 'long' } : {}),
  });
}

function scopedPath(path: string, bookId: string): string {
  return `/app/diary/${path}?book=${encodeURIComponent(bookId)}`;
}

function entryOrDraftPath(book: DiaryNotebook, day: string): string {
  if (book.drafts[day] || !book.entries.some((entry) => entry.day === day)) {
    const draft = book.drafts[day];
    const step: DiaryStep = draft?.mood && draft.weather ? 'write' : 'mood';
    return scopedPath(day === dayKey() ? `today/${step}` : `edit/${day}/${step}`, book.id);
  }
  return scopedPath(`entry/${day}`, book.id);
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function defaultDraft(day: string, entry?: DiaryEntry): DiaryDraft {
  return entry
    ? { ...entry, images: entry.images.map((image) => ({ ...image })) }
    : { day, weather: '', mood: '', title: '', body: '', images: [] };
}

function findBook(shelf: DiaryShelf, bookId: string): DiaryNotebook | undefined {
  return shelf.books.find((book) => book.id === bookId);
}

function readImage(file: File): Promise<DiaryPhoto> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const image = new Image();
    let settled = false;
    const timer = globalThis.setTimeout(() => finish(new Error('图片读取超时')), 20_000);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      reader.onload = reader.onerror = reader.onabort = null;
      image.onload = image.onerror = null;
      if (error) reject(error);
      else
        resolve({
          id: createDiaryId('photo'),
          name: file.name || '照片',
          src: String(reader.result),
        });
    };
    reader.onerror = reader.onabort = () => finish(new Error('图片读取失败'));
    reader.onload = () => {
      image.onload = () =>
        finish(image.naturalWidth && image.naturalHeight ? undefined : new Error('图片无法打开'));
      image.onerror = () => finish(new Error('图片无法打开'));
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

function WeatherArt({
  weather,
  moving = false,
  className = '',
}: {
  weather: DiaryWeather;
  moving?: boolean;
  className?: string;
}) {
  const option = weatherOptions.find((item) => item.id === weather)!;
  return (
    <img
      className={className}
      src={moving ? option.animated : option.still}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}

function DiaryPhotoGallery({
  images,
  onRemove,
}: {
  images: DiaryPhoto[];
  onRemove?: (id: string) => void;
}) {
  const [preview, setPreview] = useState<number | null>(null);
  const visiblePreview = preview !== null && preview < images.length ? preview : null;
  return (
    <>
      <div className="diary-image-gallery" role="group" aria-label="日记中的图片">
        {images.map((photo, index) => (
          <figure className="diary-photo" key={photo.id}>
            <button
              type="button"
              className="diary-photo-view"
              aria-label={`放大第 ${index + 1} 张图片：${photo.name}`}
              onClick={() => setPreview(index)}
            >
              <img src={photo.src} alt={photo.name} />
            </button>
            <figcaption title={photo.name}>{photo.name}</figcaption>
            {onRemove ? (
              <button
                type="button"
                className="diary-photo-remove"
                aria-label={`移除图片：${photo.name}`}
                onClick={() => onRemove(photo.id)}
              >
                <Icon name="x" />
              </button>
            ) : null}
          </figure>
        ))}
      </div>
      {visiblePreview === null ? null : (
        <div
          className="diary-photo-backdrop"
          role="presentation"
          onMouseDown={() => setPreview(null)}
        >
          <div
            className="diary-photo-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="日记图片预览"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <span>这一页的小片刻</span>
              <button type="button" aria-label="关闭图片预览" onClick={() => setPreview(null)}>
                <Icon name="x" />
              </button>
            </header>
            <img src={images[visiblePreview]!.src} alt={images[visiblePreview]!.name} />
            <footer>
              <button
                type="button"
                aria-label="上一张图片"
                disabled={visiblePreview === 0}
                onClick={() => setPreview((current) => Math.max(0, current! - 1))}
              >
                <Icon name="chevron-left" />
              </button>
              <span>
                {visiblePreview + 1} / {images.length} · {images[visiblePreview]!.name}
              </span>
              <button
                type="button"
                aria-label="下一张图片"
                disabled={visiblePreview === images.length - 1}
                onClick={() => setPreview((current) => Math.min(images.length - 1, current! + 1))}
              >
                <Icon name="chevron-right" />
              </button>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}

export function DiaryPage() {
  const session = useSession();
  const userId = session.state.status === 'authenticated' ? session.state.value.user.id : '';
  return <UserDiaryPage key={userId} userId={userId} />;
}

function UserDiaryPage({ userId }: { userId: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { '*': route = '' } = useParams();
  const [searchParams] = useSearchParams();
  const [shelf, setShelf] = useState<DiaryShelf | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [storageState, setStorageState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState<NotebookDialog | null>(null);
  const [notebookName, setNotebookName] = useState('');
  const [opening, setOpening] = useState(false);
  const [closing, setClosing] = useState(false);
  const [turning, setTurning] = useState<'previous' | 'next' | null>(null);
  const [movingWeather, setMovingWeather] = useState<DiaryWeather | null>(null);
  const [imageBusy, setImageBusy] = useState(false);
  const [imageStatus, setImageStatus] = useState('');
  const saveRevisionRef = useRef(0);
  const loadedRef = useRef(false);
  const routeTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const weatherTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);

  useEffect(() => {
    let active = true;
    loadedRef.current = false;
    void loadDiaryShelf(userId)
      .then((loaded) => {
        if (!active) return;
        setShelf(loaded);
        loadedRef.current = true;
        setLoadState('ready');
        setStorageState('saved');
      })
      .catch(() => {
        if (!active) return;
        setLoadState('error');
        setStorageState('error');
      });
    return () => {
      active = false;
      loadedRef.current = false;
    };
  }, [userId]);

  const mutateShelf = useCallback((mutation: (draft: DiaryShelf) => void) => {
    setShelf((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      mutation(next);
      return next;
    });
    saveRevisionRef.current += 1;
    setStorageState('saving');
  }, []);

  useEffect(() => {
    if (!shelf || !loadedRef.current || storageState !== 'saving') return;
    const revision = saveRevisionRef.current;
    const timer = globalThis.setTimeout(() => {
      void saveDiaryShelf(shelf)
        .then(() => {
          if (revision === saveRevisionRef.current) setStorageState('saved');
        })
        .catch(() => setStorageState('error'));
    }, 240);
    return () => globalThis.clearTimeout(timer);
  }, [shelf, storageState]);

  useEffect(
    () => () => {
      if (routeTimerRef.current !== null) globalThis.clearTimeout(routeTimerRef.current);
      if (weatherTimerRef.current !== null) globalThis.clearTimeout(weatherTimerRef.current);
    },
    [],
  );

  const requestedBookId = searchParams.get('book');
  const activeBook = shelf
    ? requestedBookId
      ? findBook(shelf, requestedBookId)
      : findBook(shelf, shelf.activeId)
    : undefined;
  const showShelf = route === 'shelf' || (route === '' && shelf?.closed);

  const routeParts = route.split('/').filter(Boolean);
  const section = routeParts[0] ?? '';
  const today = dayKey();
  const activeDay = section === 'entry' || section === 'edit' ? routeParts[1] : today;
  const requestedStep = (section === 'today' ? routeParts[1] : routeParts[2]) as
    DiaryStep | undefined;
  const step: DiaryStep = ['mood', 'weather', 'write'].includes(requestedStep ?? '')
    ? requestedStep!
    : 'mood';

  if (loadState === 'loading') {
    return (
      <main className="diary-page diary-loading" aria-busy="true">
        <CatArt mood="sleepy" />
        <p>正在取出你的日记本…</p>
      </main>
    );
  }
  if (loadState === 'error' || !shelf) {
    return (
      <main className="diary-page diary-loading" role="alert">
        <CatArt mood="sad" />
        <h1>暂时无法打开日记本</h1>
        <p>浏览器本地存储当前不可用。没有写入任何日记内容。</p>
        <button type="button" className="button" onClick={() => globalThis.location.reload()}>
          重新加载
        </button>
      </main>
    );
  }

  const storageText =
    storageState === 'saving'
      ? '正在收好这一页…'
      : storageState === 'error'
        ? '暂时无法保存到浏览器，内容仍保留在本次打开中。'
        : '已保存在此浏览器';

  const openBook = (bookId: string) => {
    mutateShelf((next) => {
      next.activeId = bookId;
      next.closed = false;
    });
    setOpening(true);
    navigate(scopedPath('today/mood', bookId));
    routeTimerRef.current = globalThis.setTimeout(() => setOpening(false), 1_720);
  };

  const closeBook = () => {
    if (closing || !activeBook) return;
    setClosing(true);
    routeTimerRef.current = globalThis.setTimeout(() => {
      mutateShelf((next) => {
        next.closed = true;
      });
      setClosing(false);
      navigate('/app/diary/shelf');
    }, 880);
  };

  const submitNotebookName = () => {
    const name = notebookName.trim();
    if (!dialog || !name || codePointLength(name) > 24) return;
    const duplicate = shelf.books.some(
      (book) =>
        (dialog.kind === 'create' || book.id !== dialog.bookId) &&
        book.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
    );
    if (duplicate) return;
    if (dialog.kind === 'create') {
      const id = createDiaryId('notebook');
      mutateShelf((next) => {
        next.books.push({
          id,
          name,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          entries: [],
          drafts: {},
        });
        next.activeId = id;
        next.closed = false;
      });
      setDialog(null);
      openBook(id);
      setNotice('新本子准备好了，慢慢写吧。');
    } else {
      mutateShelf((next) => {
        const book = findBook(next, dialog.bookId)!;
        book.name = name;
        book.updatedAt = Date.now();
      });
      setDialog(null);
      setNotice('日记本已经换上新名字。');
    }
  };

  if (showShelf) {
    return (
      <main className="diary-page diary-shelf-page" aria-labelledby="diary-shelf-title">
        <header className="diary-shelf-heading">
          <div>
            <p className="eyebrow">把日子，一本一本收好</p>
            <h1 id="diary-shelf-title">我的小书架</h1>
            <p>合上的是书，留下的是每一个你。</p>
          </div>
          <button
            type="button"
            className="button"
            onClick={() => {
              setNotebookName('');
              setDialog({ kind: 'create' });
            }}
          >
            <Icon name="plus" /> 新建日记本
          </button>
        </header>
        {notice ? (
          <p className="status-note" role="status">
            {notice}
          </p>
        ) : null}
        <section className="diary-shelf-room" aria-label="我的日记本">
          <div className="diary-shelf-top">
            <div>
              <strong>{shelf.books.length} 本日记 · 都在这里</strong>
              <p>想写的时候，就打开一本吧。</p>
            </div>
            <CatArt mood="sleepy" />
          </div>
          <div className="diary-shelves">
            {shelf.books.map((book, index) => {
              const draftCount = Object.values(book.drafts).filter(
                (draft) =>
                  draft.title || draft.body || draft.mood || draft.weather || draft.images.length,
              ).length;
              const latest = [...book.entries].sort((a, b) => b.day.localeCompare(a.day))[0];
              return (
                <article className="diary-shelf-item" key={book.id}>
                  <button
                    type="button"
                    className="notebook-cover"
                    aria-label={`打开日记本：${book.name}`}
                    onClick={() => openBook(book.id)}
                  >
                    <span className="notebook-cover-spine" aria-hidden="true" />
                    <span className="notebook-cover-label">给自己的日记</span>
                    <strong>{book.name}</strong>
                    <CatArt mood={(['sleepy', 'relaxed', 'hopeful'] as const)[index % 3]!} />
                    <span className="notebook-cover-bottom">一点心情 · 一件小事</span>
                    <span className="notebook-cover-bookmark" aria-hidden="true" />
                    <span className="notebook-cover-open">
                      打开看看 <Icon name="arrow-right" />
                    </span>
                  </button>
                  <div className="notebook-card-meta">
                    <p>
                      {book.entries.length} 篇日记{draftCount ? ` · ${draftCount} 篇草稿` : ''}
                    </p>
                    <span>
                      {latest
                        ? `最近记录 ${dayLabel(latest.day)}`
                        : draftCount
                          ? '还有想写的话，等你回来'
                          : '空白的一页，等你开始'}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setNotebookName(book.name);
                        setDialog({ kind: 'rename', bookId: book.id });
                      }}
                    >
                      改个名字
                    </button>
                  </div>
                </article>
              );
            })}
            <article className="diary-shelf-item">
              <button
                type="button"
                className="notebook-cover notebook-cover-new"
                onClick={() => {
                  setNotebookName('');
                  setDialog({ kind: 'create' });
                }}
              >
                <span className="notebook-new-plus">
                  <Icon name="plus" />
                </span>
                <strong>再放一本新日记</strong>
                <span>
                  给下一段日子
                  <br />
                  留一点空白
                </span>
              </button>
            </article>
          </div>
          <p className="diary-shelf-footnote">有些日子适合写很长，有些日子只需要一句话。</p>
        </section>
        <p className={`diary-storage${storageState === 'error' ? ' has-error' : ''}`} role="status">
          {storageText}
        </p>
        <ConfirmDialog
          open={dialog !== null}
          title={dialog?.kind === 'rename' ? '给日记本换个名字' : '新的故事，从一个名字开始'}
          confirmLabel={dialog?.kind === 'rename' ? '保存名字' : '创建并打开'}
          confirmDisabled={!notebookName.trim() || codePointLength(notebookName.trim()) > 24}
          onClose={() => setDialog(null)}
          onConfirm={submitNotebookName}
        >
          <div className="notebook-dialog-art">
            <CatArt mood="hopeful" />
          </div>
          <label htmlFor="notebook-name">日记本名字</label>
          <input
            id="notebook-name"
            value={notebookName}
            placeholder="例如：慢慢变好的日子"
            aria-describedby="notebook-name-count"
            onChange={(event) => setNotebookName(event.target.value)}
          />
          <p id="notebook-name-count">{codePointLength(notebookName.trim())} / 24</p>
        </ConfirmDialog>
      </main>
    );
  }

  if (!activeBook || !activeDay) return <Navigate replace to="/app/diary/shelf" />;
  const entry = activeBook.entries.find((item) => item.day === activeDay);
  const mode = section === 'history' ? 'history' : section === 'entry' ? 'read' : 'edit';
  const draft =
    activeBook.drafts[activeDay] ?? (mode === 'edit' ? defaultDraft(activeDay, entry) : undefined);
  const selectedMood = moodOptions.find((item) => item.id === (draft?.mood || entry?.mood));
  const selectedWeather = weatherOptions.find(
    (item) => item.id === (draft?.weather || entry?.weather),
  );
  const date = new Date(`${activeDay}T12:00:00`);
  const allDays = [
    ...new Set([
      ...activeBook.entries.map((item) => item.day),
      ...Object.keys(activeBook.drafts),
      today,
    ]),
  ].sort();
  const dayIndex = allDays.indexOf(activeDay);

  const updateDraft = (mutation: (next: DiaryDraft) => void) => {
    mutateShelf((next) => {
      const book = findBook(next, activeBook.id)!;
      const nextDraft = book.drafts[activeDay] ?? defaultDraft(activeDay, entry);
      mutation(nextDraft);
      book.drafts[activeDay] = nextDraft;
      book.updatedAt = Date.now();
    });
  };

  const navigateWithinBook = (path: string, direction?: 'previous' | 'next') => {
    if (!direction || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      navigate(scopedPath(path, activeBook.id));
      return;
    }
    setTurning(direction);
    routeTimerRef.current = globalThis.setTimeout(() => {
      navigate(scopedPath(path, activeBook.id));
      setTurning(null);
    }, 280);
  };

  const animateWeather = (weather: DiaryWeather) => {
    if (weatherTimerRef.current !== null) globalThis.clearTimeout(weatherTimerRef.current);
    setMovingWeather(weather);
    weatherTimerRef.current = globalThis.setTimeout(() => setMovingWeather(null), 1_650);
  };

  const addImages = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    event.target.value = '';
    if (!draft || imageBusy || files.length === 0) return;
    const available = 6 - draft.images.length;
    const accepted = files.slice(0, available).filter((file) => {
      const correctType = /^image\/(?:jpeg|png|webp|gif)$/i.test(file.type);
      return correctType && file.size > 0 && file.size <= 10 * 1024 * 1024;
    });
    if (!accepted.length) {
      setImageStatus('请选择不超过 10 MB 的 JPG、PNG、WebP 或 GIF 图片。');
      return;
    }
    setImageBusy(true);
    setImageStatus('正在把图片放进这一页…');
    const added: DiaryPhoto[] = [];
    for (const file of accepted) {
      try {
        added.push(await readImage(file));
      } catch {
        /* a fixed message is shown below */
      }
    }
    if (added.length) updateDraft((next) => next.images.push(...added));
    setImageBusy(false);
    setImageStatus(
      added.length
        ? `已添加 ${added.length} 张图片，点击照片可以放大。`
        : '有图片无法打开，请重新选择。',
    );
  };

  const saveEntry = () => {
    if (!draft?.mood || !draft.weather || (!draft.body.trim() && !draft.images.length) || imageBusy)
      return;
    const saved: DiaryEntry = {
      day: activeDay,
      mood: draft.mood,
      weather: draft.weather,
      title: draft.title.trim() || `${dayLabel(activeDay)}的日记`,
      body: draft.body.trim(),
      images: draft.images.map((image) => ({ ...image })),
    };
    mutateShelf((next) => {
      const book = findBook(next, activeBook.id)!;
      const index = book.entries.findIndex((item) => item.day === activeDay);
      if (index === -1) book.entries.push(saved);
      else book.entries[index] = saved;
      delete book.drafts[activeDay];
      book.updatedAt = Date.now();
    });
    setNotice('这一页，已经好好收进日记本。');
    navigateWithinBook(`entry/${activeDay}`);
  };

  const filteredEntries = [...activeBook.entries]
    .sort((a, b) => b.day.localeCompare(a.day))
    .filter((item) =>
      `${item.title} ${item.body}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
    );

  return (
    <main
      className={`diary-page diary-book-page${opening ? ' is-opening' : ''}${closing ? ' is-closing' : ''}`}
      aria-labelledby="diary-title"
    >
      <header className="diary-book-heading">
        <div>
          <h1 id="diary-title">{activeBook.name}</h1>
          <p>一页今天，一页回忆。慢慢写，也慢慢翻。</p>
        </div>
        <div className="diary-book-actions">
          <button
            type="button"
            className="button button-secondary button-small"
            onClick={() => navigateWithinBook('history')}
          >
            {' '}
            <Icon name="book" /> 过往日记
          </button>
          <button
            type="button"
            className="button button-secondary button-small"
            onClick={() => {
              setNotebookName(activeBook.name);
              setDialog({ kind: 'rename', bookId: activeBook.id });
            }}
          >
            改个名字
          </button>
          <button
            type="button"
            className="button button-secondary button-small"
            onClick={closeBook}
          >
            <Icon name="book" /> 合上日记本
          </button>
        </div>
      </header>
      <p className={`diary-storage${storageState === 'error' ? ' has-error' : ''}`} role="status">
        {storageText}
      </p>
      {notice ? (
        <p className="status-note" role="status">
          {notice}
        </p>
      ) : null}
      {mode === 'edit' ? (
        <nav className="diary-book-tabs" aria-label="日记本的三个部分">
          {(['mood', 'weather', 'write'] as const).map((item) => (
            <button
              type="button"
              key={item}
              aria-current={step === item ? 'page' : undefined}
              onClick={() =>
                navigateWithinBook(`${section === 'edit' ? `edit/${activeDay}` : 'today'}/${item}`)
              }
            >
              <Icon name={item === 'mood' ? 'heart' : item === 'weather' ? 'sparkles' : 'edit'} />
              {item === 'mood' ? '选心情' : item === 'weather' ? '选天气' : '写日记'}
              {(item === 'mood' ? draft?.mood : item === 'weather' ? draft?.weather : false) ? (
                <span>已选</span>
              ) : null}
            </button>
          ))}
        </nav>
      ) : null}
      <div className={`diary-book${turning ? ` is-turning-${turning}` : ''}`}>
        <div className="diary-underpages" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        <div className="diary-book-pages">
          <aside className="diary-book-left">
            <p className="diary-book-caption">
              {activeBook.name}
              <span>日子慢慢，心事轻放</span>
            </p>
            <div className="diary-date-block">
              <time dateTime={activeDay}>
                {date.getFullYear()} 年 {date.getMonth() + 1} 月
              </time>
              <strong>{String(date.getDate()).padStart(2, '0')}</strong>
              <span>{date.toLocaleDateString('zh-CN', { weekday: 'long' })}</span>
            </div>
            <h2>
              {mode === 'history'
                ? '翻一翻，过去的自己。'
                : mode === 'read'
                  ? '那一天，也是珍贵的一页。'
                  : '今天，也值得被记住。'}
            </h2>
            <div className="diary-book-cat">
              {mode === 'history' ? (
                <p className="diary-history-count">
                  <strong>{activeBook.entries.length}</strong> 篇日记
                </p>
              ) : (
                <>
                  <CatArt mood={selectedMood?.id ?? 'relaxed'} />
                  <p>{selectedMood?.name ?? '慢慢感受，不急着选择。'}</p>
                </>
              )}
            </div>
            <p className="diary-book-note">
              不必写成一个完整的故事。
              <br />
              一点心情，一件小事，
              <br />
              就是今天留下的痕迹。
            </p>
            <div className="diary-day-meta">
              <span>
                <Icon name="heart" /> 心情：{selectedMood?.name ?? '待选择'}
              </span>
              <span>
                {selectedWeather ? (
                  <WeatherArt weather={selectedWeather.id} className="weather-mini" />
                ) : (
                  <Icon name="sparkles" />
                )}{' '}
                天气：{selectedWeather?.name ?? '待选择'}
              </span>
            </div>
          </aside>
          <section className="diary-book-right">
            <div className="diary-book-panel" key={`${location.pathname}-${step}`}>
              {mode === 'history' ? (
                <>
                  <h2>过往日记</h2>
                  <p>那些留给自己的文字，都在这里。</p>
                  <label className="diary-search">
                    <Icon name="search" />
                    <span className="visually-hidden">搜索日记标题或内容</span>
                    <input
                      value={search}
                      placeholder="搜索标题或内容"
                      onChange={(event) => setSearch(event.target.value)}
                    />
                  </label>
                  <div className="diary-record-list">
                    {filteredEntries.length ? (
                      filteredEntries.map((item) => {
                        const mood = moodOptions.find((option) => option.id === item.mood)!;
                        const weather = weatherOptions.find(
                          (option) => option.id === item.weather,
                        )!;
                        return (
                          <button
                            type="button"
                            className="diary-record"
                            key={item.day}
                            onClick={() => navigateWithinBook(`entry/${item.day}`)}
                          >
                            <span>
                              <strong>{item.title}</strong>
                              <time dateTime={item.day}>
                                {item.day.slice(5).replace('-', '月')}日
                              </time>
                            </span>
                            <p>
                              {item.body.replace(/\s+/g, ' ').slice(0, 75) ||
                                '把这一天，留在照片里。'}
                            </p>
                            <span>
                              <CatArt mood={mood.id} /> {mood.name}
                              <WeatherArt weather={weather.id} className="weather-mini" />{' '}
                              {weather.name}
                              {item.images.length ? ` · ${item.images.length} 张照片` : ''}
                            </span>
                          </button>
                        );
                      })
                    ) : (
                      <div className="diary-empty">
                        <Icon name="book" />
                        <h3>{search ? '没有找到相关日记' : '这里，等着你的第一篇日记'}</h3>
                        <p>
                          {search
                            ? '试试其他关键词，或清空搜索看看全部日记。'
                            : '不用写得很长，从今天的一件小事开始就好。'}
                        </p>
                      </div>
                    )}
                  </div>
                </>
              ) : mode === 'read' && entry ? (
                <article className="diary-reader">
                  <h1>{entry.title}</h1>
                  <div className="diary-reader-meta">
                    <span>
                      <CatArt mood={entry.mood} />
                      {moodOptions.find((item) => item.id === entry.mood)?.name}
                    </span>
                    <span>
                      <WeatherArt weather={entry.weather} className="weather-mini" />
                      {weatherOptions.find((item) => item.id === entry.weather)?.name}
                    </span>
                  </div>
                  <p>{entry.body}</p>
                  {entry.images.length ? (
                    <section>
                      <h2>这一天的小片刻</h2>
                      <DiaryPhotoGallery images={entry.images} />
                    </section>
                  ) : null}
                  <div className="diary-step-actions">
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() => navigateWithinBook('history')}
                    >
                      继续翻看
                    </button>
                    <button
                      type="button"
                      className="button"
                      onClick={() => navigateWithinBook(`edit/${entry.day}/write`)}
                    >
                      编辑这一页
                    </button>
                  </div>
                </article>
              ) : step === 'mood' && draft ? (
                <section>
                  <h2>今天，你更像哪只小猫？</h2>
                  <p>先听听自己的心情，什么感受都可以。</p>
                  <fieldset>
                    <legend className="visually-hidden">选择今天的心情</legend>
                    <div className="diary-mood-options">
                      {moodOptions.map((option) => (
                        <label
                          className="diary-mood-option"
                          data-mood={option.id}
                          style={{ '--cat-duration': option.duration } as CSSProperties}
                          key={option.id}
                        >
                          <input
                            type="radio"
                            name="diary-mood"
                            checked={draft.mood === option.id}
                            onChange={() =>
                              updateDraft((next) => {
                                next.mood = option.id;
                              })
                            }
                          />
                          <span>
                            <span className="diary-selected">已选择</span>
                            <CatArt mood={option.id} />
                            <strong>{option.name}</strong>
                          </span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <p className="diary-feedback">
                    {selectedMood
                      ? `${selectedMood.name} · ${selectedMood.hint}`
                      : '选一只最贴近今天感受的小猫。'}
                  </p>
                  <div className="diary-step-actions">
                    <span>给此刻的自己，一个位置。</span>
                    <button
                      type="button"
                      className="button"
                      disabled={!draft.mood}
                      onClick={() =>
                        navigateWithinBook(
                          `${section === 'edit' ? `edit/${activeDay}` : 'today'}/weather`,
                        )
                      }
                    >
                      接着选天气
                    </button>
                  </div>
                </section>
              ) : step === 'weather' && draft ? (
                <section>
                  <h2>窗外，是什么天气？</h2>
                  <p>晴天或雨天，都是这一天的小小背景。</p>
                  <fieldset>
                    <legend className="visually-hidden">选择今天的天气</legend>
                    <div className="diary-weather-options">
                      {weatherOptions.map((option) => (
                        <label
                          className="diary-weather-option"
                          key={option.id}
                          onPointerEnter={(event) =>
                            event.pointerType !== 'touch' && setMovingWeather(option.id)
                          }
                          onPointerLeave={() => setMovingWeather(null)}
                          onFocus={() => setMovingWeather(option.id)}
                          onBlur={() => setMovingWeather(null)}
                        >
                          <input
                            type="radio"
                            name="diary-weather"
                            checked={draft.weather === option.id}
                            onChange={() => {
                              animateWeather(option.id);
                              updateDraft((next) => {
                                next.weather = option.id;
                              });
                            }}
                          />
                          <span>
                            <span className="diary-selected">已选择</span>
                            <WeatherArt weather={option.id} moving={movingWeather === option.id} />
                            <strong>{option.name}</strong>
                            <small>{option.description}</small>
                          </span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <p className="diary-feedback">
                    {selectedWeather
                      ? `把${selectedWeather.name}也收进今天的这一页。`
                      : '选一个最接近今天的天气。'}
                  </p>
                  <div className="diary-step-actions">
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() =>
                        navigateWithinBook(
                          `${section === 'edit' ? `edit/${activeDay}` : 'today'}/mood`,
                        )
                      }
                    >
                      回到心情
                    </button>
                    <button
                      type="button"
                      className="button"
                      disabled={!draft.weather}
                      onClick={() =>
                        navigateWithinBook(
                          `${section === 'edit' ? `edit/${activeDay}` : 'today'}/write`,
                        )
                      }
                    >
                      开始写日记
                    </button>
                  </div>
                </section>
              ) : draft ? (
                <section>
                  <h2>这一页，写给自己。</h2>
                  <p>写几句话，或贴上今天的照片，都可以。</p>
                  <div className="diary-paper">
                    <label className="visually-hidden" htmlFor="diary-entry-title">
                      日记标题
                    </label>
                    <input
                      id="diary-entry-title"
                      value={draft.title}
                      placeholder="给今天起个名字（选填）"
                      onChange={(event) =>
                        updateDraft((next) => {
                          next.title = event.target.value.slice(0, 60);
                        })
                      }
                    />
                    <label className="visually-hidden" htmlFor="diary-body">
                      日记正文
                    </label>
                    <textarea
                      id="diary-body"
                      value={draft.body}
                      placeholder={'今天，发生了什么？\n\n也许是一件小事，也许只是一种感觉……'}
                      onChange={(event) =>
                        updateDraft((next) => {
                          next.body = event.target.value.slice(0, 10_000);
                        })
                      }
                    />
                  </div>
                  <div className="diary-editor-foot">
                    <span>
                      {draft.body || draft.title || draft.images.length
                        ? '文字会自动留在草稿里'
                        : '慢慢写，不着急。'}
                    </span>
                    <span>{draft.body.length} / 10000</span>
                  </div>
                  <section className="diary-images">
                    <header>
                      <h3>
                        <Icon name="image" /> 留几张今天的照片{' '}
                        <span>{draft.images.length} / 6</span>
                      </h3>
                      <label
                        className={`button button-secondary button-small${imageBusy || draft.images.length >= 6 ? ' is-disabled' : ''}`}
                      >
                        <Icon name="plus" /> 添加图片
                        <input
                          type="file"
                          accept="image/jpeg,image/png,image/webp,image/gif"
                          multiple
                          hidden
                          disabled={imageBusy || draft.images.length >= 6}
                          onChange={(event) => void addImages(event)}
                        />
                      </label>
                    </header>
                    <p>最多 6 张，每张不超过 10 MB · JPG、PNG、WebP、GIF</p>
                    <DiaryPhotoGallery
                      images={draft.images}
                      onRemove={(id) =>
                        updateDraft((next) => {
                          next.images = next.images.filter((image) => image.id !== id);
                        })
                      }
                    />
                    <p role="status">{imageStatus}</p>
                  </section>
                  <div className="diary-step-actions">
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={imageBusy}
                      onClick={() => setNotice('草稿已收好，可以稍后接着写。')}
                    >
                      暂存草稿
                    </button>
                    <button
                      type="button"
                      className="button"
                      disabled={
                        !draft.mood ||
                        !draft.weather ||
                        (!draft.body.trim() && !draft.images.length) ||
                        imageBusy
                      }
                      onClick={saveEntry}
                    >
                      保存这一页
                    </button>
                  </div>
                </section>
              ) : (
                <p>正在准备这一页…</p>
              )}
            </div>
          </section>
        </div>
        <span className="diary-binding" aria-hidden="true" />
        {dayIndex > 0 ? (
          <button
            type="button"
            className="diary-edge diary-edge-previous"
            onClick={() =>
              navigateWithinBook(
                entryOrDraftPath(activeBook, allDays[dayIndex - 1]!)
                  .replace(/^\/app\/diary\//, '')
                  .split('?')[0]!,
                'previous',
              )
            }
          >
            <Icon name="chevron-left" />
            <span>前一页</span>
            <small>{allDays[dayIndex - 1]!.slice(5).replace('-', '/')}</small>
          </button>
        ) : null}
        {dayIndex >= 0 && dayIndex < allDays.length - 1 ? (
          <button
            type="button"
            className="diary-edge diary-edge-next"
            onClick={() =>
              navigateWithinBook(
                entryOrDraftPath(activeBook, allDays[dayIndex + 1]!)
                  .replace(/^\/app\/diary\//, '')
                  .split('?')[0]!,
                'next',
              )
            }
          >
            <Icon name="chevron-right" />
            <span>后一页</span>
            <small>{allDays[dayIndex + 1]!.slice(5).replace('-', '/')}</small>
          </button>
        ) : null}
        {opening || closing ? (
          <div className="diary-cover-motion" aria-hidden="true">
            <span>给自己的日记</span>
            <strong>{activeBook.name}</strong>
            <CatArt mood="sleepy" />
            <p>
              一点心情，一件小事。
              <br />
              慢慢写，慢慢记。
            </p>
          </div>
        ) : null}
      </div>
      <footer className="diary-reading-footer">
        <span>
          {mode === 'history' ? `${activeBook.entries.length} 篇日记` : dayLabel(activeDay, true)}
        </span>
        {activeDay !== today ? (
          <button type="button" onClick={() => navigateWithinBook('today/mood')}>
            回到今天 <Icon name="arrow-right" />
          </button>
        ) : null}
      </footer>
      <p className="diary-bottom-note">点击两侧露出的页边，翻一翻以前的日记。</p>
      <ConfirmDialog
        open={dialog !== null}
        title="给日记本换个名字"
        confirmLabel="保存名字"
        confirmDisabled={!notebookName.trim() || codePointLength(notebookName.trim()) > 24}
        onClose={() => setDialog(null)}
        onConfirm={submitNotebookName}
      >
        <label htmlFor="notebook-name-open">日记本名字</label>
        <input
          id="notebook-name-open"
          value={notebookName}
          onChange={(event) => setNotebookName(event.target.value)}
        />
        <p>{codePointLength(notebookName.trim())} / 24</p>
      </ConfirmDialog>
    </main>
  );
}
