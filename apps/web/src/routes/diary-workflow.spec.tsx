import type {
  DiaryContent,
  DiaryNotebook,
  DiaryPage as Page,
  DiaryPhoto,
} from '@mental-health/types';
import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';
import { DiaryPage } from './diary-page';

const api = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn(),
  entries: vi.fn(),
  page: vi.fn(),
  save: vi.fn(),
  upload: vi.fn(),
  removePhoto: vi.fn(),
  photoUrl: (id: string, photo: string) =>
    `http://localhost:3001/diary/notebooks/${id}/photos/${photo}`,
}));
vi.mock('../api/diary', () => ({ diaryApi: api }));
// Exercise data and interaction state only; rendered motion remains for manual acceptance.
vi.mock('../features/diary/book-motion', () => ({
  BOOK_OPEN_MS: 1680,
  BOOK_CLOSE_MS: 880,
  createBookModel: () => null,
  skipBookMotion: () => true,
  waitForRouteCat: async () => true,
  runBookTimeline: async () => true,
  captureNotebookReturn: () => null,
  disposeNotebookReturn: vi.fn(),
  returnNotebookToShelf: async () => true,
}));
const day = '2026-09-13';
const book: DiaryNotebook = {
  id: '96000000-0000-4000-8000-000000000001',
  name: '合成日记',
  cat: 'relaxed',
  revision: 1,
  createdAt: `${day}T00:00:00Z`,
  updatedAt: `${day}T00:00:00Z`,
};
const content: DiaryContent = {
  title: '',
  body: '合成正文',
  mood: 'happy',
  weather: 'sun',
  photoIds: [],
};
const empty: Page = { day, revision: 0, saved: null, draft: null, photos: [], updatedAt: null };
let stored: Page;
let books: DiaryNotebook[];
beforeEach(() => {
  vi.resetAllMocks();
  stored = structuredClone(empty);
  books = [structuredClone(book)];
  api.list.mockImplementation(async () => ({ data: { books: structuredClone(books) } }));
  api.entries.mockImplementation(async () => ({ data: { book, entries: [], nextBefore: null } }));
  api.page.mockImplementation(async () => ({ data: { page: structuredClone(stored) } }));
  api.save.mockImplementation(
    async (
      _id: string,
      _day: string,
      input: { expectedRevision: number; content: DiaryContent; publish: boolean },
    ) => {
      expect(input.expectedRevision).toBe(stored.revision);
      stored = {
        ...stored,
        revision: stored.revision + 1,
        saved: input.publish ? structuredClone(input.content) : stored.saved,
        draft: input.publish ? null : structuredClone(input.content),
      };
      return { data: { page: structuredClone(stored) } };
    },
  );
  api.upload.mockImplementation(async (_id: string, _day: string, file: File, id: string) => {
    const photo: DiaryPhoto = { id, name: file.name, mime: file.type, size: file.size };
    stored.photos.push(photo);
    return { data: { photo } };
  });
  api.removePhoto.mockResolvedValue({ data: { deleted: true } });
});
function mount(path = `/app/diary/${book.id}/${day}`) {
  const router = createMemoryRouter(
    [{ path: '/app/diary/:bookId?/:day?', element: <DiaryPage /> }],
    { initialEntries: [path] },
  );
  const view = render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
  return { ...view, router };
}
async function write() {
  fireEvent.click(await screen.findByRole('button', { name: '开心' }));
  fireEvent.click(screen.getByRole('button', { name: /接着选天气/u }));
  fireEvent.click(await screen.findByRole('button', { name: '晴天' }));
  fireEvent.click(screen.getByRole('button', { name: /开始写日记/u }));
  return await screen.findByLabelText('日记正文');
}

it('uses the same notebook ID when retrying an unconfirmed create and opens the named notebook', async () => {
  books = [];
  api.create
    .mockRejectedValueOnce(new Error('合成网络中断'))
    .mockImplementation(async (input: Partial<DiaryNotebook>) => ({
      data: { book: { ...book, ...input } },
    }));
  const { router } = mount('/app/diary');
  await screen.findByRole('heading', { name: '给今天，留一个小小的位置。' });
  fireEvent.click(screen.getByRole('button', { name: '新建日记本' }));
  fireEvent.change(screen.getByLabelText('日记本名字'), { target: { value: '🐱'.repeat(25) } });
  expect(screen.getByRole('button', { name: '放到书架上' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('日记本名字'), { target: { value: '合成小书' } });
  fireEvent.click(screen.getByRole('button', { name: '期待' }));
  fireEvent.click(screen.getByRole('button', { name: '放到书架上' }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: '放到书架上' }));
  await screen.findByRole('group', { name: '选择小猫心情' });
  expect(api.create).toHaveBeenCalledTimes(2);
  expect(api.create.mock.calls[0]![0]).toEqual(api.create.mock.calls[1]![0]);
  expect(api.create.mock.calls[1]![0]).toMatchObject({ name: '合成小书', cat: 'hopeful' });
  expect(router.state.location.pathname).toContain(api.create.mock.calls[0]![0].id);
});

it('renames a notebook and requires confirmation to delete the current revision', async () => {
  api.rename.mockImplementation(
    async (
      _id: string,
      input: { name: string; cat: DiaryNotebook['cat']; expectedRevision: number },
    ) => {
      expect(input.expectedRevision).toBe(1);
      books = [{ ...book, name: input.name, cat: input.cat, revision: 2 }];
      return { data: { book: books[0] } };
    },
  );
  api.remove.mockImplementation(async () => {
    books = [];
    return { data: { deleted: true } };
  });
  mount('/app/diary');
  fireEvent.click(await screen.findByRole('button', { name: '改个名字' }));
  fireEvent.change(screen.getByLabelText('日记本名字'), { target: { value: '改名后的合成日记' } });
  fireEvent.click(screen.getByRole('button', { name: '保存名字' }));
  await screen.findByRole('link', { name: '打开改名后的合成日记' });
  fireEvent.click(screen.getByRole('button', { name: '删除' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }));
  expect(api.remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '删除' }));
  fireEvent.click(screen.getByRole('button', { name: '删除日记本' }));
  await waitFor(() =>
    expect(screen.queryByRole('link', { name: '打开改名后的合成日记' })).not.toBeInTheDocument(),
  );
  expect(api.remove).toHaveBeenCalledWith(book.id, 2);
});

