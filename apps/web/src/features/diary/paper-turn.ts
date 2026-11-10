import { copyBookSurface, runBookTimeline, skipBookMotion } from './book-motion';

// The approved smooth-paper prototype: connected projected patches, not a rigid panel.
export const PAPER_TURN_MS = 820;
const PAPER_BEND = 0.72;
type Direction = 'forward' | 'back';
type Point = { x: number; y: number; z: number };
type Quad = [Point, Point, Point, Point];
export function paperMatrix([p0, p1, p2, p3]: Quad, width: number, height: number) {
  const dx1 = p1.x - p2.x,
    dx2 = p3.x - p2.x,
    dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y,
    dy2 = p3.y - p2.y,
    dy3 = p0.y - p1.y + p2.y - p3.y;
  const determinant = dx1 * dy2 - dx2 * dy1;
  let g = 0,
    h = 0;
  if (Math.abs(determinant) > 0.000001) {
    g = (dx3 * dy2 - dx2 * dy3) / determinant;
    h = (dx1 * dy3 - dx3 * dy1) / determinant;
  }
  return [
    (p1.x - p0.x + g * p1.x) / width,
    (p1.y - p0.y + g * p1.y) / width,
    0,
    g / width,
    (p3.x - p0.x + h * p3.x) / height,
    (p3.y - p0.y + h * p3.y) / height,
    0,
    h / height,
    0,
    0,
    1,
    0,
    p0.x,
    p0.y,
    0,
    1,
  ];
}
export function paperGeometry(
  width: number,
  height: number,
  count: number,
  progress: number,
  direction: Direction,
  hinge: number,
  top = 0,
) {
  const sign = direction === 'forward' ? 1 : -1;
  const wave = Math.sin(Math.PI * progress),
    step = width / count;
  const distance = Math.max(1200, width * 4.4),
    middle = top + height / 2;
  const rows = [0, 1].map((row) => {
    const points: Point[] = [];
    let x = 0,
      z = 0;
    for (let i = 0; i <= count; i++) {
      if (i) {
        const u = (i - 0.5) / count;
        const angle = Math.max(
          0,
          Math.min(
            Math.PI,
            Math.PI * progress + wave * (PAPER_BEND * (2 * u - 1) + 0.18 * u * (row - 0.5)),
          ),
        );
        x += Math.cos(angle) * step;
        z += Math.sin(angle) * step;
      }
      const u = i / count,
        lift = wave * u * u * (row ? 18 : 3);
      const depth = z * 0.8,
        scale = distance / (distance - depth);
      points.push({
        x: hinge + sign * x * scale,
        y: middle + (top + row * height - lift - middle) * scale,
        z: depth,
      });
    }
    return points;
  });
  return Array.from({ length: count }, (_, i) => {
    const u = (i + 0.5) / count;
    const angle = Math.max(
      0,
      Math.min(Math.PI, Math.PI * progress + wave * PAPER_BEND * (2 * u - 1)),
    );
    // Each row has count + 1 vertices, shared by its adjacent patches.
    const points: Quad =
      sign === 1
        ? [rows[0]![i]!, rows[0]![i + 1]!, rows[1]![i + 1]!, rows[1]![i]!]
        : [rows[0]![i + 1]!, rows[0]![i]!, rows[1]![i]!, rows[1]![i + 1]!];
    return {
      points,
      angle,
      back: Math.cos(angle) < 0,
      depth: points.reduce((sum, point) => sum + point.z, 0) / 4,
    };
  });
}
export function paperShade(progress: number, u: number) {
  const angle = Math.max(
    0,
    Math.min(Math.PI, Math.PI * progress + Math.sin(Math.PI * progress) * PAPER_BEND * (2 * u - 1)),
  );
  return Math.sin(angle) ** 2 * 0.05;
}
export function stablePaperMatrix(matrix: number[], width: number, height: number) {
  const g = matrix[3] ?? NaN,
    h = matrix[7] ?? NaN;
  return (
    matrix.every(Number.isFinite) &&
    [1, 1 + g * width, 1 + h * height, 1 + g * width + h * height].every((value) => value > 0.03)
  );
}
const div = (className: string, parent?: HTMLElement) => {
  const node = document.createElement('div');
  node.className = className;
  parent?.append(node);
  return node;
};
function snapshot(page: HTMLElement, width: number, height: number) {
  const copy = copyBookSurface(page);
  copy.classList.add('book-curl-copy');
  Object.assign(copy.style, { width: `${width}px`, height: `${height}px` });
  return copy;
}
export function paperStripCount(width: number, height: number) {
  // Keep a continuous curved surface, but avoid 128 complete DOM trees per turn.
  return Math.max(24, Math.min(height > 2200 ? 28 : 40, Math.ceil(width / 20)));
}
type Strip = {
  strip: HTMLDivElement;
  front: HTMLDivElement;
  back: HTMLDivElement;
  leftLight: HTMLDivElement;
  rightLight: HTMLDivElement;
  reversed: boolean;
  visible: boolean;
};
export function capturePaperTurn(book: HTMLElement, direction: Direction) {
  if (skipBookMotion()) return null;
  const left = book.querySelector<HTMLElement>('.paper-left');
  const right = book.querySelector<HTMLElement>('.paper-right');
  if (!left || !right || right.offsetTop > left.offsetTop + 10) return null;
  const page = direction === 'forward' ? right : left;
  const bookRect = book.getBoundingClientRect(),
    rect = page.getBoundingClientRect();
  if (rect.width < 20 || rect.height < 20) return null;
  const width = rect.width,
    height = rect.height;
  const count = paperStripCount(width, height);
  const step = width / count;
  const layer = div('book-curl-surface');
  layer.inert = true;
  layer.setAttribute('aria-hidden', 'true');
  const shadow = div('book-curl-shadow', layer);
  Object.assign(shadow.style, {
    left: '0px',
    top: `${rect.top - bookRect.top}px`,
    width: `${width * 0.86}px`,
    height: `${height}px`,
    opacity: '0',
  });
  // Capture only one page on the navigation path. Prepare the curved strips in
  // small batches after mounting, with this flat page covering preparation.
  const preview = div('book-curl-preview', layer);
  Object.assign(preview.style, {
    left: `${rect.left - bookRect.left}px`,
    top: `${rect.top - bookRect.top}px`,
    width: `${width}px`,
    height: `${height}px`,
  });
  const source = snapshot(page, width, height);
  source.style.left = '0px';
  preview.append(source);
  // Kept detached until the destination is mounted. The source remains readable
  // while its next page is fetched, without a blank frame or duplicate live inputs.
  return {
    width,
    height,
    top: rect.top - bookRect.top,
    hinge: (direction === 'forward' ? rect.left : rect.right) - bookRect.left,
    count,
    step,
    direction,
    layer,
    shadow,
    preview,
    source,
    strips: [] as Strip[],
  };
}
type Surface = NonNullable<ReturnType<typeof capturePaperTurn>>;
function paintPaper(surface: Surface, progress: number) {
  const { width, height, count, direction, hinge, top } = surface;
  paperGeometry(width, height, count, progress, direction, hinge, top).forEach((part, i) => {
    const piece = surface.strips[i];
    if (!piece) return;
    const matrix = paperMatrix(part.points, surface.step, height);
    const visible = stablePaperMatrix(matrix, surface.step, height);
    if (piece.visible !== visible) {
      piece.strip.style.visibility = visible ? 'visible' : 'hidden';
      piece.visible = visible;
    }
    piece.strip.style.transform = `matrix3d(${matrix.join(',')})`;
    if (piece.reversed !== part.back) {
      piece.front.style.opacity = part.back ? '0' : '1';
      piece.back.style.opacity = part.back ? '1' : '0';
      piece.reversed = part.back;
    }
    const leftShade = paperShade(progress, (direction === 'forward' ? i : i + 1) / count);
    const rightShade = paperShade(progress, (direction === 'forward' ? i + 1 : i) / count);
    // Static gradients are rasterized once. Their endpoint opacity provides the
    // same gentle light field without repainting every page strip on every frame.
    piece.leftLight.style.opacity = String(leftShade);
    piece.rightLight.style.opacity = String(rightShade);
  });
  const spread = Math.sin(Math.PI * progress);
  const center =
    hinge + (direction === 'forward' ? 1 : -1) * Math.cos(Math.PI * progress) * width * 0.32;
  Object.assign(surface.shadow.style, {
    opacity: String(spread * 0.18),
    transform: `translate3d(${center - width * 0.43}px,0,0) scaleX(${1 - spread * 0.4})`,
  });
}

