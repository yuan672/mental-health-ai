# Local Synthetic Database Backup and Restore Drill

## Status

- Scope: NF-04 local learning/demo design and runbook draft
- Delivery: documentation only
- Drill execution: not performed
- Production backup readiness: not established
- Production Safety Lock: Enforced
- Production AI Chat: Disabled
- `productionSafe=false`
- Real model safety evaluation: Not evaluated

This document defines a future, deliberately isolated PostgreSQL backup and
restore exercise using synthetic data. It does not authorize a backup or restore
against any existing development, staging, or production database. It also does
not define production retention, recovery objectives, encryption, account-
deletion replay, or operational access policy.

`docs/HANDOFF.md` remains the highest project baseline. ADR-012, ADR-016,
ADR-018, ADR-019, ADR-020, and ADR-022 remain binding. In particular, ADR-022
does not claim that primary-database account deletion removes backup copies, and
does not approve a durable deletion tombstone or reapplication mechanism.

## 1. Goal and non-goals

The first drill should prove that an application-database logical archive can be
created, restored into a quarantined database, and checked against the project's
current schema and lifecycle rules. It should also make the account-deletion gap
visible by comparing two recovery points:

1. a backup taken before a synthetic account is deleted; and
2. a backup taken after that deletion has committed.

The drill is not:

- a production disaster-recovery procedure;
- a test of point-in-time recovery, WAL archiving, replication, or failover;
- a full PostgreSQL cluster, role, or tablespace recovery;
- a production RPO or RTO commitment;
- a way to mutate or sanitize an archive after it is created;
- proof that a deleted account cannot reappear after an older backup is restored;
- permission to start the API against a restored pre-deletion snapshot; or
- a substitute for approved backup retention, encryption, access, and deletion
  policies.

No ADR is required for this runbook draft. It details the already-recorded
backup/restore verification gap without changing a binding architecture
decision. A durable deletion-suppression mechanism, a production retention
policy, or production recovery objectives would require a separate decision.

## 2. PostgreSQL tool contract

The first drill uses the exact PostgreSQL image already declared by the project:
`postgres:18.6-alpine`. Source server, restore server, `pg_dump`, and
`pg_restore` must all report PostgreSQL 18.6. A mismatch fails preflight.

Use a custom-format, per-database logical archive:

```text
pg_dump -Fc --no-owner --no-privileges --lock-wait-timeout=5s
```

Restore only into a freshly created, empty database:

```text
pg_restore --single-transaction --exit-on-error --no-owner --no-privileges
```

The first drill intentionally does not use `pg_dumpall`. Cluster-global roles,
tablespaces, and configuration are outside its scope. The restore database and
least-privilege drill role are created independently, so restored objects are
owned by that isolated role and no archived ownership or ACL is applied.

Before restore, run `pg_restore --list` and calculate a SHA-256 checksum for the
archive. These checks prove that the archive can be read and identified; they do
not prove a successful or usable restore. After restore, run `ANALYZE` and the
validation in section 8.

These choices follow the PostgreSQL 18 documentation:

