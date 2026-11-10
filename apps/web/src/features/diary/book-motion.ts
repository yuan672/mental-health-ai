import type { DiaryNotebook } from '@mental-health/types';

// Ported from the approved prototype's DIARY-ENTRANCE / notebook-return motion.
export const BOOK_OPEN_MS = 1680;
export const BOOK_CLOSE_MS = 880;
export const BOOK_RETURN_MS = 620;
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)');
export const skipBookMotion = () => reducedMotion().matches || document.hidden;
export function bookEase(value: number) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * t * (t * (t * 6 - 15) + 10);
}
export function bookPose(progress: number) {
  const cover = Math.PI * bookEase((progress - 0.025) / 0.69);
  const flyleaf = Math.PI * bookEase((progress - 0.105) / 0.755);
  const page = Math.PI * bookEase((progress - 0.18) / 0.8);
  return {
    cover,
    leaves: [
      {
        angle: flyleaf,
        bend: Math.min(0.14 * Math.sin(flyleaf), (cover - flyleaf) * 0.24, (flyleaf - page) * 0.24),
        thickness: 3,
      },
      {
        angle: page,
        bend: Math.min(
          0.18 * Math.sin(page),
          (flyleaf - page) * 0.28,
          page * 0.25,
          (Math.PI - page) * 0.25,
        ),
        thickness: 0.6,
      },
    ],
  };
}
export function bookPaper(
  width: number,
  count: number,
  pose: ReturnType<typeof bookPose>['leaves'][number],
) {
  // Thickness rotates with the normal, so the hinges stay separated at 90°.
  let x = -pose.thickness * Math.sin(pose.angle);
  let z = pose.thickness * Math.cos(pose.angle);
  return Array.from({ length: count }, (_, i) => {
    const angle = pose.angle + Math.max(0, pose.bend) * Math.cos((Math.PI * (i + 0.5)) / count);
    const start = { x, z, angle };
    x += (Math.cos(angle) * width) / count;
    z += (Math.sin(angle) * width) / count;
    return { ...start, endX: x, endZ: z };
  });
}

let copySequence = 0;
export function copyBookSurface<T extends HTMLElement>(source: T): T {
  const copy = source.cloneNode(true) as T;
  const fields = source.querySelectorAll<
    HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
  >('input,textarea,select');
  copy
    .querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      'input,textarea,select',
    )
    .forEach((field, i) => {
      const original = fields.item(i);
      if (!original) return;
      field.value = original.value;
      if (field instanceof HTMLInputElement && original instanceof HTMLInputElement)
        field.checked = original.checked;
      if (field instanceof HTMLTextAreaElement) field.textContent = original.value;
      field.dataset.bookScrollTop = String(original.scrollTop);
    });
  // Each sheet copy must keep its own SVG crop IDs; deleting or duplicating them
  // makes the watercolor sprite leak or resolve to another cat's clipping region.
  const ids = new Map<string, string>();
  const prefix = `book-copy-${++copySequence}-`;
  const nodes = [copy, ...copy.querySelectorAll('*')];
  for (const node of nodes) {
    if (node.id) {
      ids.set(node.id, `${prefix}${ids.size}`);
      node.id = ids.get(node.id) ?? '';
    }
    for (const name of [
      'for',
      'autofocus',
      'aria-labelledby',
      'aria-describedby',
      'aria-controls',
      'aria-live',
    ])
      node.removeAttribute(name);
    if (node.matches('a,button,input,select,textarea,[tabindex]'))
      node.setAttribute('tabindex', '-1');
  }
  for (const node of nodes)
    for (const attr of Array.from(node.attributes)) {
      let value = attr.value.replace(/url\(#([^)]+)\)/g, (match, id: string) =>
        ids.has(id) ? `url(#${ids.get(id)})` : match,
      );
      if (
        (attr.name === 'href' || attr.name === 'xlink:href') &&
        value.startsWith('#') &&
        ids.has(value.slice(1))
      )
        value = `#${ids.get(value.slice(1))}`;
      if (value !== attr.value) node.setAttribute(attr.name, value);
    }
  copy.inert = true;
  copy.setAttribute('aria-hidden', 'true');
  return copy;
}

