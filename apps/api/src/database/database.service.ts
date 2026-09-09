import {
  createDatabaseClient,
  type AppDatabase,
  type DatabaseClient,
} from '@mental-health/database';
import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { env } from '../config/env';

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  readonly database: AppDatabase;
  private readonly client: DatabaseClient;

  constructor() {
    this.client = createDatabaseClient(env.DATABASE_URL);
    this.database = this.client.database;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.client.pool.end();
  }
}
