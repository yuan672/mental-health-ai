import type { ProfileResponse } from '@mental-health/types';
import { Injectable } from '@nestjs/common';
import { DatabaseError, NotFoundError } from '../common/errors';
import { ProfileRepository } from './profile.repository';

@Injectable()
export class ProfileService {
  constructor(private readonly repository: ProfileRepository) {}

  async get(userId: string): Promise<ProfileResponse> {
    let profile: Awaited<ReturnType<ProfileRepository['findByUserId']>>;
    try {
      profile = await this.repository.findByUserId(userId);
    } catch {
      throw new DatabaseError();
    }
    if (!profile) throw new NotFoundError('账号资料不存在');
    return {
      success: true,
      data: {
        email: profile.email,
        accountCreatedAt: profile.accountCreatedAt.toISOString(),
        adultEligibility: { verified: true, verifiedAt: profile.verifiedAt.toISOString() },
      },
    };
  }
}
