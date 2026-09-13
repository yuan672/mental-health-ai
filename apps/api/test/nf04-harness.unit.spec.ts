import type { Nf04ArchiveEvidence, Nf04ArchiveKind } from '../src/nf04/nf04-archive';
import {
  Nf04DrillHarness,
  type Nf04AccountDeletionResult,
  type Nf04DrillActions,
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
  quarantine = (reason: string) => this.record(`quarantine:${reason}`);

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
      expect.objectContaining({ status: 'quarantined', reason: 'account deletion result unknown' }),
    );
    expect(actions.calls).toContain('archive:pre-delete');
    expect(actions.calls).toContain('quarantine:account deletion result unknown');
    expect(actions.calls).not.toContain('archive:post-delete');
    expect(actions.calls.some((call) => call.startsWith('restore:'))).toBe(false);
  });
});
