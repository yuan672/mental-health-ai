import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { CatArt } from '../shared/cat-art';

const transitionDurationMs = 720;
const fadeDurationMs = 140;

const routeTitles: ReadonlyArray<readonly [string, string]> = [
  ['/app/chat/incognito', '无痕对话'],
  ['/app/chat', '聊一聊'],
  ['/app/mood', '心情记录'],
  ['/app/diary', '日记本'],
  ['/app/knowledge', '心理知识'],
  ['/app/profile', '账号信息'],
  ['/app/privacy', '隐私与数据'],
  ['/app/home', '首页'],
  ['/login', '登录'],
  ['/register', '注册'],
  ['/', '首页'],
];

function routeIdentity(pathname: string): string {
  const match = routeTitles.find(([prefix]) =>
    prefix === '/' ? pathname === '/' : pathname.startsWith(prefix),
  );
  return match?.[0] ?? pathname;
}

function routeTitle(pathname: string): string {
  return (
    routeTitles.find(([prefix]) =>
      prefix === '/' ? pathname === '/' : pathname.startsWith(prefix),
    )?.[1] ?? '安心支持'
  );
}

function motionIsReduced(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

export function PageTransition({ children }: { children: ReactNode }) {
  const location = useLocation();
  const contentRef = useRef<HTMLDivElement>(null);
  const previousRouteRef = useRef<string | null>(null);
  const sequenceRef = useRef(0);
  const [transition, setTransition] = useState<
    Readonly<{ sequence: number; title: string; leaving: boolean }> | undefined
  >();
  const identity = useMemo(() => routeIdentity(location.pathname), [location.pathname]);

  useEffect(() => {
    const previous = previousRouteRef.current;
    previousRouteRef.current = identity;
    if (previous === null || previous === identity || motionIsReduced()) return;

    const sequence = ++sequenceRef.current;
    const content = contentRef.current;
    const shouldMoveFocus = content?.contains(document.activeElement) ?? false;
    if (content) {
      content.inert = true;
      content.setAttribute('aria-busy', 'true');
    }
    setTransition({ sequence, title: routeTitle(identity), leaving: false });

    const leaveTimer = globalThis.setTimeout(() => {
      if (sequenceRef.current !== sequence) return;
      if (content) {
        content.inert = false;
        content.removeAttribute('aria-busy');
        content.classList.add('page-content-arriving');
      }
      setTransition((current) =>
        current?.sequence === sequence ? { ...current, leaving: true } : current,
      );
      if (shouldMoveFocus && content) {
        const target = content.querySelector<HTMLElement>('h1, h2, main');
        if (target) {
          const previousTabIndex = target.getAttribute('tabindex');
          target.tabIndex = -1;
          target.focus({ preventScroll: true });
          target.addEventListener(
            'blur',
            () => {
              if (previousTabIndex === null) target.removeAttribute('tabindex');
              else target.setAttribute('tabindex', previousTabIndex);
            },
            { once: true },
          );
        }
      }
    }, transitionDurationMs);

    const finishTimer = globalThis.setTimeout(() => {
      if (sequenceRef.current !== sequence) return;
      setTransition(undefined);
      content?.classList.remove('page-content-arriving');
    }, transitionDurationMs + fadeDurationMs);

    return () => {
      globalThis.clearTimeout(leaveTimer);
      globalThis.clearTimeout(finishTimer);
      if (content) {
        content.inert = false;
        content.removeAttribute('aria-busy');
        content.classList.remove('page-content-arriving');
      }
    };
  }, [identity]);

  return (
    <>
      <div ref={contentRef} id="app-content-root">
        {children}
      </div>
      {transition ? (
        <div
          className={`page-cat-loader${transition.leaving ? ' is-leaving' : ''}`}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <div className="page-cat-loader-content">
            <div className="page-cat-loader-scene" aria-hidden="true">
              <span className="page-cat-loader-halo" />
              <span className="page-cat-loader-shadow" />
              <CatArt mood="happy" className="page-cat-loader-cat" />
              <span className="page-cat-confetti page-cat-confetti-one" />
              <span className="page-cat-confetti page-cat-confetti-two" />
              <span className="page-cat-confetti page-cat-confetti-three" />
              <span className="page-cat-confetti page-cat-confetti-four" />
            </div>
            <p className="page-cat-loader-greeting">小猫带路，马上就好</p>
            <p className="page-cat-loader-destination">正在打开 · {transition.title}</p>
            <span className="page-cat-loader-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          </div>
        </div>
      ) : null}
    </>
  );
}
