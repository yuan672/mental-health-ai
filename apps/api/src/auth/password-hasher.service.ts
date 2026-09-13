import { Injectable, Optional } from '@nestjs/common';
import { argon2id, hash, verify } from 'argon2';
import { CredentialWorkAdmissionService } from '../http-abuse/credential-work-admission.service';

export const PASSWORD_HASH_VERIFIER = Symbol('PASSWORD_HASH_VERIFIER');

export interface PasswordHashVerifier {
  verify(passwordHash: string, password: string, signal?: AbortSignal): Promise<boolean>;
}

const ARGON2_OPTIONS = {
  type: argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
  hashLength: 32,
} as const;

@Injectable()
export class PasswordHasherService implements PasswordHashVerifier {
  private readonly dummyHash = hash('not-a-real-user-password-9F!pQ2', ARGON2_OPTIONS);

  constructor(@Optional() private readonly credentialWork?: CredentialWorkAdmissionService) {}

  hash(password: string, signal?: AbortSignal): Promise<string> {
    return this.run(signal, () => hash(password, ARGON2_OPTIONS));
  }

  verify(passwordHash: string, password: string, signal?: AbortSignal): Promise<boolean> {
    return this.run(signal, () => verify(passwordHash, password));
  }

  async verifyDummy(password: string, signal?: AbortSignal): Promise<void> {
    await this.run(signal, async () => verify(await this.dummyHash, password));
  }

  private run<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    if (!signal) return work();
    if (!this.credentialWork) throw new Error('HTTP credential admission is unavailable');
    return this.credentialWork.run(signal, work);
  }
}
