import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { env } from '../../config/env';

const crisisResourceSchema = z
  .object({
    id: z.string().min(1).max(64),
    jurisdiction: z.string().min(2).max(16),
    locale: z.literal('zh-CN'),
    name: z.string().min(1).max(128),
    contactMethod: z.enum(['phone', 'web', 'in_person', 'emergency_service']),
    contactValue: z.string().min(1).max(256),
    authoritativeSource: z.string().url(),
    verifiedAt: z.coerce.date(),
    verificationMetadata: z.string().min(1).max(128),
    active: z.boolean(),
    synthetic: z.boolean(),
  })
  .strict();

export type CrisisResource = z.infer<typeof crisisResourceSchema>;

const SYNTHETIC_TEST_RESOURCES: CrisisResource[] = [
  {
    id: 'synthetic-cn-test-resource',
    jurisdiction: 'CN',
    locale: 'zh-CN',
    name: '合成测试资源（非真实危机热线）',
    contactMethod: 'phone',
    contactValue: 'TEST-CONTACT-NOT-REAL',
    authoritativeSource: 'https://example.invalid/synthetic-crisis-resource',
    verifiedAt: new Date('2026-09-10T00:00:00.000Z'),
    verificationMetadata: 'automated-test-fixture-only',
    active: true,
    synthetic: true,
  },
];

@Injectable()
export class CrisisResourceRegistry {
  private readonly resources =
    env.APP_ENV === 'development' || env.APP_ENV === 'test'
      ? SYNTHETIC_TEST_RESOURCES.map((resource) => crisisResourceSchema.parse(resource))
      : [];

  listActive(jurisdiction: string, locale: 'zh-CN'): readonly CrisisResource[] {
    return this.resources.filter(
      (resource) =>
        resource.active && resource.jurisdiction === jurisdiction && resource.locale === locale,
    );
  }

  isProductionReady(): boolean {
    const active = this.listActive('CN', 'zh-CN');
    return active.length > 0 && active.every((resource) => !resource.synthetic);
  }
}
