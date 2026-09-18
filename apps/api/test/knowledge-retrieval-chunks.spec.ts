import {
  buildKnowledgeRetrievalChunks,
  splitKnowledgeSearchText,
} from '../src/knowledge/knowledge-retrieval-chunks';

describe('knowledge retrieval children', () => {
  it('keeps Chinese sentence ends where possible and loses no Unicode text at a fallback boundary', () => {
    const text = `${'一段合成说明。'.repeat(7)}仅在本人愿意时尝试；不舒服可以停止。${'🙂无标点长句'.repeat(20)}`;
    const chunks = splitKnowledgeSearchText(text, 64, 12);
    expect(chunks[0]!.endsWith('仅在本人愿意时尝试；')).toBe(true);
    expect(chunks.every((chunk) => Array.from(chunk).length <= 64)).toBe(true);
    expect(
      chunks
        .slice(1)
        .reduce((joined, chunk) => joined + Array.from(chunk).slice(12).join(''), chunks[0]!),
    ).toBe(text);
    expect(splitKnowledgeSearchText(text, 64, 0).join('')).toBe(text);
    expect(() => splitKnowledgeSearchText(text, 64, 64)).toThrow(RangeError);
  });

  it('preserves nested heading paths, list-item identity and atomic callout conditions', () => {
    const caveat = '不要忽略限制条件。'.repeat(80);
    const chunks = buildKnowledgeRetrievalChunks([
      { type: 'heading', level: 2, text: '练习' },
      { type: 'heading', level: 3, text: '自愿尝试' },
      { type: 'list', style: 'ordered', items: ['第一个完整步骤。', '第二个完整步骤。'] },
      { type: 'callout', tone: 'important', text: caveat },
      { type: 'heading', level: 2, text: '求助' },
      { type: 'paragraph', text: '另一节正文。' },
    ]);
    expect(chunks.filter((chunk) => chunk.ordinal === 3)).toEqual([
      { ordinal: 3, headingPath: ['练习', '自愿尝试'], text: '第一个完整步骤。' },
      { ordinal: 3, headingPath: ['练习', '自愿尝试'], text: '第二个完整步骤。' },
    ]);
    expect(chunks.filter((chunk) => chunk.ordinal === 4).map((chunk) => chunk.text)).toEqual([
      caveat,
    ]);
    expect(chunks.at(-1)?.headingPath).toEqual(['求助']);
  });
});
