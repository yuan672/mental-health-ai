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

export type Nf04HarnessFailureCode =
  | 'ACTION_FAILED'
  | 'ACCOUNT_DELETION_RESULT_UNKNOWN'
  | 'PRE_DELETE_RESTORE_RESULT_UNKNOWN'
  | 'POST_DELETE_RESTORE_RESULT_UNKNOWN'
  | 'QUARANTINE_FAILED';

export type Nf04HarnessFailure = Readonly<{
  code: Nf04HarnessFailureCode;
  stage: Nf04HarnessStep;
}>;

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
  quarantine(failure: Nf04HarnessFailure): Promise<void>;
}

export type Nf04HarnessReport =
  | Readonly<{
      status: 'passed';
      completedSteps: readonly Nf04HarnessStep[];
    }>
  | Readonly<{
      status: 'quarantined' | 'failed';
      completedSteps: readonly Nf04HarnessStep[];
      failure: Nf04HarnessFailure;
    }>;

export class Nf04DrillHarness {
  constructor(private readonly actions: Nf04DrillActions) {}

  async run(): Promise<Nf04HarnessReport> {
    const completedSteps: Nf04HarnessStep[] = [];
    let currentStage: Nf04HarnessStep = 'preflight';
    const step = async (name: Nf04HarnessStep, work: () => Promise<void>) => {
      currentStage = name;
      await work();
      completedSteps.push(name);
    };
    const stop = async (failure: Nf04HarnessFailure): Promise<Nf04HarnessReport> => {
      try {
        await this.actions.quarantine(failure);
        return { status: 'quarantined', completedSteps, failure };
      } catch {
        return {
          status: 'failed',
          completedSteps,
          failure: { code: 'QUARANTINE_FAILED', stage: failure.stage },
        };
      }
    };

    try {
      await step('preflight', () => this.actions.preflight());
      await step('resources_created', () => this.actions.createResources());
      await step('databases_initialized', () => this.actions.initializeDatabases());
      await step('source_migrated', () => this.actions.migrateSourceFromZero());
      await step('fixture_loaded', () => this.actions.loadFixture());
      await step('pre_delete_validated', () => this.actions.validateSource('pre_delete'));
      currentStage = 'pre_delete_archive_completed';
      const preDeleteArchive = await this.actions.createArchive('pre-delete');
      completedSteps.push('pre_delete_archive_completed');

      currentStage = 'account_deleted';
      const deletion = await this.actions.deleteSyntheticAccount();
      if (deletion.status === 'unknown') {
        return stop({ code: 'ACCOUNT_DELETION_RESULT_UNKNOWN', stage: currentStage });
      }
      completedSteps.push('account_deleted');
      await step('post_delete_validated', () => this.actions.validateSource('post_delete'));
      currentStage = 'post_delete_archive_completed';
      const postDeleteArchive = await this.actions.createArchive('post-delete');
      completedSteps.push('post_delete_archive_completed');
      await step('source_stopped', () => this.actions.stopSource());

      currentStage = 'pre_delete_restored';
      if ((await this.actions.restore('pre-delete', preDeleteArchive)) !== 'completed') {
        return stop({ code: 'PRE_DELETE_RESTORE_RESULT_UNKNOWN', stage: currentStage });
      }
      completedSteps.push('pre_delete_restored');
      currentStage = 'post_delete_restored';
      if ((await this.actions.restore('post-delete', postDeleteArchive)) !== 'completed') {
        return stop({ code: 'POST_DELETE_RESTORE_RESULT_UNKNOWN', stage: currentStage });
      }
      completedSteps.push('post_delete_restored');
      await step('restores_validated', () => this.actions.validateRestores());
      await step('cleanup_completed', () => this.actions.cleanup());
      return { status: 'passed', completedSteps };
    } catch {
      return stop({ code: 'ACTION_FAILED', stage: currentStage });
    }
  }
}