function element(className: string, parent?: HTMLElement) {
  const node = document.createElement('div');
  node.className = className;
  parent?.append(node);
  return node;
}

export function createBookModel(root: HTMLElement, book: HTMLElement) {
  const left = book.querySelector<HTMLElement>('.paper-left');
  const right = book.querySelector<HTMLElement>('.paper-right');
  const coverTemplate = book.querySelector<HTMLElement>('.book-motion-cover-template');
  if (!left || !right || !coverTemplate || book.clientWidth < 40) return null;
  const compact = right.offsetTop > left.offsetTop + 10;
  const width = compact ? (book.clientWidth - 14) / 2 : left.offsetWidth;
  const height = compact ? width * 1.48 : left.offsetHeight;
  const layer = element('diary-entry-model');
  Object.assign(layer.style, {
    left: `${left.offsetLeft}px`,
    top: `${left.offsetTop}px`,
    width: `${width * 2}px`,
    height: `${height}px`,
    perspective: `${Math.max(2400, width * 8, height * 4)}px`,
  });
  layer.inert = true;
  layer.setAttribute('aria-hidden', 'true');
  const ground = element('diary-entry-ground', layer);
  const world = element('diary-entry-world', layer);
  element('diary-entry-back-cover', world);
  element('diary-entry-right-stack', world);
  const rightPage = element('diary-entry-right-page', world);
  const cover = element('diary-entry-cover', world);
  const face = copyBookSurface(coverTemplate);
  face.hidden = false;
  face.className = 'diary-entry-cover-front';
  cover.append(face);
  element('diary-entry-cover-back', cover);
  element('diary-entry-cover-edge', cover);
  const pageCopy = (source: HTMLElement) => {
    const copy = copyBookSurface(source);
    copy.classList.add('diary-entry-page-copy');
    Object.assign(copy.style, { left: '0px', width: `${width}px`, height: `${height}px` });
    return copy;
  };
  if (!compact) rightPage.append(pageCopy(right));
  else element('diary-entry-compact-note', rightPage).textContent = '今天，也值得被记住。';
  const count = compact ? 24 : 40;
  const step = width / count;
  const leaves = [0, 1].map((sheet) =>
    Array.from({ length: count }, (_, i) => {
      const strip = element('diary-entry-paper-strip', world);
      strip.style.width = `${step + 0.25}px`;
      element('diary-entry-paper-front', strip);
      const back = element('diary-entry-paper-back', strip);
      if (sheet === 1 && !compact) {
        const copy = pageCopy(left);
        copy.style.left = `${-(width - (i + 1) * step)}px`;
        back.append(copy);
      }
      return strip;
    }),
  );
  const wasInert = root.inert;
  const wasBusy = root.getAttribute('aria-busy');
  let disposed = false;
  book.append(layer);
  root.classList.add('diary-motion-active');
  root.inert = true;
  root.setAttribute('aria-busy', 'true');
  return {
    root,
    layer,
    face,
    paint(progress: number) {
      const pose = bookPose(progress);
      cover.style.transform = `translate3d(${-9 * Math.sin(pose.cover)}px,0,${9 * Math.cos(pose.cover)}px) rotateY(${-pose.cover}rad)`;
      leaves.forEach((strips, index) => {
        const leaf = pose.leaves[index];
        if (!leaf) return;
        bookPaper(width, count, leaf).forEach((part, i) => {
          const strip = strips[i];
          if (!strip) return;
          strip.style.transform = `translate3d(${width + part.x}px,0,${part.z}px) rotateY(${-part.angle}rad)`;
          strip.style.setProperty('--entry-shade', String(Math.sin(part.angle) ** 2 * 0.055));
        });
      });
      const reach = Math.max(0, -Math.cos(pose.cover));
      ground.style.left = `${50 - reach * 50}%`;
      ground.style.width = `${50 + reach * 50}%`;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      layer.remove();
      root.classList.remove('diary-motion-active');
      root.inert = wasInert;
      if (wasBusy === null) root.removeAttribute('aria-busy');
      else root.setAttribute('aria-busy', wasBusy);
    },
  };
}

