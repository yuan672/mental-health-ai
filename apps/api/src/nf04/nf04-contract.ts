import { isAbsolute, posix, relative, resolve, sep, win32 } from 'node:path';
import { z } from 'zod';

export const NF04_POSTGRES_IMAGE = 'postgres:18.6-alpine';
export const NF04_ARTIFACT_ROOT_NAME = 'nf04-backup-restore';
export const NF04_MANIFEST_VERSION = 1;
export const NF04_TOTAL_ARCHIVE_LIMIT_BYTES = 512 * 1024 * 1024;
export const NF04_MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;

const runIdSchema = z.string().regex(/^\d{8}-\d{6}-[a-f0-9]{8}$/);
const safeResourceNameSchema = z.string().regex(/^[a-z0-9_-]+$/);
const absolutePathSchema = z.string().refine(isAbsolute, 'path must be absolute');
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const dockerObjectIdSchema = z.string().min(12).max(128);
const positivePortSchema = z.number().int().min(1024).max(65_535);
const migrationHashSchema = sha256Schema;

export const nf04ContainerExecEvidenceSchema = z
  .object({
    containerId: dockerObjectIdSchema,
    execId: dockerObjectIdSchema,
    exitCode: z.number().int().nullable(),
  })
  .strict();

export const nf04RunStateSchema = z.enum([
  'planned',
  'resources_created',
  'databases_initialized',
  'source_migrated',
  'fixture_loaded',
  'pre_delete_archive_completed',
  'account_deleted',
  'post_delete_archive_completed',
  'restoring',
  'restored',
  'quarantined',
  'cleaned',
]);

export type Nf04RunState = z.infer<typeof nf04RunStateSchema>;

const dockerContainerEvidenceSchema = z
  .object({
    id: dockerObjectIdSchema,
    name: safeResourceNameSchema,
    imageId: dockerObjectIdSchema,
    imageReference: z.literal(NF04_POSTGRES_IMAGE),
    labels: z.record(z.string(), z.string()),
    mounts: z.array(
      z
        .object({
          type: z.enum(['bind', 'volume']),
          source: z.string().min(1),
          destination: z.string().min(1),
          readWrite: z.boolean(),
          volumeName: safeResourceNameSchema.optional(),
        })
        .strict(),
    ),
    networkNames: z.array(safeResourceNameSchema).min(1).max(2),
    hostPort: positivePortSchema,
  })
  .strict();

const dockerVolumeEvidenceSchema = z
  .object({
    // Docker volumes expose a stable name, driver, mountpoint, and labels. They do
    // not expose a container-style object ID, so the manifest must not invent one.
    name: safeResourceNameSchema,
    driver: z.string().min(1),
    mountpoint: absolutePathSchema,
    labels: z.record(z.string(), z.string()),
  })
  .strict();

const dockerNetworkEvidenceSchema = z
  .object({
    id: dockerObjectIdSchema,
    name: safeResourceNameSchema,
    driver: z.string().min(1),
    labels: z.record(z.string(), z.string()),
  })
  .strict();

const databaseEvidenceSchema = z
  .object({
    name: safeResourceNameSchema.refine((value) => value.endsWith('_test')),
    oid: z.number().int().positive(),
    systemIdentifier: z.string().regex(/^\d+$/),
  })
  .strict();

const archiveEvidenceSchema = z
  .object({
    fileName: z.enum(['pre-delete.dump', 'post-delete.dump']),
    byteSize: z.number().int().positive().max(NF04_TOTAL_ARCHIVE_LIMIT_BYTES),
    sha256: sha256Schema,
    completedAt: z.string().datetime({ offset: true }),
    listedWithPgRestore: z.literal(true),
  })
  .strict();