- [`pg_dump`](https://www.postgresql.org/docs/18/app-pgdump.html) creates a
  consistent single-database export, supports custom archives, and documents
  client/server version compatibility and archive trust considerations.
- [`pg_restore`](https://www.postgresql.org/docs/18/app-pgrestore.html) documents
  `--single-transaction`, `--exit-on-error`, ownership, and privilege handling.
- [SQL dump backup and restore](https://www.postgresql.org/docs/18/backup-dump.html)
  distinguishes logical database dumps from cluster-global recovery and
  recommends collecting planner statistics after restoration.
- [`pg_dumpall`](https://www.postgresql.org/docs/18/app-pg-dumpall.html) includes
  cluster-global objects and may expose role/password material, which is why it
  is excluded here.

PostgreSQL also warns that restoring an archive executes SQL originating from
the source. Only an archive produced by this same controlled drill may be used.
An untrusted archive must never be restored by this runbook.

## 3. Isolated topology and resource budget

Each run gets an unguessable run ID such as `20260913-143000-a1b2c3d4` and a
machine-readable local manifest. The manifest is created before any container or
database mutation and records exact resource names and PostgreSQL system IDs.

| Resource                     | Required form                                           |
| ---------------------------- | ------------------------------------------------------- |
| Source container             | `mh-nf04-<run-id>-src`                                  |
| Restore container            | `mh-nf04-<run-id>-restore`                              |
| Source volume                | `mh_nf04_<token>_src_data`                              |
| Restore volume               | `mh_nf04_<token>_restore_data`                          |
| Network                      | `mh_nf04_<token>_network`                               |
| Source database              | `mh_nf04_<token>_src_test`                              |
| Restore control database     | `mh_nf04_<token>_restore_test`                          |
| Pre-deletion restore target  | `mh_nf04_<token>_pre_restore_test`                      |
| Post-deletion restore target | `mh_nf04_<token>_post_restore_test`                     |
| Artifact directory           | `E:\study-project\handoff\nf04-backup-restore\<run-id>` |

Both containers, both volumes, and the network receive immutable run labels:

```text
mh.nf04.run=<run-id>
mh.nf04.role=source|restore|network
```

Use distinct loopback-only host ports that were confirmed free immediately
before container creation. Do not attach either container to the repository's
normal Compose network or volume. The API, when briefly required for the real
account-deletion endpoint, connects only to the source container.

The initial local/demo limits are:

- at most 2 PostgreSQL containers, 2 PostgreSQL volumes, and 1 drill network;
- at most 100 MiB of seeded database content;
- at most 512 MiB total for both custom archives;
- at least 2 GiB free before setup and before each dump;
- 120 seconds for each dump, 180 seconds for each restore, and 120 seconds for
  each validation phase.

These are safety limits for a small synthetic exercise, not production sizing or
recovery objectives. Exceeding a limit stops the drill and preserves evidence
for diagnosis.

## 4. Mandatory destructive-operation guard

The `_test` suffix is necessary but not sufficient. Before every create, drop,
restore, fixture load, deletion request, or cleanup action, the future harness
must verify all of the following against the run manifest:

1. `current_database()` exactly equals the expected database and ends in
   `_test`;
2. Docker container ID, exact name, image digest, run label, and role label match;
3. Docker volume and network exact names and run labels match;
4. `pg_control_system().system_identifier` equals the source or restore system ID
   recorded during setup;
5. the restore target has no application tables before `pg_restore` starts;
6. no normal application process, shared test process, or other task is connected;
7. the artifact path resolves under the exact NF-04 run directory; and
8. `APP_ENV=test` is explicit wherever application code or fixtures run.

Any missing or mismatched signal fails closed before mutation. Never fall back
to a database discovered from `.env`, a default Compose service, a broad name
pattern, or a merely matching `_test` suffix.

Credentials live in run-local protected environment files outside Git. They are
not placed in shell command arguments, console output, the manifest, or the final
report. Archive files and secret environment files are removed during verified
cleanup. The redacted manifest, checksums, and report may be retained.

## 5. Synthetic fixture boundary

The repository's Phase 5B E2E seed is guarded and useful for its own browser
tests, but it does not create every relationship required by this drill. Before
the first execution, a separate implementation PR must add or approve one narrow
NF-04 fixture loader. It must inherit every guard in section 4 and create only
neutral synthetic values.

The fixture should contain stable, predeclared IDs for:

- a User, credential, Session, age-verification evidence, Consent projections,
  and Consent decision ledger;
- a persistent Conversation, neutral User and Assistant Messages, and AI Turn;
- Mood entries and Quota ledger/aggregate rows;
- an Assistant Message reference to a synthetic Knowledge article version and
  ordered source set;
- a Risk Event, its Human Review Queue item, and independent Audit records; and
- global Staff and synthetic Knowledge records that do not belong to the User.

The fixture must not contain actual psychological chat, real email addresses,
real credentials, candidate knowledge articles, real crisis resources, or real
Provider data. It must not mark synthetic Knowledge as curated production
content. Fixture loading may use a reviewed, test-only command or narrowly
reviewed SQL transaction; this document deliberately does not implement either.

## 6. Consistency point and process quiescence

`pg_dump` takes a transactionally consistent database snapshot and does not
normally block ordinary readers or writers. The drill nevertheless quiesces the
source so each recovery point has an unambiguous meaning and the account-deletion
ordering can be audited.

Before each backup:

1. stop new traffic to the isolated API;
2. prove that no request, stream, classifier, generation, or deletion operation is
   active;
3. shut down the isolated API cleanly;
4. query `pg_stat_activity` and require zero application connections to the
   source database; and
5. record the source database time, migration head, and bounded row counts.

The first archive is taken after fixture validation and before account deletion.
The API is then started with Development/Test account deletion enabled and all AI,
Admin HTTP, and Knowledge augmentation features disabled. The synthetic account
is deleted through the real authenticated, CSRF-protected endpoint using one
stable operation ID. A confirmed 204 response is required. Then the API is shut
down and the post-deletion state is validated before the second archive is taken.

If the deletion result is unknown, the drill stops. It must not infer commit or
rollback, start a replacement deletion, or label a recovery point as post-
deletion. An explicit replay/reconciliation using the same operation ID belongs
in the future controlled execution procedure.

Incognito contexts, pending in-memory attempts, active streams, terminals, and
other process-local coordination state are not PostgreSQL data and cannot be
restored by this drill.

## 7. Future execution procedure

The commands below are a reviewable template, not authorization to execute them.
Every variable comes from the verified run manifest. The future harness must use
structured argument passing rather than interpolating untrusted strings.

### A. Preflight and setup

1. Confirm repository HEAD, operator identity, host load, free disk, Docker
   health, free loopback ports, and no other task using the chosen resources.
2. Generate the run ID, exact names, credentials, artifact directory, and labels.
3. Start two fresh `postgres:18.6-alpine` containers with separate volumes.
4. Record container IDs, image digest, ports, and each server's
   `pg_control_system().system_identifier`.
5. Prove all section 4 guards and write the redacted manifest before proceeding.

### B. Create and validate source state

1. Apply all migrations from 0000 to the current head to the empty source
   database through the normal migration command.
2. Load the approved synthetic NF-04 fixture.
3. Validate migrations, row identities, relationships, constraints, triggers,
   feature flags, and fixture bounds.
4. Stop the API if it was used and prove the source is quiescent.

### C. Create the pre-deletion archive

Equivalent protected command:

```powershell
docker exec $sourceContainer pg_dump `
  -U $sourceRole -d $sourceDatabase `
  -Fc --no-owner --no-privileges --lock-wait-timeout=5s `
  -f /nf04-output/pre-delete.dump
```

Enforce the dump timeout and size limit. Run `pg_restore --list`, record SHA-256,
and mark the archive complete only when both checks succeed.

### D. Delete the synthetic account

1. Revalidate the source identity and start exactly one isolated API process.
2. Authenticate as the synthetic User, acquire CSRF through the real Session flow,
   and call the account-deletion endpoint with the stable operation ID and test
   credential.
3. Require the confirmed success response, stop the API, and prove quiescence.
4. Validate the post-deletion primary state before creating another archive.

### E. Create the post-deletion archive

Repeat the protected dump, archive-list, size, and checksum procedure into
`post-delete.dump`. Do not overwrite the first archive.

### F. Restore both recovery points

For each archive, first revalidate the restore server and prove that the named
target database is fresh and empty. Then run the equivalent of:

```powershell
docker exec $restoreContainer pg_restore `
  -U $restoreRole -d $restoreTarget `
  --single-transaction --exit-on-error --no-owner --no-privileges `
  /nf04-output/<archive>.dump
```

Do not use `--clean`, `--create`, parallel jobs, selective table restore, or a
previously failed target. A failed target can be dropped and recreated only after
all exact identity and label guards are rerun.

### G. Quarantine, validate, and clean up

No API may connect to either restored target. Complete section 8 using read-only
queries and transaction-rolled-back probes, run `ANALYZE`, and write the redacted
report. Then perform the verified cleanup in section 10.

## 8. Restore validation matrix

Command completion, database verification, and serviceable recovery are three
different results. The report records each separately. This drill can establish
the first two only; serviceable production recovery remains Not verified.

For both restored targets, verify without printing content:

- Drizzle migration rows have the expected count, order, timestamps, and hashes
  for that archive;
- the expected tables, columns, primary keys, foreign keys, checks, unique
  constraints, indexes, and non-internal triggers exist;
- database ownership and grants reflect the isolated restore role and contain no
  unexpected archived ACLs;
- bounded row counts and exact synthetic fixture IDs match the expected recovery
  point;
- Consent ledger/projection relationships and immutable evidence are internally
  consistent;
- Knowledge article/version/source relationships, source ordering, and immutability
  trigger definitions are intact;
- Assistant knowledge references resolve to the exact synthetic article version
  and source set when their Message exists; and
- FK and immutability probes fail as expected inside transactions that are always
  rolled back.

The pre-deletion restore is expected to contain the complete synthetic User graph,
including its credential and Session rows. This is an expected snapshot fact and
must be recorded as a production blocker: an old backup can reintroduce primary
rows deleted later. The restored target remains offline and is never used for
login or application traffic.

The post-deletion restore must show:

- the ordinary User-owned graph is absent, including credential, Session,
  Consent, Conversation, Message, AI Turn, Mood, Quota, and Assistant reference
  rows;
- the Risk Event and Queue item remain under their independent lifecycle, with
  User, Conversation, AI Turn, and triggering Message references set to null as
  accepted by ADR-014 and ADR-022;
- prior independent Audit history and the content-free account-deletion Audit
  entry remain; and
- global Staff and Knowledge records remain unchanged.

`SET NULL` proves lifecycle decoupling; it is not a claim of anonymization or
legal compliance. The drill must compare only known synthetic IDs, counts,
booleans, constraint names, and hashes. It must not write Mood values, chat text,
Consent evidence payloads, source bodies, email addresses, credentials, tokens,
or raw errors into ordinary logs or the report.

## 9. Required failure exercises

The future execution must prove fail-closed handling for:

| Failure                                                              | Required behavior                                                                                |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Wrong database name, container, volume, network, label, or system ID | Stop before mutation; do not search for a substitute target.                                     |
| Missing, altered, or unreadable archive                              | Fail archive listing/checksum; do not start restore.                                             |
| PostgreSQL image or tool version mismatch                            | Stop before dump or restore.                                                                     |
| Insufficient disk, excessive load, size limit, or timeout            | Stop and preserve bounded diagnostic evidence.                                                   |
| Restore SQL or constraint failure                                    | `--single-transaction --exit-on-error` rolls back; verify no application objects became visible. |
| Restore connection loss or client termination                        | Treat outcome as unknown; reconnect read-only and prove target state before cleanup or retry.    |
| Account-deletion result unknown                                      | Do not take or label the post-deletion backup until exact reconciliation succeeds.               |
| Validation mismatch                                                  | Quarantine both targets, mark the drill failed, and do not start an API.                         |

A restore failure is never retried over the same partially used target. The target
is proven empty or is recreated under the exact guarded name. A process exit code
alone is insufficient evidence of rollback.

## 10. Resource and secret cleanup

Cleanup is explicit and recoverable until validation evidence is complete:

1. stop the exact source and restore container IDs recorded in the manifest;
2. inspect and revalidate their names and run labels;
3. remove those two containers only;
4. inspect and revalidate the two exact volume names and the network label;
5. remove those two volumes and the one network only;
6. resolve every artifact path and require it to be a child of the exact NF-04 run
   directory;
7. remove secret environment files and database archives; and
8. retain only the redacted manifest, SHA-256 values, validation summary, timings,
   and cleanup receipt if the review requires them.

Do not use `docker system prune`, `docker volume prune`, wildcard container
deletion, a recursive delete against a computed broad directory, or the project's
normal Compose resources. A cleanup mismatch stops cleanup and requests manual
review rather than guessing.

## 11. Evidence and acceptance checklist

The run report must bind evidence to the repository commit, migration head,
PostgreSQL image digest, run ID, container/system IDs, archive checksums, and exact
validation queries. It records timings but does not convert them into production
RPO/RTO claims.

The first execution is accepted only when:

- all preflight and destructive-operation guards pass;
- migrations apply from zero in the isolated source;
- both archives pass list and checksum validation;
- both restores complete atomically into fresh targets;
- schema, trigger, constraint, ownership, and application-lifecycle checks pass;
- the pre-deletion target visibly demonstrates the old-backup deletion gap;
- the post-deletion target matches ADR-022's cascade and independent-retention
  expectations;
- no API was started against a restored database;
- no real, candidate, or unreviewed user content entered the drill;
- no secret or sensitive fixture content entered ordinary logs or reports;
- exact resources and secrets were cleaned up; and
- the report says **Local synthetic drill passed** rather than **Production
  recovery ready**.

## 12. Production readiness still open

Even a successful local drill leaves all of the following unresolved:

- automatic backup creation and monitoring;
- approved retention and natural-expiry policy;
- production RPO and RTO;
- encryption, KMS, rotation, off-site storage, and restore authorization;
- role/global-object, extension, infrastructure, and point-in-time recovery;
- a durable, approved mechanism preventing or reapplying deletion when an older
  backup is restored;
- treatment of restored credentials, Sessions, Consent evidence, backups, and
  account-deletion records;
- backup access reviews, incident procedure, and audit evidence;
- provider, log-sink, replica, and other external copies;
- multi-instance lifecycle coordination and operational ownership; and
- a scheduled, independently reviewed production restore exercise.

Therefore the production state remains unchanged. `AI_KNOWLEDGE_ENABLED` remains
false by default, the three candidate articles remain unverified and unpublished,
and this runbook does not enable production AI or close the backup/restore and
account-deletion production blockers.
