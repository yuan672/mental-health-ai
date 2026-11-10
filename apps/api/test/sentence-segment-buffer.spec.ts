import { SentenceSegmentBuffer } from '../src/ai/streaming/sentence-segment-buffer';

const batch = { firstMinimum: 1, nextMinimum: 96 };

describe('bounded semantic review batches', () => {
  it('coalesces short lines after a quick first batch without dropping text', () => {
    const buffer = new SentenceSegmentBuffer(200, 500, batch);
    const text = Array.from({ length: 24 }, (_, index) => `合成记录${index}：今天散步了。\n`).join(
      '',
    );
    const candidates: string[] = [];
    for (const character of Array.from(text)) candidates.push(...buffer.append(character, 1000));
    const tail = buffer.flush();
    if (tail) candidates.push(tail);
    expect(candidates.join('')).toBe(text);
    expect(Array.from(candidates[0]!).length).toBeLessThan(50);
    expect(candidates.length).toBeLessThanOrEqual(6);
    expect(candidates.every((candidate) => Array.from(candidate).length <= 200)).toBe(true);
  });

  it('still flushes a slow short first response at the configured deadline', () => {
    const buffer = new SentenceSegmentBuffer(200, 500, batch);
    expect(buffer.append('我在听', 1000)).toEqual([]);
    expect(buffer.millisecondsUntilFlush(1200)).toBe(300);
    expect(buffer.flushIfDue(1499)).toBeNull();
    expect(buffer.flushIfDue(1500)).toBe('我在听');
    expect(buffer.millisecondsUntilFlush(1600)).toBeNull();
  });

  it('enforces the Unicode cap even if a sentence boundary appears much later in a delta', () => {
    const buffer = new SentenceSegmentBuffer(12, 500, batch);
    const input = '猫🐈'.repeat(20) + '。\n最后一句。';
    const candidates = buffer.append(input, 1000);
    const tail = buffer.flush();
    if (tail) candidates.push(tail);
    expect(candidates.join('')).toBe(input);
    expect(candidates.every((candidate) => Array.from(candidate).length <= 12)).toBe(true);
    expect(candidates.some((candidate) => /[\uD800-\uDBFF]$/u.test(candidate))).toBe(false);
  });

  it('clears pending unapproved content instead of returning it later', () => {
    const buffer = new SentenceSegmentBuffer(200, 500, batch);
    expect(buffer.append('合成的尚未审核内容', 1000)).toEqual([]);
    buffer.clear();
    expect(buffer.flushIfDue(2000)).toBeNull();
    expect(buffer.flush()).toBeNull();
  });
});
