import { parseGroundedProviderEnvelope } from './grounded-response.schema';

describe('parseGroundedProviderEnvelope', () => {
  it('accepts a strict non-empty subset of offered turn-local identifiers', () => {
    expect(
      parseGroundedProviderEnvelope(
        JSON.stringify({
          status: 'supported',
          answer: '可以先从一个很小的日常步骤开始。',
          usedReferenceIds: ['K2'],
        }),
        ['K1', 'K2'],
      ),
    ).toEqual({
      status: 'supported',
      answer: '可以先从一个很小的日常步骤开始。',
      usedReferenceIds: ['K2'],
    });
  });

  it('accepts abstention only with no generated answer and no claimed evidence', () => {
    const envelope = { status: 'insufficient_evidence', answer: '', usedReferenceIds: [] };
    expect(parseGroundedProviderEnvelope(JSON.stringify(envelope), ['K1'])).toEqual(envelope);
  });

  it.each([
    { answer: '回答', usedReferenceIds: [] },
    { answer: '回答', usedReferenceIds: ['K1', 'K1'] },
    { answer: '回答', usedReferenceIds: ['K9'] },
    { answer: '查看 https://example.test', usedReferenceIds: ['K1'] },
    { answer: '参考 [K1]', usedReferenceIds: ['K1'] },
    { answer: '回答', usedReferenceIds: ['K1'], reasoning: 'hidden' },
  ])('rejects malformed or model-authored provenance %#', (value) => {
    expect(() =>
      parseGroundedProviderEnvelope(JSON.stringify({ status: 'supported', ...value }), [
        'K1',
        'K2',
      ]),
    ).toThrow();
  });

  it.each([
    { answer: '旧格式', usedReferenceIds: ['K1'] },
    { status: 'unknown', answer: '', usedReferenceIds: [] },
    { status: 'insufficient_evidence', answer: '不得泄露的猜测正文', usedReferenceIds: [] },
    { status: 'insufficient_evidence', answer: '', usedReferenceIds: ['K1'] },
    { status: 'insufficient_evidence', answer: '', usedReferenceIds: [], reason: 'extra' },
  ])('rejects ambiguous or contradictory evidence status %#', (value) => {
    expect(() => parseGroundedProviderEnvelope(JSON.stringify(value), ['K1'])).toThrow();
  });
});