it('uploads, previews, and saves a photo-only diary, then reads the photo after remount', async () => {
  const view = mount();
  await write();
  expect(screen.getByRole('button', { name: '保存这一页' })).toBeDisabled();
  await userEvent.upload(
    screen.getByLabelText('添加照片'),
    new File(['synthetic'], 'synthetic.png', { type: 'image/png' }),
  );
  fireEvent.click(await screen.findByRole('button', { name: '查看照片：synthetic.png' }));
  expect(
    within(screen.getByRole('dialog')).getByRole('img', { name: 'synthetic.png' }),
  ).toHaveAttribute('src', api.photoUrl(book.id, stored.photos[0]!.id));
  fireEvent.click(screen.getByRole('button', { name: '看好了' }));
  fireEvent.click(screen.getByRole('button', { name: '保存这一页' }));
  await screen.findByText('这一页已经保存好了。');
  expect(stored.saved).toMatchObject({
    body: '',
    mood: 'happy',
    weather: 'sun',
    photoIds: [stored.photos[0]!.id],
  });
  expect(stored.draft).toBeNull();
  view.unmount();
  mount();
  await screen.findByRole('button', { name: '查看照片：synthetic.png' });
  expect(screen.queryByLabelText('日记正文')).not.toBeInTheDocument();
});

it('retains published content while a separate draft is saved and resumes that draft after remount', async () => {
  stored = { ...empty, revision: 1, saved: structuredClone(content) };
  const view = mount();
  fireEvent.click(await screen.findByRole('button', { name: '编辑这一页' }));
  fireEvent.change(screen.getByLabelText('日记正文'), { target: { value: '仅草稿中的合成内容' } });
  fireEvent.click(screen.getByRole('button', { name: '暂存草稿' }));
  await screen.findByText('草稿已保存到账号。');
  expect(stored.saved?.body).toBe('合成正文');
  expect(stored.draft?.body).toBe('仅草稿中的合成内容');
  view.unmount();
  mount();
  await screen.findByText('合成正文');
  expect(screen.queryByText('仅草稿中的合成内容')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '继续编辑草稿' }));
  expect(screen.getByLabelText('日记正文')).toHaveValue('仅草稿中的合成内容');
});

it('reuses an upload ID after a lost response and rejects excess or oversized photo selections before uploading', async () => {
  mount();
  await write();
  api.upload.mockRejectedValueOnce(new Error('合成上传响应丢失'));
  await userEvent.upload(
    screen.getByLabelText('添加照片'),
    new File(['synthetic'], 'retry.png', { type: 'image/png' }),
  );
  fireEvent.click(await screen.findByRole('button', { name: '重试这张照片' }));
  await screen.findByRole('button', { name: '查看照片：retry.png' });
  expect(api.upload.mock.calls[0]![3]).toBe(api.upload.mock.calls[1]![3]);
  const extra = Array.from(
    { length: 6 },
    (_, i) => new File(['x'], `extra-${i}.png`, { type: 'image/png' }),
  );
  await userEvent.upload(screen.getByLabelText('添加照片'), extra);
  expect(await screen.findByRole('alert')).toHaveTextContent('一页最多选 6 张照片');
  const large = new File(['x'], 'large.png', { type: 'image/png' });
  Object.defineProperty(large, 'size', { value: 10 * 1024 * 1024 + 1 });
  await userEvent.upload(screen.getByLabelText('添加照片'), large);
  expect(await screen.findByRole('alert')).toHaveTextContent('每张照片请小于 10 MB');
  expect(api.upload).toHaveBeenCalledTimes(2);
});

it('preserves unsaved input after a save failure and rereads the authoritative revision before allowing another save', async () => {
  mount();
  const body = await write();
  fireEvent.change(body, { target: { value: '网络异常时保留的合成文字' } });
  api.save.mockRejectedValueOnce(new Error('合成保存失败'));
  fireEvent.click(screen.getByRole('button', { name: '保存这一页' }));
  await screen.findByRole('alert');
  expect(body).toHaveValue('网络异常时保留的合成文字');
  expect(screen.getByRole('button', { name: '保存这一页' })).toBeDisabled();
  stored = { ...stored, revision: 3, saved: content };
  fireEvent.click(screen.getByRole('button', { name: '核对服务器内容' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '保存这一页' })).toBeEnabled());
  expect(body).toHaveValue('网络异常时保留的合成文字');
  fireEvent.click(screen.getByRole('button', { name: '保存这一页' }));
  await screen.findByText('这一页已经保存好了。');
  expect(api.save.mock.calls[1]![2].expectedRevision).toBe(3);
  expect(stored.saved?.body).toBe('网络异常时保留的合成文字');
});
