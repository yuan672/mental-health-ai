import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from '../app.module';
import { AuditLogService } from '../safety/audit/audit-log.service';
import { RiskEventService } from '../safety/persistence/risk-event.service';

const CLEANUP_BATCH_SIZE = 500;

async function purgeInBatches(purge: (now: Date, batchSize: number) => Promise<number>) {
  const cutoff = new Date();
  let deletedCount: number;
  do {
    deletedCount = await purge(cutoff, CLEANUP_BATCH_SIZE);
  } while (deletedCount === CLEANUP_BATCH_SIZE);
}

async function run(): Promise<void> {
  const application = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
  });
  application.useLogger(application.get(Logger));

  try {
    const riskEvents = application.get(RiskEventService);
    const audits = application.get(AuditLogService);
    await purgeInBatches((now, batchSize) => riskEvents.purgeExpired(now, batchSize));
    await purgeInBatches((now, batchSize) => audits.purgeExpired(now, batchSize));
  } finally {
    await application.close();
  }
}

void run().catch(() => {
  process.stderr.write(
    JSON.stringify({ level: 'error', event: 'safety_data_cleanup_failed' }) + '\n',
  );
  process.exitCode = 1;
});
