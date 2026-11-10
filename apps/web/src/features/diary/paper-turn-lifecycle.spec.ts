import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { capturePaperTurn, playPaperTurn, PAPER_TURN_MS } from './paper-turn';

const mocks = vi.hoisted(() => ({ timeline: vi.fn() }));
vi.mock('./book-motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./book-motion')>()),
  runBookTimeline: mocks.timeline,
}));

let frames: Map<number, FrameRequestCallback>;
let sequence: number;
let finish: () => void;
let paint: (progress: number) => void;
beforeEach(() => {
  vi.clearAllMocks();
  frames = new Map();
  sequence = 0;
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  // A deterministic work budget tests batch size, not this machine's speed.
  vi.spyOn(performance, 'now').mockReturnValue(0);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++sequence, callback);
    return sequence;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  mocks.timeline.mockImplementation(
    (_duration: number, draw: typeof paint, signal: AbortSignal) => {
      paint = draw;
      paint(0);
      return new Promise<boolean>((resolve) => {
        finish = () => {
          paint(1);
          resolve(true);
        };
        signal.addEventListener('abort', () => resolve(false), { once: true });
      });
    },
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function fixture() {
  const root = document.createElement('main');
  root.inert = false;
  const book = document.createElement('div');
  book.className = 'diary-book';
  root.append(book);
  const left = document.createElement('section');
  left.className = 'paper-page paper-left';
  const right = document.createElement('section');
  right.className = 'paper-page paper-right';
  for (const [i, page] of [left, right].entries()) {
    page.innerHTML = `<textarea>saved synthetic text</textarea><svg><defs><clipPath id="cat-${i}"><rect width="20" height="20"/></clipPath></defs><image clip-path="url(#cat-${i})"/></svg>`;
    page.querySelector('textarea')!.value = `current synthetic text ${i}`;
    page.querySelector('textarea')!.scrollTop = 32 + i;
    page.getBoundingClientRect = () => new DOMRect(i * 640, 8, 640, 900);
  }
  book.append(left, right);
  book.getBoundingClientRect = () => new DOMRect(0, 0, 1280, 916);
  Object.defineProperty(book, 'offsetHeight', { value: 916 });
  document.body.append(root);
  const surface = capturePaperTurn(book, 'forward');
  if (!surface) throw new Error('Synthetic surface missing');
  return { root, book, left, right, surface };
}
async function frame() {
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach((callback) => callback(16));
  await Promise.resolve();
  await Promise.resolve();
}
async function prepare() {
  for (let i = 0; i < 12 && !mocks.timeline.mock.calls.length; i++) await frame();
  expect(mocks.timeline).toHaveBeenCalledTimes(1);
}

describe('paper turn work budget and lifecycle (no browser rendering)', () => {
  it('captures one source tree and prepares at most four strip pairs between yields', async () => {
    const { root, book, surface } = fixture();
    expect(surface.count).toBe(32);
    expect(surface.layer.querySelectorAll('.book-curl-copy')).toHaveLength(1);
    expect(surface.strips).toHaveLength(0);
    const complete = playPaperTurn(root, book, surface, new AbortController().signal);
    expect(root.inert).toBe(true);
    expect(surface.preview.hidden).toBe(false);
    expect(surface.strips).toHaveLength(0);
    await frame();
    expect(surface.strips).toHaveLength(4);
    expect(surface.preview.hidden).toBe(false);
    await prepare();
    expect(surface.strips).toHaveLength(32);
    expect(surface.preview.hidden).toBe(true);
    expect(mocks.timeline).toHaveBeenCalledWith(
      PAPER_TURN_MS,
      expect.any(Function),
      expect.any(AbortSignal),
    );
    const ids = [...surface.layer.querySelectorAll('[id]')].map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const piece of surface.strips) {
      expect(piece.front.querySelector('textarea')!.value).toBe('current synthetic text 1');
      expect(piece.back.querySelector('textarea')!.value).toBe('current synthetic text 0');
      expect(piece.front.querySelector('textarea')!.scrollTop).toBe(33);
      expect(piece.back.querySelector('textarea')!.scrollTop).toBe(32);
    }
    finish();
    await complete;
    expect(root.inert).toBe(false);
    expect(book).not.toHaveAttribute('aria-busy');
    expect(surface.layer.isConnected).toBe(false);
  });

  it('does not rewrite layout, stacking, gradients or display while the paper is moving', async () => {
    const { root, book, surface } = fixture();
    const complete = playPaperTurn(root, book, surface, new AbortController().signal);
    await prepare();
    const style = (node: HTMLElement) => ({
      left: node.style.left,
      top: node.style.top,
      width: node.style.width,
      height: node.style.height,
      zIndex: node.style.zIndex,
      background: node.style.background,
      display: node.style.display,
    });
    const nodes = [
      surface.shadow,
      ...surface.strips.flatMap((piece) => [
        piece.strip,
        piece.front,
        piece.back,
        piece.leftLight,
        piece.rightLight,
      ]),
    ];
    const original = nodes.map(style);
    for (const progress of [0.1, 0.4, 0.5, 0.7, 0.9]) {
      paint(progress);
      expect(nodes.map(style)).toEqual(original);
      expect(surface.strips.every((piece) => !piece.front.hidden && !piece.back.hidden)).toBe(true);
    }
    finish();
    await complete;
  });

  it.each(['abort', 'resize', 'visibilitychange'] as const)(
    'releases the page if %s happens during preparation',
    async (event) => {
      const { root, book, surface } = fixture();
      const controller = new AbortController();
      const complete = playPaperTurn(root, book, surface, controller.signal);
      await frame();
      expect(surface.strips.length).toBeLessThan(surface.count);
      if (event === 'abort') controller.abort();
      else if (event === 'resize') window.dispatchEvent(new Event('resize'));
      else {
        vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
        document.dispatchEvent(new Event('visibilitychange'));
      }
      await complete;
      expect(root.inert).toBe(false);
      expect(surface.layer.isConnected).toBe(false);
      expect(frames.size).toBe(0);
      expect(mocks.timeline).not.toHaveBeenCalled();
      expect(book).not.toHaveAttribute('aria-busy');
    },
  );

  it('does not let cleanup from an aborted preparation cancel StrictMode replay', async () => {
    const { root, book, surface } = fixture();
    const controller = new AbortController();
    const first = playPaperTurn(root, book, surface, controller.signal);
    await frame();
    controller.abort();
    const second = playPaperTurn(root, book, surface, new AbortController().signal);
    await first;
    expect(root.inert).toBe(true);
    expect(surface.layer.isConnected).toBe(true);
    await prepare();
    finish();
    await second;
    expect(root.inert).toBe(false);
    expect(surface.layer.isConnected).toBe(false);
  });
});