function preparationFrame(signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted || skipBookMotion()) {
      resolve(false);
      return;
    }
    let finished = false;
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const done = (ready: boolean) => {
      if (finished) return;
      finished = true;
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      window.removeEventListener('resize', cancel);
      document.removeEventListener('visibilitychange', visibility);
      preference.removeEventListener('change', reduce);
      resolve(ready);
    };
    const cancel = () => done(false);
    const visibility = () => {
      if (document.hidden) cancel();
    };
    const reduce = () => {
      if (preference.matches) cancel();
    };
    const frame = requestAnimationFrame(() => done(true));
    // Hidden or suspended documents must not keep the editor inert indefinitely.
    const timer = setTimeout(cancel, 500);
    signal.addEventListener('abort', cancel, { once: true });
    window.addEventListener('resize', cancel, { once: true });
    document.addEventListener('visibilitychange', visibility);
    preference.addEventListener('change', reduce);
  });
}

function restoreScroll(copy: HTMLElement) {
  copy.querySelectorAll<HTMLElement>('[data-book-scroll-top]').forEach((field) => {
    field.scrollTop = Number(field.dataset.bookScrollTop);
  });
}

async function preparePaper(surface: Surface, destination: HTMLElement, signal: AbortSignal) {
  const { width, height, count, step, direction } = surface;
  surface.strips.forEach((piece) => piece.strip.remove());
  surface.strips = [];
  surface.preview.hidden = false;
  restoreScroll(surface.source);
  // Snapshot the destination once too; do not repeatedly walk the live React page.
  const reverse = snapshot(destination, width, height);
  let index = 0;
  while (index < count) {
    if (!(await preparationFrame(signal))) return false;
    const started = performance.now();
    let batch = 0;
    do {
      const i = index++;
      const strip = div('book-curl-strip', surface.layer);
      Object.assign(strip.style, {
        width: `${step + 0.4}px`,
        height: `${height}px`,
        visibility: 'hidden',
        // Depth increases from the spine to the free edge throughout this curl.
        // Keep that order fixed instead of invalidating stacking every frame.
        zIndex: String(20 + i),
      });
      const front = div('book-curl-face book-curl-front', strip);
      const back = div('book-curl-face book-curl-back', strip);
      front.style.opacity = '1';
      back.style.opacity = '0';
      const frontCopy = snapshot(surface.source, width, height);
      frontCopy.style.left = `${-(direction === 'forward' ? i : count - 1 - i) * step}px`;
      front.append(frontCopy);
      const backCopy = snapshot(reverse, width, height);
      backCopy.style.left = `${-(direction === 'forward' ? count - 1 - i : i) * step}px`;
      back.append(backCopy);
      // A detached template has no scroll offset; preserve the original metadata.
      reverse
        .querySelectorAll<HTMLElement>('[data-book-scroll-top]')
        .forEach((field, fieldIndex) => {
          const target =
            backCopy.querySelectorAll<HTMLElement>('[data-book-scroll-top]')[fieldIndex];
          if (target) target.dataset.bookScrollTop = field.dataset.bookScrollTop;
        });
      restoreScroll(frontCopy);
      restoreScroll(backCopy);
      surface.strips.push({
        strip,
        front,
        back,
        leftLight: div('book-curl-light book-curl-light-left', strip),
        rightLight: div('book-curl-light book-curl-light-right', strip),
        reversed: false,
        visible: false,
      });
      batch++;
    } while (index < count && batch < 4 && performance.now() - started < 5);
  }
  // Put the finished strips in their first pose before starting the clock. The
  // old page remains on top during layer preparation, so no partial sheet flashes.
  paintPaper(surface, 0);
  if (!(await preparationFrame(signal))) return false;
  surface.preview.hidden = true;
  return true;
}
export async function playPaperTurn(
  root: HTMLElement,
  book: HTMLElement,
  surface: Surface | null,
  signal: AbortSignal,
) {
  if (signal.aborted || skipBookMotion()) return;
  const wasInert = root.inert;
  root.inert = true;
  book.setAttribute('aria-busy', 'true');
  const compact = !surface;
  book.classList.add(compact ? 'is-curl-compact' : 'is-curling');
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    surface?.layer.remove();
    book.classList.remove('is-curling', 'is-curl-compact');
    book.removeAttribute('aria-busy');
    root.inert = wasInert;
  };
  signal.addEventListener('abort', cleanup, { once: true });
  try {
    if (surface) {
      // Retain paper height after landing, so a short entry does not snap the book shut vertically.
      book.style.minHeight = `${Math.max(book.offsetHeight, surface.height + 16)}px`;
      const destination = book.querySelector<HTMLElement>(
        surface.direction === 'forward' ? '.paper-left' : '.paper-right',
      );
      if (!destination) {
        return;
      }
      book.append(surface.layer);
      if (!(await preparePaper(surface, destination, signal))) return;
    }
    await runBookTimeline(
      compact ? 240 : PAPER_TURN_MS,
      (progress) => {
        if (surface) paintPaper(surface, 0.5 - Math.cos(Math.PI * progress) / 2);
      },
      signal,
    );
  } finally {
    signal.removeEventListener('abort', cleanup);
    cleanup();
  }
}
