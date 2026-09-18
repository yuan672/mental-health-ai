import type { KnowledgeContentBlockRecord } from '@mental-health/database';

export const KNOWLEDGE_CHILD_CHARACTERS = 400;
export const KNOWLEDGE_CHILD_OVERLAP = 60;

export type KnowledgeRetrievalChunk = Readonly<{
  ordinal: number;
  headingPath: readonly string[];
  text: string;
}>;

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const ignoredWords = new Set([
  '什么',
  '怎么',
  '如何',
  '可以',
  '应该',
  '是否',
  '是不是',
  '会不会',
  '怎么办',
  '一下',
  '今天',
  '每天',
  '现在',
  '这个',
  '那个',
  '这些',
  '哪些',
  '自己',
  '别人',
  '我们',
  '他们',
  '觉得',
  '已经',
  '还是',
  '但是',
  '因为',
  '所以',
  '时候',
  '之前',
  '以后',
  '还有',
  '所有',
  '必须',
  '一直',
  '一件',
  '一些',
  '多少',
  '没有',
  '需要',
  'a',
  'an',
  'and',
  'are',
  'for',
  'in',
  'is',
  'of',
  'or',
  'the',
  'to',
]);

/** Search-only normalization: never changes frozen blocks or the user's prompt. */
export function knowledgeSearchWords(value: string, limit = 128): string[] {
  const words = new Set<string>();
  for (const part of segmenter.segment(value.normalize('NFKC').toLowerCase())) {
    if (!part.isWordLike || ignoredWords.has(part.segment)) continue;
    if (/^\p{Script=Han}$/u.test(part.segment)) continue;
    words.add(part.segment.slice(0, 64));
    if (words.size >= limit) break;
  }
  return [...words];
}

/** Chinese punctuation first; Unicode code-point fallback for unpunctuated text.
 * These are retrieval children only. Delivery always expands to original parents.
 */
export function splitKnowledgeSearchText(text: string, size = 400, overlap = 60): string[] {
  if (
    !Number.isInteger(size) ||
    size < 64 ||
    size > 512 ||
    !Number.isInteger(overlap) ||
    overlap < 0 ||
    overlap >= size / 2
  ) {
    throw new RangeError('invalid_knowledge_chunk_size');
  }
  const chars = Array.from(text);
  const chunks: string[] = [];
  let start = 0;
  while (start < chars.length) {
    let end = Math.min(start + size, chars.length);
    if (end < chars.length) {
      for (let cursor = end; cursor > start + Math.floor(size / 2); cursor -= 1) {
        if (/[。！？；.!?;\n]/u.test(chars[cursor - 1]!)) {
          end = cursor;
          break;
        }
      }
    }
    chunks.push(chars.slice(start, end).join(''));
    if (end === chars.length) break;
    // Keep a bounded suffix; no text is dropped, including quote/negation boundaries.
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

export function buildKnowledgeRetrievalChunks(
  blocks: readonly KnowledgeContentBlockRecord[],
  size = KNOWLEDGE_CHILD_CHARACTERS,
  overlap = KNOWLEDGE_CHILD_OVERLAP,
): readonly KnowledgeRetrievalChunk[] {
  const chunks: KnowledgeRetrievalChunk[] = [];
  let section = '';
  let subsection = '';
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'heading') {
      if (block.level === 2) {
        section = block.text;
        subsection = '';
      } else subsection = block.text;
    }
    const headingPath = [section, subsection].filter(Boolean);
    // Preserve list-item boundaries. Callouts stay atomic, even when long.
    const texts = block.type === 'list' ? block.items : [block.text];
    for (const text of texts) {
      const children =
        block.type === 'callout' || block.type === 'heading'
          ? [text]
          : splitKnowledgeSearchText(text, size, overlap);
      for (const child of children) chunks.push({ ordinal: index + 1, headingPath, text: child });
    }
  }
  return chunks;
}
