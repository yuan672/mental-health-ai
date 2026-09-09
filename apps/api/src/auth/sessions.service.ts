import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AuthenticationError, DatabaseError } from '../common/errors';
import { env } from '../config/env';
import { UsersRepository, type SessionRecord } from '../users/users.repository';

export type CreatedSession = SessionRecord & {
  rawToken: string;
  csrfToken: string;
};

export function hashSessionToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

@Injectable()
export class SessionsService {
  constructor(private readonly usersRepository: UsersRepository) {}

  async create(userId: string): Promise<CreatedSession> {
    const rawToken = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const session: SessionRecord = {
      id: randomUUID(),
      userId,
      expiresAt: new Date(Date.now() + env.SESSION_TTL_SECONDS * 1000),
      revokedAt: null,
    };

    try {
      await this.usersRepository.createSession({
        id: session.id,
        userId,
        tokenHash: hashSessionToken(rawToken),
        expiresAt: session.expiresAt,
      });
    } catch {
      throw new DatabaseError();
    }

    return { ...session, rawToken, csrfToken };
  }

  async validate(rawToken: string | undefined): Promise<SessionRecord> {
    if (!rawToken) {
      throw new AuthenticationError();
    }

    let session: SessionRecord | null;
    try {
      session = await this.usersRepository.findSessionByTokenHash(hashSessionToken(rawToken));
    } catch {
      throw new DatabaseError();
    }
    if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) {
      throw new AuthenticationError('登录已失效，请重新登录');
    }

    return session;
  }

  async revoke(session: SessionRecord): Promise<void> {
    try {
      await this.usersRepository.revokeSession(session.id, session.userId, new Date());
    } catch {
      throw new DatabaseError();
    }
  }
}
