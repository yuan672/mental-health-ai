export type DiaryMood =
  'happy' | 'sad' | 'angry' | 'surprised' | 'shy' | 'sleepy' | 'hopeful' | 'relaxed';

export type DiaryWeather =
  'sun' | 'partly' | 'cloud' | 'drizzle' | 'rain' | 'thunder' | 'snow' | 'wind' | 'fog';

export type DiaryPhoto = Readonly<{ id: string; name: string; src: string }>;

export type DiaryEntry = Readonly<{
  day: string;
  weather: DiaryWeather;
  mood: DiaryMood;
  title: string;
  body: string;
  images: DiaryPhoto[];
}>;

export type DiaryDraft = {
  day: string;
  weather: DiaryWeather | '';
  mood: DiaryMood | '';
  title: string;
  body: string;
  images: DiaryPhoto[];
};

export type DiaryNotebook = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  entries: DiaryEntry[];
  drafts: Record<string, DiaryDraft>;
};

export type DiaryShelf = {
  userId: string;
  activeId: string;
  closed: boolean;
  books: DiaryNotebook[];
};

const databaseName = 'cozy-diary-notebooks';
const databaseVersion = 2;
const storeName = 'user-shelves';
const imagePattern = /^data:image\/(?:jpeg|png|webp|gif);base64,/i;

export function createDiaryId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
}

export function emptyDiaryShelf(userId: string): DiaryShelf {
  const notebook: DiaryNotebook = {
    id: createDiaryId('notebook'),
    name: '给自己的日记',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    entries: [],
    drafts: {},
  };
  return { userId, activeId: notebook.id, closed: false, books: [notebook] };
}

function isDay(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isMood(value: unknown): value is DiaryMood {
  return (
    typeof value === 'string' &&
    ['happy', 'sad', 'angry', 'surprised', 'shy', 'sleepy', 'hopeful', 'relaxed'].includes(value)
  );
}

function isWeather(value: unknown): value is DiaryWeather {
  return (
    typeof value === 'string' &&
    ['sun', 'partly', 'cloud', 'drizzle', 'rain', 'thunder', 'snow', 'wind', 'fog'].includes(value)
  );
}

function parsePhotos(value: unknown): DiaryPhoto[] | null {
  if (!Array.isArray(value) || value.length > 6) return null;
  const photos: DiaryPhoto[] = [];
  for (const photo of value) {
    if (
      !photo ||
      typeof photo !== 'object' ||
      typeof photo.id !== 'string' ||
      typeof photo.name !== 'string' ||
      typeof photo.src !== 'string' ||
      photo.name.length > 260 ||
      photo.src.length > 14_500_000 ||
      !imagePattern.test(photo.src)
    ) {
      return null;
    }
    photos.push({ id: photo.id, name: photo.name, src: photo.src });
  }
  return photos;
}

function parseEntry(value: unknown): DiaryEntry | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  const images = parsePhotos(entry.images ?? []);
  if (
    !isDay(entry.day) ||
    !isWeather(entry.weather) ||
    !isMood(entry.mood) ||
    typeof entry.title !== 'string' ||
    typeof entry.body !== 'string' ||
    entry.title.length > 60 ||
    entry.body.length > 10_000 ||
    !images
  ) {
    return null;
  }
  return { ...entry, images } as DiaryEntry;
}

function parseDraft(value: unknown): DiaryDraft | null {
  if (!value || typeof value !== 'object') return null;
  const draft = value as Record<string, unknown>;
  const images = parsePhotos(draft.images ?? []);
  if (
    !isDay(draft.day) ||
    !(draft.weather === '' || isWeather(draft.weather)) ||
    !(draft.mood === '' || isMood(draft.mood)) ||
    typeof draft.title !== 'string' ||
    typeof draft.body !== 'string' ||
    draft.title.length > 60 ||
    draft.body.length > 10_000 ||
    !images
  ) {
    return null;
  }
  return { ...draft, images } as DiaryDraft;
}

function parseNotebook(value: unknown): DiaryNotebook | null {
  if (!value || typeof value !== 'object') return null;
  const book = value as Record<string, unknown>;
  if (
    typeof book.id !== 'string' ||
    typeof book.name !== 'string' ||
    Array.from(book.name.trim()).length > 24 ||
    typeof book.createdAt !== 'number' ||
    typeof book.updatedAt !== 'number' ||
    !Array.isArray(book.entries) ||
    !book.drafts ||
    typeof book.drafts !== 'object'
  ) {
    return null;
  }
  const entries = book.entries.map(parseEntry);
  if (entries.some((entry) => !entry)) return null;
  const drafts: Record<string, DiaryDraft> = {};
  for (const [day, value] of Object.entries(book.drafts)) {
    const draft = parseDraft(value);
    if (!draft || draft.day !== day) return null;
    drafts[day] = draft;
  }
  return {
    id: book.id,
    name: book.name,
    createdAt: book.createdAt,
    updatedAt: book.updatedAt,
    entries: entries as DiaryEntry[],
    drafts,
  };
}

function parseShelf(value: unknown, userId: string): DiaryShelf | null {
  if (!value || typeof value !== 'object') return null;
  const shelf = value as Record<string, unknown>;
  if (
    shelf.userId !== userId ||
    typeof shelf.activeId !== 'string' ||
    typeof shelf.closed !== 'boolean' ||
    !Array.isArray(shelf.books) ||
    shelf.books.length === 0 ||
    shelf.books.length > 30
  ) {
    return null;
  }
  const books = shelf.books.map(parseNotebook);
  if (books.some((book) => !book) || !books.some((book) => book?.id === shelf.activeId)) {
    return null;
  }
  return {
    userId,
    activeId: shelf.activeId,
    closed: shelf.closed,
    books: books as DiaryNotebook[],
  };
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error('DIARY_STORAGE_UNAVAILABLE'));
      return;
    }
    let settled = false;
    const request = globalThis.indexedDB.open(databaseName, databaseVersion);
    const timer = globalThis.setTimeout(() => finish(new Error('DIARY_STORAGE_TIMEOUT')), 5_000);
    const finish = (error?: Error, database?: IDBDatabase) => {
      if (settled) {
        database?.close();
        return;
      }
      settled = true;
      globalThis.clearTimeout(timer);
      if (error) reject(error);
      else resolve(database!);
    };
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(storeName)) {
        database.createObjectStore(storeName, { keyPath: 'userId' });
      }
    };
    request.onerror = () => finish(request.error ?? new Error('DIARY_STORAGE_UNAVAILABLE'));
    request.onblocked = () => finish(new Error('DIARY_STORAGE_BUSY'));
    request.onsuccess = () => finish(undefined, request.result);
  });
}

export async function loadDiaryShelf(userId: string): Promise<DiaryShelf> {
  const database = await openDatabase();
  try {
    const value = await new Promise<unknown>((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readonly');
      const request = transaction.objectStore(storeName).get(userId);
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = transaction.onerror = () =>
        reject(transaction.error ?? new Error('DIARY_STORAGE_READ_FAILED'));
    });
    if (value === undefined) return emptyDiaryShelf(userId);
    const parsed = parseShelf(value, userId);
    if (!parsed) throw new Error('DIARY_STORAGE_INVALID');
    return parsed;
  } finally {
    database.close();
  }
}

export async function saveDiaryShelf(shelf: DiaryShelf): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readwrite');
      transaction.objectStore(storeName).put(shelf);
      transaction.oncomplete = () => resolve();
      transaction.onabort = transaction.onerror = () =>
        reject(transaction.error ?? new Error('DIARY_STORAGE_WRITE_FAILED'));
    });
  } finally {
    database.close();
  }
}
