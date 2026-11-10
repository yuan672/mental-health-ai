import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initialChatStreamState, type ChatStreamState } from './chat-stream-state';
import { useSmoothChatText } from './use-smooth-chat-text';

let callbacks: Map<number, FrameRequestCallback>;
let sequence = 0;
let now = 0;
function step(time: number) {
  now = time;
  act(() => {
    const pending = [...callbacks.values()];
    callbacks.clear();
    pending.forEach((callback) => callback(time));
  });
}
const streaming = (text: string, turnId = 'turn-one'): ChatStreamState => ({
  ...initialChatStreamState,
  status: 'streaming',
  mode: 'persistent',
  turnId,
  text,
});

beforeEach(() => {
  callbacks = new Map();
  now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callbacks.set(++sequence, callback);
    return sequence;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('approved reply presentation', () => {
  it('reveals a segment incrementally and continues from its prefix when more approved text arrives', () => {
    const text = '已经审核的回复内容。'.repeat(4);
    const { result, rerender } = renderHook(useSmoothChatText, { initialProps: streaming(text) });
    expect(result.current.text).toBe('');
    step(100);
    const prefix = result.current.text;
    expect(prefix.length).toBeGreaterThan(0);
    expect(prefix.length).toBeLessThan(text.length);
    const target = text + '新的已审核内容。';
    rerender(streaming(target));
    expect(result.current.text).toBe(prefix);
    step(200);
    expect(result.current.text.startsWith(prefix)).toBe(true);
    expect(target.startsWith(result.current.text)).toBe(true);
    step(10000);
    expect(result.current).toEqual({ text: target, revealing: false });
  });

  it('keeps emoji sequences and combining characters intact', () => {
    const { result } = renderHook(useSmoothChatText, { initialProps: streaming('你👩‍💻好é') });
    step(60);
    expect(result.current.text).toBe('你👩‍💻');
    step(160);
    expect(result.current.text).toBe('你👩‍💻好é');
  });

  it('discards an old turn immediately and cancels its scheduled frame', () => {
    const { result, rerender, unmount } = renderHook(useSmoothChatText, {
      initialProps: streaming('第一轮的内容'),
    });
    step(100);
    expect(result.current.text).not.toBe('');
    rerender(streaming('下一轮', 'turn-two'));
    expect(result.current.text).toBe('');
    step(300);
    expect(result.current.text).toBe('下一轮');
    unmount();
    expect(callbacks.size).toBe(0);
  });

  it('finishes the small display tail within 160ms after a normal completion', () => {
    const text = '已经审核的回复。'.repeat(50);
    const { result, rerender } = renderHook(useSmoothChatText, { initialProps: streaming(text) });
    step(60);
    const prefix = result.current.text;
    rerender({ ...streaming(text), status: 'completed', finishReason: 'stop' });
    expect(result.current.text).toBe(prefix);
    step(220);
    expect(result.current).toEqual({ text, revealing: false });
  });

  it.each(['cancelled', 'failed'] as const)('does not keep typing after %s', (status) => {
    const text = '已经审核的前缀';
    const { result, rerender } = renderHook(useSmoothChatText, { initialProps: streaming(text) });
    rerender({ ...streaming(text), status });
    expect(result.current).toEqual({ text, revealing: false });
    expect(callbacks.size).toBe(0);
  });

  it('shows trusted safety replacements immediately at terminal delivery', () => {
    const { result, rerender } = renderHook(useSmoothChatText, {
      initialProps: streaming('已审核前缀'),
    });
    const text = '已审核前缀。合成安全支持提示。';
    rerender({ ...streaming(text), status: 'completed', finishReason: 'content_filter' });
    expect(result.current).toEqual({ text, revealing: false });
    expect(callbacks.size).toBe(0);
  });

  it('does not replay typing for already completed history', () => {
    const { result } = renderHook(useSmoothChatText, {
      initialProps: {
        ...streaming('已有回复'),
        status: 'completed',
        finishReason: 'stop',
      } as ChatStreamState,
    });
    expect(result.current).toEqual({ text: '已有回复', revealing: false });
    expect(callbacks.size).toBe(0);
  });

  it('respects reduced motion without delaying approved text', () => {
    const actual = window.matchMedia;
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      ...actual(query),
      matches: true,
    }));
    const { result } = renderHook(useSmoothChatText, { initialProps: streaming('完整显示') });
    expect(result.current).toEqual({ text: '完整显示', revealing: false });
    expect(callbacks.size).toBe(0);
  });

  it('does not rewind text when reduced motion is changed during a reply', () => {
    const actual = window.matchMedia;
    const events = new EventTarget();
    const media = {
      ...actual('(prefers-reduced-motion: reduce)'),
      matches: false as boolean,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    } satisfies MediaQueryList;
    vi.spyOn(window, 'matchMedia').mockReturnValue(media);
    const text = '已经审核的回复内容。'.repeat(4);
    const { result, rerender } = renderHook(useSmoothChatText, { initialProps: streaming(text) });
    step(100);
    expect(result.current.text.length).toBeLessThan(text.length);
    act(() => {
      media.matches = true;
      events.dispatchEvent(new Event('change'));
    });
    expect(result.current.text).toBe(text);
    act(() => {
      media.matches = false;
      events.dispatchEvent(new Event('change'));
    });
    expect(result.current.text).toBe(text);
    rerender(streaming(text + '新内容'));
    step(200);
    expect(result.current.text.startsWith(text)).toBe(true);
  });
});
