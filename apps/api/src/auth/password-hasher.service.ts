import { Injectable } from '@nestjs/common';
import { argon2id, hash, verify } from 'argon2';

const ARGON2_OPTIONS = {
  type: argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
  hashLength: 32,
} as const;

@Injectable()
export class PasswordHasherService {
  private readonly dummyHash = hash('not-a-real-user-password-9F!pQ2', ARGON2_OPTIONS);

  hash(password: string): Promise<string> {
    return hash(password, ARGON2_OPTIONS);
  }

  verify(passwordHash: string, password: string): Promise<boolean> {
    return verify(passwordHash, password);
  }

  async verifyDummy(password: string): Promise<void> {
    await verify(await this.dummyHash, password);
  }
}
