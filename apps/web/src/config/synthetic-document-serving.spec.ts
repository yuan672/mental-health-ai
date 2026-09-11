import { describe, expect, it } from 'vitest';
import { syntheticDocumentPublicDirectory } from './synthetic-document-serving';

describe('synthetic Consent document serving', () => {
  it('serves fixtures only from Development and Test dev servers', () => {
    expect(syntheticDocumentPublicDirectory('serve', 'development')).toBe('public.synthetic');
    expect(syntheticDocumentPublicDirectory('serve', 'test')).toBe('public.synthetic');
    expect(syntheticDocumentPublicDirectory('serve', 'staging')).toBe(false);
    expect(syntheticDocumentPublicDirectory('serve', 'production')).toBe(false);
  });

  it('never copies synthetic fixtures into a build', () => {
    for (const mode of ['development', 'test', 'staging', 'production']) {
      expect(syntheticDocumentPublicDirectory('build', mode)).toBe(false);
    }
  });
});
