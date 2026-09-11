import { ageVerifications, and, eq, passwordCredentials, users } from '@mental-health/database';
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export type MinimalProfileRecord = Readonly<{
  email: string;
  accountCreatedAt: Date;
  verifiedAt: Date;
}>;

@Injectable()
export class ProfileRepository {
  constructor(private readonly database: DatabaseService) {}

  async findByUserId(userId: string): Promise<MinimalProfileRecord | null> {
    const [profile] = await this.database.database
      .select({
        email: passwordCredentials.email,
        accountCreatedAt: users.createdAt,
        verifiedAt: ageVerifications.verifiedAt,
      })
      .from(users)
      .innerJoin(passwordCredentials, eq(passwordCredentials.userId, users.id))
      .innerJoin(
        ageVerifications,
        and(eq(ageVerifications.userId, users.id), eq(ageVerifications.ageVerified, true)),
      )
      .where(eq(users.id, userId))
      .limit(1);
    return profile ?? null;
  }
}
