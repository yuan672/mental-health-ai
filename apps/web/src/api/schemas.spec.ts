import { describe, expect, it } from 'vitest';
import { consentDocumentHrefSchema } from './schemas';

describe('Consent document href validation', () => {
  it('accepts versioned same-origin synthetic paths and HTTPS documents', () => {
    expect(
      consentDocumentHrefSchema.parse(
        '/consent-documents/synthetic.privacy-policy/1.0/test-revision-1.html',
      ),
    ).toContain('synthetic.privacy-policy');
    expect(consentDocumentHrefSchema.parse('https://policy.example.test/privacy/1.0')).toContain(
      'https://',
    );
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,unsafe',
    '//evil.example/privacy',
    'http://policy.example.test/privacy',
    '/consent-documents/../private/file.html',
    '/consent-documents/%2e%2e/private/file.html',
  ])('rejects unsafe document href %s', (href) => {
    expect(() => consentDocumentHrefSchema.parse(href)).toThrow();
  });
});
