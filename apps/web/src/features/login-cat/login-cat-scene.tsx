import { useEffect, useRef, useState } from 'react';
import { createLoginCatMotion, type CatState } from './motion.mjs';
import { createLoginCatWatercolorRenderer } from './watercolor.mjs';
import room from '../../assets/cozy/login-room.png';
import fallback from '../../assets/cozy/login-cat-watercolor-rest.png';
import openParts from '../../assets/cozy/login-cat-watercolor-neck-v2.png';
import closedParts from '../../assets/cozy/login-cat-watercolor-parts-closed-v1.png';

export function LoginCatScene() {
  const sceneRef = useRef<HTMLDivElement>(null),
    canvasRef = useRef<HTMLCanvasElement>(null),
    controller = useRef<{ caught: () => void } | null>(null);
  const [state, setState] = useState<CatState>('rest'),
    [ready, setReady] = useState(false);
  useEffect(() => {
    const scene = sceneRef.current,
      canvas = canvasRef.current;
    if (!scene || !canvas) return;
    const model = createLoginCatMotion(),
      media = window.matchMedia('(prefers-reduced-motion: reduce)');
    let disposed = false,
      frame = 0,
      last = 0,
      active: HTMLInputElement | null = null,
      renderer: ReturnType<typeof createLoginCatWatercolorRenderer> = null;
    let sleepTimer: ReturnType<typeof setTimeout> | undefined;
    const set = (next: CatState) => {
      model.setState(next);
      setState(next);
      if (media.matches) renderer?.draw(model.step(0));
    };
    const target = () => {
      if (!active) return;
      const a = active.getBoundingClientRect(),
        b = scene.getBoundingClientRect();
      if (b.width)
        model.lookAt({
          x: ((a.left + a.width * 0.5 - b.left) * 1487) / b.width,
          y: ((a.top + a.height * 0.5 - b.top) * 1058) / b.height,
        });
    };
    const tick = (time: number) => {
      frame = 0;
      if (disposed || document.hidden) return;
      target();
      renderer?.draw(model.step(last ? time - last : 16.67));
      last = time;
      if (!media.matches) frame = requestAnimationFrame(tick);
    };
    const start = () => {
      if (!disposed && !frame && renderer && !document.hidden) {
        last = 0;
        frame = requestAnimationFrame(tick);
      }
    };
    const stop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
    };
    const look = (e: Event) => {
      const field = e.target;
      if (
        !(field instanceof HTMLInputElement) ||
        !['login-email', 'login-password'].includes(field.id)
      )
        return;
      active = field;
      clearTimeout(sleepTimer);
      target();
      model.nudge();
      set('peek');
      start();
    };
    const caught = () => {
      clearTimeout(sleepTimer);
      set('caught');
      start();
      sleepTimer = setTimeout(() => {
        set('sleep');
        start();
      }, 150);
    };
    controller.current = { caught };
    const visibility = () => {
      if (document.hidden) stop();
      else start();
    };
    const reduce = () => {
      model.setReduced(media.matches);
      stop();
      renderer?.draw(model.step(0));
      if (!media.matches) start();
    };
    model.setReduced(media.matches);
    const image = (src: string) =>
      new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
      });
    const initialize = () =>
      Promise.all([image(openParts), image(closedParts)])
        .then(([open, closed]) => {
          if (disposed) return;
          renderer = createLoginCatWatercolorRenderer(canvas, { open, closed });
          if (renderer) {
            setReady(true);
            renderer.draw(model.step(0));
            start();
          }
        })
        .catch(() => {
          if (!disposed) setReady(false);
        });
    const lost = (e: Event) => {
      e.preventDefault();
      stop();
      renderer?.dispose();
      renderer = null;
      setReady(false);
    };
    const restored = () => {
      void initialize();
    };
    void initialize();
    document.addEventListener('focusin', look);
    document.addEventListener('input', look);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('resize', target);
    media.addEventListener('change', reduce);
    canvas.addEventListener('webglcontextlost', lost);
    canvas.addEventListener('webglcontextrestored', restored);
    return () => {
      disposed = true;
      stop();
      clearTimeout(sleepTimer);
      renderer?.dispose();
      controller.current = null;
      document.removeEventListener('focusin', look);
      document.removeEventListener('input', look);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('resize', target);
      media.removeEventListener('change', reduce);
      canvas.removeEventListener('webglcontextlost', lost);
      canvas.removeEventListener('webglcontextrestored', restored);
    };
  }, []);
  return (
    <div className="login-scene" ref={sceneRef} data-cat-state={state} data-rig-ready={ready}>
      <img className="login-room-image" src={room} alt="" />
      <img className="login-cat-fallback" src={fallback} alt="" hidden={ready} />
      <canvas
        ref={canvasRef}
        className="login-cat-canvas"
        width="810"
        height="680"
        aria-hidden="true"
        style={{ visibility: ready ? 'visible' : 'hidden' }}
      />
      <span className="login-cat-caption">
        {state === 'peek'
          ? '让我悄悄看一眼……'
          : state === 'caught' || state === 'sleep'
            ? '呼……我已经睡着啦。'
            : '慢慢来，小猫在。'}
      </span>
      <span className="login-cat-zzz" aria-hidden="true">
        <i>z</i>
        <i>z</i>
        <i>z</i>
      </span>
      <button
        className="login-cat-hotspot"
        type="button"
        aria-label="摸摸小猫，让它假装睡觉"
        onPointerEnter={() => controller.current?.caught()}
        onFocus={() => controller.current?.caught()}
        onClick={() => controller.current?.caught()}
      />
    </div>
  );
}
