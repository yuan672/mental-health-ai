import { MockAgeVerificationProvider } from '../src/age-verification/mock-age-verification.provider';

describe('MockAgeVerificationProvider', () => {
  const provider = new MockAgeVerificationProvider();
  const candidateUserId = 'b703e1d5-b488-41c7-9d40-b19864f8b2fc';

  it('returns a successful development/test verification', async () => {
    await expect(
      provider.verify({ candidateUserId, evidenceToken: 'mock-adult' }),
    ).resolves.toMatchObject({ verified: true, method: 'mock' });
  });

  it('returns an unverified result without inventing an account state', async () => {
    await expect(
      provider.verify({ candidateUserId, evidenceToken: 'mock-underage' }),
    ).resolves.toMatchObject({ verified: false, method: 'mock' });
  });

  it('surfaces provider unavailability through the provider boundary', async () => {
    await expect(
      provider.verify({ candidateUserId, evidenceToken: 'mock-provider-error' }),
    ).rejects.toThrow('Age verification provider unavailable');
  });
});
