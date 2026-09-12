import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { StaffBootstrapService } from '../admin/staff-bootstrap.service';
import { AppModule } from '../app.module';
import { env } from '../config/env';
import { assertE2eSeedEnvironment } from './e2e-seed-guard';

const SYNTHETIC_STAFF_ID = '62000000-0000-4000-8000-000000000001';

async function run(): Promise<void> {
  assertE2eSeedEnvironment(env.APP_ENV, env.DATABASE_URL);
  const application = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  application.useLogger(application.get(Logger));
  try {
    await application.get(StaffBootstrapService).bootstrap({
      staffPrincipalId: SYNTHETIC_STAFF_ID,
      email: 'synthetic-access-admin@example.test',
      password: 'Synthetic-Admin-Fixture-9!',
    });
    process.stdout.write(
      JSON.stringify({
        event: 'synthetic_staff_fixture_created',
        staffPrincipalId: SYNTHETIC_STAFF_ID,
      }) + '\n',
    );
  } finally {
    await application.close();
  }
}

void run().catch(() => {
  process.stderr.write(JSON.stringify({ event: 'synthetic_staff_fixture_failed' }) + '\n');
  process.exitCode = 1;
});
