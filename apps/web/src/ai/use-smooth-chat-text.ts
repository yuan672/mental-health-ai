import { useEffect, useRef, useState } from 'react';
import type { ChatStreamState } from './chat-stream-state';

const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' });

// Presentation only: stream.text already contains server-approved content.
// Protocol state, persistence, cancellation and recovery keep using the full text.
export function useSmoothChatText(stream: ChatStreamState) {
  const operationId = stream.turnId ?? stream.generationId;
  const [frame, setFrame] = useState({
    operationId,
    text: stream.status === 'streaming' ? '' : stream.text,
  });
  const frameRef = useRef(frame);
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setReducedMotion(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);

  const completing =
    stream.status === 'completed' &&
    (stream.finishReason === 'stop' || stream.finishReason === 'length');
  const animate =
    !reducedMotion &&
    operationId !== null &&
    (stream.status === 'streaming' || (completing && frame.operationId === operationId));
  // Immediate/terminal delivery is authoritative, including changes to the
  // reduced-motion preference. Keep the next animated frame from rewinding it.
  if (!animate && (frame.operationId !== operationId || frame.text !== stream.text)) {
    setFrame({ operationId, text: stream.text });
  }
  const text = animate
    ? frame.operationId === operationId && stream.text.startsWith(frame.text)
      ? frame.text
      : ''
    : stream.text;

  useEffect(() => {
    if (!animate) {
      frameRef.current = { operationId, text: stream.text };
      return;
    }
    const previous = frameRef.current;
    let visible =
      previous.operationId === operationId && stream.text.startsWith(previous.text)
        ? previous.text
        : '';
    const remaining = Array.from(
      segmenter.segment(stream.text.slice(visible.length)),
      (part) => part.segment,
    );
    if (!remaining.length) return;
    let revealed = 0;
    let credit = 0;
    let previousTime = performance.now();
    const completionDeadline = previousTime + 160;
    let raf = 0;
    const tick = (now: number) => {
      // Catch up quickly after tab suspension, and adapt to a growing backlog.
      const elapsed = Math.max(0, now - previousTime);
      previousTime = now;
      const speed = Math.max(36, (remaining.length - revealed) / 0.6);
      credit += (elapsed * speed) / 1000;
      const count =
        completing && now >= completionDeadline
          ? remaining.length - revealed
          : Math.min(remaining.length - revealed, Math.floor(credit));
      if (count > 0) {
        credit -= count;
        visible += remaining.slice(revealed, revealed + count).join('');
        revealed += count;
        frameRef.current = { operationId, text: visible };
        setFrame(frameRef.current);
      }
      if (revealed < remaining.length) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [operationId, stream.text, animate, completing]);

  return { text, revealing: text !== stream.text };
}