// Time-based motion preserves every intermediate pose at the display refresh rate.
// Aborting never invokes navigation; resize / reduced motion settle at the endpoint.
export function runBookTimeline(
  duration: number,
  paint: (progress: number) => void,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const preference = reducedMotion();
    let frame = 0;
    let start: number | null = null;
    let finished = false;
    const done = (complete: boolean) => {
      if (finished) return;
      finished = true;
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      window.removeEventListener('resize', settle);
      document.removeEventListener('visibilitychange', onVisibility);
      preference.removeEventListener('change', onPreference);
      if (complete) paint(1);
      resolve(complete);
    };
    const abort = () => done(false);
    const settle = () => done(true);
    const onVisibility = () => {
      if (document.hidden) settle();
    };
    const onPreference = () => {
      if (preference.matches) settle();
    };
    if (skipBookMotion()) {
      paint(1);
      resolve(true);
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    window.addEventListener('resize', settle, { once: true });
    document.addEventListener('visibilitychange', onVisibility);
    preference.addEventListener('change', onPreference);
    const tick = (now: number) => {
      start ??= now;
      const progress = Math.min(1, (now - start) / duration);
      paint(progress);
      if (progress < 1) frame = requestAnimationFrame(tick);
      else done(true);
    };
    const timer = setTimeout(settle, duration + 450);
    paint(0);
    frame = requestAnimationFrame(tick);
  });
}

export async function waitForRouteCat(signal: AbortSignal) {
  if (signal.aborted) return false;
  if (skipBookMotion()) return true;
  const curtain = document.querySelector<HTMLElement>('.route-cat-curtain');
  const animations =
    curtain?.getAnimations?.().filter((animation) => animation.playState !== 'finished') ?? [];
  return new Promise<boolean>((resolve) => {
    const preference = reducedMotion();
    const done = () => {
      signal.removeEventListener('abort', done);
      document.removeEventListener('visibilitychange', onVisibility);
      preference.removeEventListener('change', onPreference);
      resolve(!signal.aborted);
    };
    const onVisibility = () => {
      if (document.hidden) done();
    };
    const onPreference = () => {
      if (preference.matches) done();
    };
    signal.addEventListener('abort', done, { once: true });
    document.addEventListener('visibilitychange', onVisibility);
    preference.addEventListener('change', onPreference);
    void Promise.all(animations.map((animation) => animation.finished.catch(() => undefined))).then(
      done,
    );
  });
}

