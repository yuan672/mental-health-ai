import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bookPaper,
  bookPose,
  copyBookSurface,
  runBookTimeline,
  waitForRouteCat,
} from './book-motion';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('book motion geometry (no browser rendering)', () => {
  it('keeps cover, flyleaf and inner page ordered through the whole turn', () => {
    for (let frame = 0; frame <= 240; frame++) {
      const { cover, leaves } = bookPose(frame / 240);
      const [flyleaf, page] = leaves;
      expect(flyleaf).toBeDefined();
      expect(page).toBeDefined();
      if (!flyleaf || !page) throw new Error('Missing sheet');
      expect(cover).toBeGreaterThanOrEqual(flyleaf.angle);
      expect(flyleaf.angle).toBeGreaterThanOrEqual(page.angle);
      expect(flyleaf.angle + flyleaf.bend).toBeLessThanOrEqual(cover + 1e-10);
      expect(flyleaf.angle - flyleaf.bend).toBeGreaterThanOrEqual(page.angle + page.bend - 1e-10);
      expect(page.angle - page.bend).toBeGreaterThanOrEqual(-1e-10);
      expect(page.angle + page.bend).toBeLessThanOrEqual(Math.PI + 1e-10);
    }
  });
  it('joins curved strips continuously and lands flat on the opposite side of the spine', () => {
    for (const progress of [0, 0.2, 0.45, 0.7, 1]) {
      for (const pose of bookPose(progress).leaves) {
        const pieces = bookPaper(500, 40, pose);
        pieces.forEach((piece, i) => {
          const next = pieces[i + 1];
          if (next) {
            expect(next.x).toBeCloseTo(piece.endX, 10);
            expect(next.z).toBeCloseTo(piece.endZ, 10);
          }
          expect(Math.hypot(piece.endX - piece.x, piece.endZ - piece.z)).toBeCloseTo(12.5, 10);
        });
        if (progress === 1) {
          expect(pieces.at(-1)?.endX).toBeCloseTo(-500, 8);
          expect(pieces.at(-1)?.endZ).toBeCloseTo(-pose.thickness, 8);
        }
      }
    }
  });
  it('copies current text and keeps watercolor crop references unique in every sheet', () => {
    const source = document.createElement('section');
    source.innerHTML =
      '<textarea>saved text</textarea><svg viewBox="0 0 10 10"><defs><clipPath id="cat-crop"><rect width="10" height="10"/></clipPath></defs><image clip-path="url(#cat-crop)"/></svg>';
    const field = source.querySelector('textarea');
    if (!field) throw new Error('Missing test field');
    field.value = 'unsaved synthetic text';
    const a = copyBookSurface(source);
    const b = copyBookSurface(source);
    const aId = a.querySelector('clipPath')?.id;
    const bId = b.querySelector('clipPath')?.id;
    expect(aId).toBeTruthy();
    expect(aId).not.toBe(bId);
    expect(a.querySelector('image')).toHaveAttribute('clip-path', `url(#${aId})`);
    expect(b.querySelector('image')).toHaveAttribute('clip-path', `url(#${bId})`);
    expect(a.querySelector('textarea')?.value).toBe('unsaved synthetic text');
    expect(a.querySelector('textarea')).toHaveAttribute('tabindex', '-1');
    expect(a).toHaveAttribute('aria-hidden', 'true');
    expect(source.querySelector('clipPath')?.id).toBe('cat-crop');
  });
});

function frameClock() {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  let callback: FrameRequestCallback | undefined;
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((next: FrameRequestCallback) => {
      callback = next;
      return 1;
    }),
  );
  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn(() => {
      callback = undefined;
    }),
  );
  return (time: number) => {
    const next = callback;
    callback = undefined;
    next?.(time);
  };
}

describe('book motion lifecycle', () => {
  it('uses elapsed time and waits for the final pose', async () => {
    const frame = frameClock();
    const paint = vi.fn();
    const controller = new AbortController();
    const finished = runBookTimeline(880, paint, controller.signal);
    frame(100);
    frame(430);
    expect(paint).toHaveBeenLastCalledWith(330 / 880);
    frame(980);
    await expect(finished).resolves.toBe(true);
    expect(paint).toHaveBeenLastCalledWith(1);
  });
  it('aborts without painting the endpoint or triggering a later completion', async () => {
    const frame = frameClock();
    const paint = vi.fn();
    const controller = new AbortController();
    const finished = runBookTimeline(880, paint, controller.signal);
    frame(0);
    frame(100);
    controller.abort();
    await expect(finished).resolves.toBe(false);
    frame(1500);
    expect(paint).toHaveBeenLastCalledWith(100 / 880);
  });
  it('settles safely on resize instead of leaving an inert book', async () => {
    frameClock();
    const paint = vi.fn();
    const finished = runBookTimeline(880, paint, new AbortController().signal);
    window.dispatchEvent(new Event('resize'));
    await expect(finished).resolves.toBe(true);
    expect(paint).toHaveBeenLastCalledWith(1);
  });
  it('waits for the cat curtain to finish before allowing the book to open', async () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const curtain = document.createElement('div');
    curtain.className = 'route-cat-curtain';
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    Object.defineProperty(curtain, 'getAnimations', {
      value: () => [{ playState: 'running', finished }],
    });
    document.body.append(curtain);
    const settled = vi.fn();
    const waiting = waitForRouteCat(new AbortController().signal).then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    finish();
    await waiting;
    expect(settled).toHaveBeenCalledWith(true);
  });
  it('releases the curtain wait when the route is abandoned', async () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const curtain = document.createElement('div');
    curtain.className = 'route-cat-curtain';
    Object.defineProperty(curtain, 'getAnimations', {
      value: () => [{ playState: 'running', finished: new Promise(() => {}) }],
    });
    document.body.append(curtain);
    const controller = new AbortController();
    const waiting = waitForRouteCat(controller.signal);
    controller.abort();
    await expect(waiting).resolves.toBe(false);
  });
});
