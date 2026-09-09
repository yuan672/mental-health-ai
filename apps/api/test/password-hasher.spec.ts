import { PasswordHasherService } from '../src/auth/password-hasher.service';

describe('PasswordHasherService', () => {
  const passwordHasher = new PasswordHasherService();

  it('hashes passwords with Argon2id and verifies them', async () => {
    const passwordHash = await passwordHasher.hash('Correct-Horse-9-Battery');

    expect(passwordHash).toMatch(/^\$argon2id\$/u);
    await expect(passwordHasher.verify(passwordHash, 'Correct-Horse-9-Battery')).resolves.toBe(
      true,
    );
    await expect(passwordHasher.verify(passwordHash, 'wrong-password')).resolves.toBe(false);
  });

  it('executes the dummy verification path for an unknown account', async () => {
    await expect(passwordHasher.verifyDummy('Unknown-Account-9!')).resolves.toBeUndefined();
  });
});
