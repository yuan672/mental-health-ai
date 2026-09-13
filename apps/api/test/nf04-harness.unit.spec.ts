import type { Nf04ArchiveEvidence, Nf04ArchiveKind } from '../src/nf04/nf04-archive';
import {
  Nf04DrillHarness,
  type Nf04AccountDeletionResult,
  type Nf04DrillActions,
  type Nf04HarnessFailure,
} from '../src/nf04/nf04-harness';

class HarnessActions implements Nf04DrillActions {
  readonly calls: string[] = [];

  constructor(
    private readonly deletion: Nf04AccountDeletionResult = {
      status: 'confirmed',
      operationId: '6f040000-0000-4000-8000-000000000021',
    },
  ) {}

  private record(name: string): Promise<void> {
    this.calls.push(name);
    return Promise.resolve();
  }

  preflight = () => this.record('preflight');
  createResources = () => this.record('createResources');
  initializeDatabases = () => this.record('initializeDatabases');
  migrateSourceFromZero = () => this.record('migrateSourceFromZero');
  loadFixture = () => this.record('loadFixture');
  validateSource = (point: 'pre_delete' | 'post_delete') => this.record(`validate:${point}`);
  stopSource = () => this.record('stopSource');
  validateRestores = () => this.record('validateRestores');
  cleanup = () => this.record('cleanup');
  quarantine = (failure: Nf04HarnessFailure) =>
    this.record(`quarantine:${failure.code}:${failure.stage}`);

  createArchive(kind: Nf04ArchiveKind): Promise<Nf04ArchiveEvidence> {
    this.calls.push(`archive:${kind}`);
    return Promise.resolve({
      fileName: `${kind}.dump`,
      byteSize: 1,
      sha256: 'a'.repeat(64),
      completedAt: '2026-09-13T05:00:00.000Z',
      listedWithPgRestore: true,
    });
  }

  deleteSyntheticAccount(): Promise<Nf04AccountDeletionResult> {
    this.calls.push('deleteAccount');
    return Promise.resolve(this.deletion);
  }

  restore(kind: Nf04ArchiveKind): Promise<'completed' | 'unknown'> {
    this.calls.push(`restore:${kind}`);
    return Promise.resolve('completed');
  }
}

describe('NF-04 minimum execution harness', () => {
  it('orders both recovery points around one confirmed deletion and stops source before restore', async () => {
    const actions = new HarnessActions();
    const result = await new Nf04DrillHarness(actions).run();
    expect(result.status).toBe('passed');
    expect(actions.calls).toEqual([
      'preflight',
      'createResources',
      'initializeDatabases',
      'migrateSourceFromZero',
      'loadFixture',
      'validate:pre_delete',
      'archive:pre-delete',
      'deleteAccount',
      'validate:post_delete',
      'archive:post-delete',
      'stopSource',
      'restore:pre-delete',
      'restore:post-delete',
      'validateRestores',
      'cleanup',
    ]);
  });

  it('quarantines an unknown account deletion and never creates a post-delete archive', async () => {
    const actions = new HarnessActions({
      status: 'unknown',
      operationId: '6f040000-0000-4000-8000-000000000021',
    });
    const result = await new Nf04DrillHarness(actions).run();
    expect(result).toEqual(
      expect.objectContaining({
        status: 'quarantined',
        failure: {
          code: 'ACCOUNT_DELETION_RESULT_UNKNOWN',
          stage: 'account_deleted',
        },
      }),
    );
    expect(actions.calls).toContain('archive:pre-delete');
    expect(actions.calls).toContain('quarantine:ACCOUNT_DELETION_RESULT_UNKNOWN:account_deleted');
    expect(actions.calls).not.toContain('archive:post-delete');
    expect(actions.calls.some((call) => call.startsWith('restore:'))).toBe(false);
  });

  it('maps raw action errors to a finite code and fixed stage without leaking diagnostics', async () => {
    const actions = new HarnessActions();
    const sensitiveError =
      'postgres://nf04_admin:synthetic-password@127.0.0.1:55432/source_test C:\\secret\\source.pgpass';
    actions.createArchive = async () => {
      throw new Error(sensitiveError);
    };

    const result = await new Nf04DrillHarness(actions).run();

    expect(result).toEqual({
      status: 'quarantined',
      completedSteps: [
        'preflight',
        'resources_created',
        'databases_initialized',
        'source_migrated',
        'fixture_loaded',
        'pre_delete_validated',
      ],
      failure: { code: 'ACTION_FAILED', stage: 'pre_delete_archive_completed' },
    });
    expect(actions.calls).toContain('quarantine:ACTION_FAILED:pre_delete_archive_completed');
    expect(JSON.stringify(result)).not.toContain('synthetic-password');
    expect(JSON.stringify(actions.calls)).not.toContain('synthetic-password');
    expect(JSON.stringify(result)).not.toContain('source.pgpass');
  });

  it('reports quarantine failure without returning either raw error', async () => {
    const actions = new HarnessActions();
    actions.preflight = async () => {
      throw new Error('postgres://user:first-password@localhost/source_test');
    };
    actions.quarantine = async () => {
      throw new Error('C:\\nf04-secret\\second-password.pgpass');
    };

    const result = await new Nf04DrillHarness(actions).run();

    expect(result).toEqual({
      status: 'failed',
      completedSteps: [],
      failure: { code: 'QUARANTINE_FAILED', stage: 'preflight' },
    });
    expect(JSON.stringify(result)).not.toMatch(/password|postgres:\/\//i);
  });
});