export type NotebookReturn = ReturnType<typeof captureNotebookReturn>;
export function captureNotebookReturn(
  model: NonNullable<ReturnType<typeof createBookModel>>,
  bookId: string,
  books: DiaryNotebook[],
) {
  const source = model.face.getBoundingClientRect();
  const sourceCover = copyBookSurface(model.face);
  const flight = element('notebook-return-flight');
  flight.inert = true;
  flight.setAttribute('aria-hidden', 'true');
  Object.assign(flight.style, {
    left: `${source.left}px`,
    top: `${source.top}px`,
    width: `${source.width}px`,
    height: `${source.height}px`,
  });
  sourceCover.classList.add('notebook-return-source');
  Object.assign(sourceCover.style, { width: `${source.width}px`, height: `${source.height}px` });
  flight.append(sourceCover);
  // Keep the old heading behind the closed cover until the shelf begins arriving.
  const oldLayer = element('notebook-return-old');
  const rootRect = model.root.getBoundingClientRect();
  Object.assign(oldLayer.style, {
    left: `${rootRect.left}px`,
    top: `${rootRect.top}px`,
    width: `${rootRect.width}px`,
    height: `${rootRect.height}px`,
  });
  // Only retain the surrounding text. Cloning the entire animated model here
  // would duplicate all paper strips just as the book is starting to return.
  const oldRoot = document.createElement('main');
  oldRoot.className = model.root.className;
  for (const child of Array.from(model.root.children)) {
    if (
      child instanceof HTMLElement &&
      child.matches('.cozy-page-heading,.diary-feedback,.diary-history')
    )
      oldRoot.append(copyBookSurface(child));
  }
  const rootStyle = getComputedStyle(model.root);
  Object.assign(oldRoot.style, {
    padding: rootStyle.padding,
    margin: '0',
    width: '100%',
    boxSizing: 'border-box',
  });
  oldLayer.append(oldRoot);
  oldLayer.inert = true;
  oldLayer.setAttribute('aria-hidden', 'true');
  document.body.append(oldLayer, flight);
  return { bookId, books, source, sourceCover, flight, oldLayer };
}
export function disposeNotebookReturn(returning: NotebookReturn) {
  returning.flight.remove();
  returning.oldLayer.remove();
}
export async function returnNotebookToShelf(
  root: HTMLElement,
  returning: NotebookReturn,
  signal: AbortSignal,
) {
  if (signal.aborted) {
    disposeNotebookReturn(returning);
    return false;
  }
  const { source, sourceCover, flight, oldLayer } = returning;
  const target = Array.from(root.querySelectorAll<HTMLElement>('[data-notebook-id]')).find(
    (node) => node.dataset.notebookId === returning.bookId,
  );
  if (!target || source.width < 20 || skipBookMotion()) {
    disposeNotebookReturn(returning);
    return !signal.aborted;
  }
  const destination = target.getBoundingClientRect();
  if (destination.width < 20 || destination.height < 20) {
    disposeNotebookReturn(returning);
    return !signal.aborted;
  }
  const arrival = copyBookSurface(target);
  arrival.classList.add('notebook-return-destination');
  flight.querySelector('.notebook-return-destination')?.remove();
  flight.append(arrival);
  document.body.append(oldLayer, flight);
  Object.assign(flight.style, {
    width: `${destination.width}px`,
    height: `${destination.height}px`,
  });
  sourceCover.style.transform = `scale(${destination.width / source.width},${destination.height / source.height})`;
  const wasInert = root.inert;
  root.inert = true;
  root.classList.add('notebook-returning');
  target.classList.add('notebook-cover-in-flight');
  const cleanup = () => {
    disposeNotebookReturn(returning);
    target.classList.remove('notebook-cover-in-flight');
    root.classList.remove('notebook-returning');
    root.style.removeProperty('--shelf-arrival');
    root.inert = wasInert;
  };
  // Synchronous abort cleanup also makes React Strict Mode effect replay safe.
  signal.addEventListener('abort', cleanup, { once: true });
  const scaleX = source.width / destination.width;
  const scaleY = source.height / destination.height;
  const scrollFrom = window.scrollY;
  const ceiling = Math.max(
    24,
    (document.querySelector('.app-header')?.getBoundingClientRect().bottom ?? 0) + 20,
  );
  const floor = window.innerHeight - 32;
  const delta =
    destination.top < ceiling
      ? destination.top - ceiling
      : destination.bottom > floor
        ? Math.min(destination.top - ceiling, destination.bottom - floor)
        : 0;
  const scrollEnd = Math.max(
    0,
    Math.min(scrollFrom + delta, document.documentElement.scrollHeight - window.innerHeight),
  );
  const complete = await runBookTimeline(
    BOOK_RETURN_MS,
    (progress) => {
      const eased = bookEase(progress);
      if (Math.abs(scrollEnd - scrollFrom) > 2)
        window.scrollTo({
          top: scrollFrom + (scrollEnd - scrollFrom) * eased,
          behavior: 'instant',
        });
      const rect = target.getBoundingClientRect();
      flight.style.transform = `translate3d(${(rect.left - source.left) * eased}px,${(rect.top - source.top) * eased - 12 * Math.sin(Math.PI * progress)}px,0) scale(${scaleX + (1 - scaleX) * eased},${scaleY + (1 - scaleY) * eased})`;
      const blend = bookEase((progress - 0.12) / 0.62);
      sourceCover.style.opacity = String(1 - blend);
      arrival.style.opacity = String(blend);
      root.style.setProperty('--shelf-arrival', String(bookEase(progress / 0.85)));
      oldLayer.style.opacity = String(1 - bookEase(progress / 0.6));
    },
    signal,
  );
  signal.removeEventListener('abort', cleanup);
  if (!complete) return false;
  cleanup();
  if (complete && target.isConnected) target.focus({ preventScroll: true });
  return complete;
}