export const nf04ManifestSchema = z
  .object({
    version: z.literal(NF04_MANIFEST_VERSION),
    runId: runIdSchema,
    state: nf04RunStateSchema,
    repositoryRoot: absolutePathSchema,
    artifactRoot: absolutePathSchema,
    archivesRoot: absolutePathSchema.optional(),
    repository: z
      .object({
        commitSha: z.string().regex(/^[a-f0-9]{40}$/),
        migrationHashes: z.array(migrationHashSchema).min(1),
        migrationCreatedAt: z.array(z.number().int().nonnegative()).min(1),
      })
      .strict()
      .optional(),
    image: z
      .object({
        reference: z.literal(NF04_POSTGRES_IMAGE),
        expectedImageId: dockerObjectIdSchema,
        repositoryDigest: z.string().min(1).optional(),
      })
      .strict(),
    ports: z
      .object({
        sourceDatabase: positivePortSchema,
        restoreDatabase: positivePortSchema,
        isolatedApi: positivePortSchema,
      })
      .strict()
      .refine(
        (ports) => new Set(Object.values(ports)).size === 3,
        'NF-04 host ports must be distinct',
      ),
    files: z
      .object({
        fixtureSecrets: absolutePathSchema,
        sourcePgPass: absolutePathSchema,
        restorePgPass: absolutePathSchema,
        sourceManagerPassword: absolutePathSchema.optional(),
        restoreManagerPassword: absolutePathSchema.optional(),
        executionSecrets: absolutePathSchema.optional(),
        isolatedApiEnvironment: absolutePathSchema,
      })
      .strict(),
    observed: z
      .object({
        sourceContainer: dockerContainerEvidenceSchema.optional(),
        restoreContainer: dockerContainerEvidenceSchema.optional(),
        sourceVolume: dockerVolumeEvidenceSchema.optional(),
        restoreVolume: dockerVolumeEvidenceSchema.optional(),
        network: dockerNetworkEvidenceSchema.optional(),
        sourceDatabase: databaseEvidenceSchema.optional(),
        sourceServerSystemIdentifier: z.string().regex(/^\d+$/).optional(),
        restoreServerSystemIdentifier: z.string().regex(/^\d+$/).optional(),
        sourceControlDatabase: databaseEvidenceSchema.optional(),
        restoreControlDatabase: databaseEvidenceSchema.optional(),
        sourceRoleOid: z.number().int().positive().optional(),
        restoreRoleOid: z.number().int().positive().optional(),
        sourceSchemaSha256: sha256Schema.optional(),
        preRestoreDatabase: databaseEvidenceSchema.optional(),
        postRestoreDatabase: databaseEvidenceSchema.optional(),
        executions: z
          .object({
            preDeleteArchive: nf04ContainerExecEvidenceSchema.optional(),
            preDeleteArchiveList: nf04ContainerExecEvidenceSchema.optional(),
            postDeleteArchive: nf04ContainerExecEvidenceSchema.optional(),
            postDeleteArchiveList: nf04ContainerExecEvidenceSchema.optional(),
            preDeleteRestore: nf04ContainerExecEvidenceSchema.optional(),
            postDeleteRestore: nf04ContainerExecEvidenceSchema.optional(),
            sourceToolVersion: nf04ContainerExecEvidenceSchema.optional(),
            restoreToolVersion: nf04ContainerExecEvidenceSchema.optional(),
            preDeleteRestoreList: nf04ContainerExecEvidenceSchema.optional(),
            postDeleteRestoreList: nf04ContainerExecEvidenceSchema.optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    archives: z
      .object({
        preDelete: archiveEvidenceSchema.optional(),
        postDelete: archiveEvidenceSchema.optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, context) => {
    const totalArchiveBytes =
      (manifest.archives.preDelete?.byteSize ?? 0) + (manifest.archives.postDelete?.byteSize ?? 0);
    if (totalArchiveBytes > NF04_TOTAL_ARCHIVE_LIMIT_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['archives'],
        message: 'NF-04 archive evidence exceeds the total run budget',
      });
    }
  });

export type Nf04Manifest = z.infer<typeof nf04ManifestSchema>;

/**
 * The original manifest remains readable by the validation/fixture commands.
 * Full execution is narrower: it requires the commit, migration history,
 * archive-only mount and every protected credential path introduced by the
 * real adapter batch.
 */
export const nf04ExecutableManifestSchema = nf04ManifestSchema.refine(
  (
    manifest,
  ): manifest is Nf04Manifest & {
    archivesRoot: string;
    repository: { commitSha: string; migrationHashes: string[]; migrationCreatedAt: number[] };
    files: Nf04Manifest['files'] & {
      sourceManagerPassword: string;
      restoreManagerPassword: string;
      executionSecrets: string;
    };
  } =>
    Boolean(
      manifest.archivesRoot &&
      manifest.repository &&
      manifest.repository.migrationHashes.length ===
        manifest.repository.migrationCreatedAt.length &&
      manifest.files.sourceManagerPassword &&
      manifest.files.restoreManagerPassword &&
      manifest.files.executionSecrets,
    ),
  'NF-04 full execution manifest fields are incomplete',
);

export type Nf04ExecutableManifest = z.infer<typeof nf04ExecutableManifestSchema>;

export const nf04FixtureSecretsSchema = z
  .object({
    databaseUrl: z
      .string()
      .url()
      .refine((value) => value.startsWith('postgresql://')),
    userEmail: z
      .string()
      .email()
      .refine((value) => value.endsWith('@example.test')),
    userPassword: z.string().min(16).max(128).startsWith('Synthetic-'),
    sessionToken: z.string().min(32).max(256).startsWith('nf04-synthetic-'),
    staffEmail: z
      .string()
      .email()
      .refine((value) => value.endsWith('@example.test')),
    staffPassword: z.string().min(16).max(128).startsWith('Synthetic-'),
  })
  .strict();

export type Nf04FixtureSecrets = z.infer<typeof nf04FixtureSecretsSchema>;

export const nf04ExecutionSecretsSchema = z
  .object({
    sourceRolePassword: z.string().min(24).max(128).startsWith('Synthetic-'),
    restoreRolePassword: z.string().min(24).max(128).startsWith('Synthetic-'),
  })
  .strict();

export type Nf04ExecutionSecrets = z.infer<typeof nf04ExecutionSecretsSchema>;

export const nf04PreparationRequestSchema = z
  .object({
    runId: runIdSchema,
    sourceDatabasePort: positivePortSchema,
    restoreDatabasePort: positivePortSchema,
    isolatedApiPort: positivePortSchema,
  })
  .strict()
  .refine(
    (request) =>
      new Set([request.sourceDatabasePort, request.restoreDatabasePort, request.isolatedApiPort])
        .size === 3,
    'NF-04 preparation ports must be distinct',
  );

export type Nf04PreparationRequest = z.infer<typeof nf04PreparationRequestSchema>;

export type Nf04ExpectedNames = Readonly<{
  sourceContainer: string;
  restoreContainer: string;
  sourceVolume: string;
  restoreVolume: string;
  network: string;
  sourceControlDatabase: string;
  sourceDatabase: string;
  restoreControlDatabase: string;
  preRestoreDatabase: string;
  postRestoreDatabase: string;
  sourceRole: string;
  restoreRole: string;
  sourceManagerRole: string;
  restoreManagerRole: string;
}>;

export function deriveNf04ExpectedNames(runId: string): Nf04ExpectedNames {
  const parsedRunId = runIdSchema.parse(runId);
  const token = parsedRunId.slice(-8);
  return {
    sourceContainer: `mh-nf04-${parsedRunId}-src`,
    restoreContainer: `mh-nf04-${parsedRunId}-restore`,
    sourceVolume: `mh_nf04_${token}_src_data`,
    restoreVolume: `mh_nf04_${token}_restore_data`,
    network: `mh_nf04_${token}_network`,
    sourceControlDatabase: `mh_nf04_${token}_source_control_test`,
    sourceDatabase: `mh_nf04_${token}_src_test`,
    restoreControlDatabase: `mh_nf04_${token}_restore_test`,
    preRestoreDatabase: `mh_nf04_${token}_pre_restore_test`,
    postRestoreDatabase: `mh_nf04_${token}_post_restore_test`,
    sourceRole: `mh_nf04_${token}_source_role`,
    restoreRole: `mh_nf04_${token}_restore_role`,
    sourceManagerRole: `mh_nf04_${token}_source_manager`,
    restoreManagerRole: `mh_nf04_${token}_restore_manager`,
  };
}

export type Nf04PathSemantics = 'native' | 'posix' | 'win32';

export function isPathWithin(
  parent: string,
  candidate: string,
  semantics: Nf04PathSemantics = 'native',
): boolean {
  const pathImplementation =
    semantics === 'win32'
      ? win32
      : semantics === 'posix'
        ? posix
        : { isAbsolute, relative, resolve, sep };
  const parentPath = pathImplementation.resolve(parent);
  const candidatePath = pathImplementation.resolve(candidate);
  const pathFromParent = pathImplementation.relative(parentPath, candidatePath);
  return (
    pathFromParent !== '' &&
    !pathImplementation.isAbsolute(pathFromParent) &&
    pathFromParent !== '..' &&
    !pathFromParent.startsWith(`..${pathImplementation.sep}`)
  );
}
