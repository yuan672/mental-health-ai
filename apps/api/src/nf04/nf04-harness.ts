import type { Nf04ArchiveEvidence, Nf04ArchiveKind } from './nf04-archive';

export type Nf04HarnessStep =
  | 'preflight'
  | 'resources_created'
  | 'databases_initialized'
  | 'source_migrated'
  | 'fixture_loaded'
  | 'pre_delete_validated'
  | 'pre_delete_archive_completed'
  | 'account_deleted'
  | 'post_delete_validated'
  | 'post_delete_archive_completed'
  | 'source_stopped'
  | 'pre_delete_restored'
  | 'post_delete_restored'
  | 'restores_validated'
  | 'cleanup_completed';

export type Nf04AccountDeletionResult =
  | Readonly<{ status: 'confirmed'; operationId: string }>
  | Readonly<{ status: 'unknown'; operationId: string }>;

export interface Nf04DrillActions {
  preflight(): Promise<void>;
  createResources(): Promise<void>;
  initializeDatabases(): Promise<void>;
  migrateSourceFromZero(): Promise<void>;
  loadFixture(): Promise<void>;
  validateSource(point: 'pre_delete' | 'post_delete'): Promise<void>;
  createArchive(kind: Nf04ArchiveKind): Promise<Nf04ArchiveEvidence>;
  deleteSyntheticAccount(): Promise<Nf04AccountDeletionResult>;
  stopSource(): Promise<void>;
  restore(kind: Nf04ArchiveKind, evidence: Nf04ArchiveEvidence): Promise<'completed' | 'unknown'>;
  validateRestores(): Promise<void>;
  cleanup(): Promise<void>;
  quarantine(reason: string): Promise<void>;
}

export type Nf04HarnessReport = Readonly<{
  status: 'passed' | 'quarantined';
  completedSteps: readonly Nf04HarnessStep[];
  reason?: string;
}>;

export class Nf04DrillHarness {
  constructor(private readonly actions: Nf04DrillActions) {}

  async run(): Promise<Nf04HarnessReport> {
    const completedSteps: Nf04HarnessStep[] = [];
    const step = async (name: Nf04HarnessStep, work: () => Promise<void>) => {
      await work();
      completedSteps.push(name);
    };

    try {
      await step('preflight', () => this.actions.preflight());
      await step('resources_created', () => this.actions.createResources());
      await step('databases_initialized', () => this.actions.initializeDatabases());
      await step('source_migrated', () => this.actions.migrateSourceFromZero());
      await step('fixture_loaded', () => this.actions.loadFixture());
      await step('pre_delete_validated', () => this.actions.validateSource('pre_delete'));
      const preDeleteArchive = await this.actions.createArchive('pre-delete');
      completedSteps.push('pre_delete_archive_completed');

      const deletion = await this.actions.deleteSyntheticAccount();
      if (deletion.status === 'unknown') {
        await this.actions.quarantine('account deletion result unknown');
        return {
          status: 'quarantined',
          completedSteps,
          reason: 'account deletion result unknown',
        };
      }
      completedSteps.push('account_deleted');
      await step('post_delete_validated', () => this.actions.validateSource('post_delete'));
      const postDeleteArchive = await this.actions.createArchive('post-delete');
      completedSteps.push('post_delete_archive_completed');
      await step('source_stopped', () => this.actions.stopSource());

      if ((await this.actions.restore('pre-delete', preDeleteArchive)) !== 'completed') {
        await this.actions.quarantine('pre-delete restore result unknown');
        return {
          status: 'quarantined',
          completedSteps,
          reason: 'pre-delete restore result unknown',
        };
      }
      completedSteps.push('pre_delete_restored');
      if ((await this.actions.restore('post-delete', postDeleteArchive)) !== 'completed') {
        await this.actions.quarantine('post-delete restore result unknown');
        return {
          status: 'quarantined',
          completedSteps,
          reason: 'post-delete restore result unknown',
        };
      }
      completedSteps.push('post_delete_restored');
      await step('restores_validated', () => this.actions.validateRestores());
      await step('cleanup_completed', () => this.actions.cleanup());
      return { status: 'passed', completedSteps };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown NF-04 failure';
      await this.actions.quarantine(reason);
      return { status: 'quarantined', completedSteps, reason };
    }
  }
}
