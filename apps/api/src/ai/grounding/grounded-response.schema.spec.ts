import { parseGroundedProviderEnvelope } from './grounded-response.schema';

describe('parseGroundedProviderEnvelope', () => {
  it('accepts a strict non-empty subset of offered turn-local identifiers', () => {
    expect(
      parseGroundedProviderEnvelope(
        JSON.stringify({ answer: '可以先从一个很小的日常步骤开始。', usedReferenceIds: ['K2'] }),
        ['K1', 'K2'],
      ),
    ).toEqual({ answer: '可以先从一个很小的日常步骤开始。', usedReferenceIds: ['K2'] });
  });

  it.each([
    { answer: '回答', usedReferenceIds: [] },
    { answer: '回答', usedReferenceIds: ['K1', 'K1'] },
    { answer: '回答', usedReferenceIds: ['K9'] },
    { answer: '查看 https://example.test', usedReferenceIds: ['K1'] },
    { answer: '参考 [K1]', usedReferenceIds: ['K1'] },
    { answer: '回答', usedReferenceIds: ['K1'], reasoning: 'hidden' },
  ])('rejects malformed or model-authored provenance %#', (value) => {
    expect(() => parseGroundedProviderEnvelope(JSON.stringify(value), ['K1', 'K2'])).toThrow();
  });
});
