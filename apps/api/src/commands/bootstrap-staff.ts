import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { z } from 'zod';
import { AppModule } from '../app.module';
import { StaffBootstrapService } from '../admin/staff-bootstrap.service';
import { createStaffPrincipalSchema } from '../admin/staff.schemas';

const inputSchema = createStaffPrincipalSchema.transform((value) => ({
  staffPrincipalId: value.staffPrincipalId,
  email: value.email,
  password: value.initialPassword,
}));

async function run(): Promise<void> {
  if (process.stdin.isTTY) {
    throw new Error('Bootstrap input must be supplied through protected stdin as one JSON object');
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  const input = inputSchema.parse(JSON.parse(raw) as unknown);
  const application = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  application.useLogger(application.get(Logger));
  try {
    const result = await application.get(StaffBootstrapService).bootstrap(input);
    process.stdout.write(
      JSON.stringify({ event: 'staff_bootstrapped', staffPrincipalId: result.id }) + '\n',
    );
  } finally {
    await application.close();
  }
}

void run().catch((error: unknown) => {
  const kind = error instanceof z.ZodError ? 'invalid_input' : 'failed';
  process.stderr.write(JSON.stringify({ event: 'staff_bootstrap_failed', kind }) + '\n');
  process.exitCode = 1;
});
