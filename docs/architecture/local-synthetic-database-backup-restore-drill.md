# Local Synthetic Database Backup and Restore Drill

## Status

- Scope: NF-04 local learning/demo design plus protected tooling foundation
- Delivery: fixture loader and minimum orchestration harness are implemented on a
  feature branch; the first drill remains separately gated
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

No ADR is required for this runbook and bounded tooling. It details the already-recorded
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

Before restore, run `pg_restore --list` and compare the archive's size and SHA-256
with the values fixed when that recovery point was completed. `--list` proves only
that the archive table of contents can be read; it does not validate every
archived data block. Size and digest comparison identifies the exact drill artifact but is not
authentication against an attacker who can replace both the file and manifest.
Only a complete restore and the validation in section 8 can prove that the drill
archive is usable. After restore, run `ANALYZE` and that validation.

The archive digest is operational evidence for this synthetic file only. It is
not stored in application tables, derived from an individual message, or used as
a request/content fingerprint or durable idempotency ledger.

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
- [System administration functions](https://www.postgresql.org/docs/18/functions-admin.html)
  define backend signaling behavior, including the difference between sending a
  termination signal and confirming that the backend actually exited.

PostgreSQL also warns that restoring an archive executes SQL originating from
the source. Only an archive produced by this same controlled drill may be used.
An untrusted archive must never be restored by this runbook.

## 3. Isolated topology and resource budget

Each run gets an unguessable run ID such as `20260913-143000-a1b2c3d4` and a
machine-readable local manifest. Before any mutation, the manifest contains the
planned exact names and expected image digest. After creation, each actual Docker
object ID, database OID, and PostgreSQL system ID is appended before the next
phase. A later phase never treats a planned identity as an observed identity.

| Resource                     | Required form                                           |
| ---------------------------- | ------------------------------------------------------- |
| Source container             | `mh-nf04-<run-id>-src`                                  |
| Restore container            | `mh-nf04-<run-id>-restore`                              |
| Source volume                | `mh_nf04_<token>_src_data`                              |
| Restore volume               | `mh_nf04_<token>_restore_data`                          |
| Network                      | `mh_nf04_<token>_network`                               |
| Source control database      | `mh_nf04_<token>_source_control_test`                   |
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

The artifact directory is one dedicated host bind mount, not a PostgreSQL data
volume. It is mounted read-write at `/nf04-output` in the source container and
read-only at `/nf04-input` in the restore container. The source and restore
PostgreSQL data volumes remain separate. The host orchestrator creates the
artifact directory with access limited to the current operator and the required
container identity, verifies its canonical path before either container starts,
and never grants a broad workspace write permission.

### 3.1 Run-local identities

The drill uses three bounded identity classes:

| Identity               | Responsibility                                                                                                                                                                 | Explicitly excluded                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Initialization manager | Create the two container-local drill roles and named `_test` databases; read `pg_control_system()` and `pg_stat_activity`; if required, signal only the exact restore backend. | Application traffic, fixture content, ordinary API use, cluster-global export.                  |
| Source/migration role  | Own the source database application objects; apply migrations, load the approved fixture, support the isolated API, and read the source for `pg_dump`.                         | Creating roles or databases, signaling backends, accessing the restore server.                  |
| Restore role           | Own each precreated restore target and the objects restored with `--no-owner`; run restore validation.                                                                         | Creating roles, signaling unrelated sessions, application traffic, accessing the source server. |

The initialization manager is the container-local bootstrap identity created for
this run, not an application administrator. Its credentials are destroyed at
cleanup. The source and restore roles receive only the privileges required in
their own named database. The manager performs system-ID and activity checks
from the verified control database; the other roles cannot silently substitute
for it.

Container initialization uses a protected run-local environment file outside Git.
Client commands use a run-local, read-only password file mounted into only the
appropriate container and set `PGPASSFILE` explicitly. Every PostgreSQL command
also supplies explicit host/socket, port, user, and database arguments. The
isolated API receives an explicit run-local connection value in its process
environment. No command reads, sources, or falls back to the repository `.env`.
No credential or connection string is written to the redacted manifest or logs.

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

## 4. Phase-specific resource and mutation guards

The `_test` suffix is necessary but not sufficient, and a guard may only require
facts that exist in the current resource phase. The run state advances in the
manifest only after the current row's success evidence is fixed:

| Resource phase and next operation                                | Required checks before the operation                                                                                                                                                                                                                                                                                                                                                    | Success evidence and next state                                                                                                                  |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Planned; create host directory, network, volumes, and containers | Exact planned names do not exist; chosen ports are free; canonical artifact path is an absent/new child of the NF-04 root; disk and resource budgets pass; image reference/digest is approved. No database or system-ID assertion is made yet.                                                                                                                                          | Record created Docker object IDs, exact names, image digest, labels, ports, and canonical artifact path.                                         |
| Containers created; initialize roles/databases                   | Re-inspect exact object IDs, names, image digest, mounts, ports, and labels. Connect only to the container's explicitly configured control database as the run-local initialization manager, then record its actual `system_identifier`. Catalog checks prove each planned application role/source database is absent before creation; the named control database is expected to exist. | Record role/database ownership and exact source/restore system IDs. Never connect to a default database discovered from project configuration.   |
| Source database empty; migrate or load fixture                   | Revalidate source container ID/labels/system ID. Connect explicitly to the exact `_test` source database as the source/migration role. Require the expected empty/migrated state for the requested transition and `APP_ENV=test`.                                                                                                                                                       | Record migration head and bounded fixture validation; source becomes populated.                                                                  |
| Source populated; call deletion endpoint or dump                 | Revalidate source identity, exact database, role, system ID, migration head, and expected fixture state. For deletion, only the isolated API connection is permitted. For dump, require quiescence and zero application connections.                                                                                                                                                    | Record confirmed deletion receipt/state or completed archive evidence, never an inferred result.                                                 |
| Restore database absent; create target                           | Revalidate restore container ID/labels/system ID. Connect to the verified restore control database as initialization manager and require the exact target name to be absent in the catalog.                                                                                                                                                                                             | Create the exact `_test` target owned by the restore role; record its catalog identity.                                                          |
| Restore target created; begin restore                            | Connect explicitly as restore role; require `current_database()` to equal the manifest target, no application tables, no other target sessions, and a completed archive whose size/digest match the fixed evidence.                                                                                                                                                                     | Bind and record the exact restore backend identity; target becomes restoring.                                                                    |
| Restore completed; validate target                               | Revalidate restore resources, system ID, exact target, restore backend exit, and quarantine. The target is expected to be populated, so the pre-restore empty check no longer applies.                                                                                                                                                                                                  | Record full schema/data/lifecycle validation or quarantine as failed.                                                                            |
| Restore failed or result unknown; inspect or discard target      | Revalidate the exact restore object IDs, system ID, database, and original writer state. Do not assume the target is empty.                                                                                                                                                                                                                                                             | Classify as proven empty rollback, complete validated restore, or quarantined unknown/anomaly.                                                   |
| Cleanup; stop/drop/remove exact resources                        | Before stop, inspect the exact container ID and verify its current name, labels, image digest, mounts, and recorded role; when responsive, also verify system ID. Inspect volume/network IDs and labels before container removal, then re-inspect them before their removal.                                                                                                            | Record each exact resource as removed. If already absent, record that fact; never operate on a same-name replacement with a different object ID. |

For every database-connected phase, `current_database()` must exactly match the
manifest and end in `_test`. For every application or fixture phase,
`APP_ENV=test` must be explicit. No normal application process, shared test
process, or other task may connect. Artifact paths must resolve under the exact
run directory.

Any unavailable, missing, or mismatched required signal stops the next operation.
It is not permissible to bypass a guard merely to stop or clean up. A resource
that is already absent is reported as absent; a resource found by the same name
but a different ID is treated as foreign and left untouched. Never fall back to
a database discovered from `.env`, a default Compose service, a broad name
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
content.

### 5.1 Protected loader and harness boundary

The repository now contains a narrow NF-04 protected tooling implementation:

- `Nf04DrillHarness` fixes the phase order and stops at an unknown account-
  deletion or restore result. Each real side effect remains an injected action so
  unit tests cannot accidentally start Docker or call the deletion endpoint.
- `Nf04ArchiveManager` constructs fixed `pg_dump` and `pg_restore --list`
  argument arrays, rejects pre-existing output, monitors the partial archive
  against the remaining aggregate budget while the exact writer is active,
  keeps one caller/deadline signal through listing and final evidence, verifies
  content through a stable file handle before and after listing, verifies the
  first archive before allowing the second, and uses a same-directory no-clobber
  publication before recording size and SHA-256 evidence. A writer
  whose exit cannot be proved remains quarantined and its partial file cannot be
  listed, published, restored, or removed by the normal cleanup path. The partial
  inspection wait also races the operation signal; a hung filesystem inspection
  therefore enters the independent exact-writer stop/exit boundary, and any late
  inspection result cannot resume listing or publication.
- `Nf04RestoreCoordinator` treats timeout, client loss, and nonzero completion as
  unknown. It identifies the exact Docker exec object rather than treating the
  host Docker CLI PID as writer-exit proof. An independent unified reconciliation
  deadline covers stopping and inspecting that exec plus database scans,
  cancellation, termination, and the final absence proof. PostgreSQL
  `backend_start` remains a lossless microsecond-precision string in every
  identity comparison. Caller cancellation requests writer stop but cannot cancel
  the bounded reconciliation. The coordinator never labels reconciliation as a
  successful restore.
- Destructive backend signaling checks out a dedicated manager connection only
  after the manager identity check, then rechecks the same cancellation signal and
  remaining reconciliation budget before issuing SQL. A connection acquired after
  cancellation or budget expiry is released without issuing signal SQL. Once SQL
  has been dispatched its outcome may be unknown; timeout or failure destroys only
  that checked-out control client and keeps the restore quarantined rather than
  claiming the signal was withdrawn.
- `Nf04DockerInspector` reads only exact recorded container/network IDs and the
  recorded volume name. It compares live IDs, labels, image, mounts, loopback
  port, volume mountpoint/driver, and network evidence; it does not discover a
  substitute by a broad name search.
- `loadNf04Fixture` checks `APP_ENV=test`, exact database name/OID/system ID/role,
  and the full ordered migration-hash history before opening one transaction.
  Stable synthetic
  IDs cover the relationships in section 5. Exact re-entry validates the whole
  fixture; partial or conflicting state fails without being overwritten.
- Protected secret and archive paths are checked using the selected platform path
  semantics and then against the real filesystem root, parent, link type, and
  file identity. Archive operations additionally require the exact run directory
  derived from the repository root and run ID, with its real path outside the
  repository. Windows drive and UNC roots are not interchangeable. An absent
  output is accepted only after its real parent is verified; only `ENOENT` means
  absent. Publication rechecks the captured boundary and file identity; any future
  cleanup adapter must do the same before it is wired.
- Harness failures expose only bounded code/stage metadata. Raw exception text,
  credentials, connection strings, and filesystem paths are not copied into the
  report or quarantine action.

The only installed command entry is deliberately narrow:

```text
pnpm --filter @mental-health/api nf04:drill validate-manifest <absolute-manifest-path>
pnpm --filter @mental-health/api nf04:drill load-fixture <absolute-manifest-path>
```

The command reads no repository `.env`, accepts no connection string or password
on the command line, emits only allowlisted run metadata, and obtains credentials
from the exact protected run-local file named by the redacted manifest. Loading
also performs a fresh exact Docker inspection and database identity query. The
full harness is not exposed as an executable command in this batch. Real resource
creation, source migration, Session/CSRF account deletion, exact Docker exec
integration, stable-handle archive publication, restored-data validation, and
verified resource cleanup remain unwired and have not received execution review.
This is a fail-closed staged delivery, not an invitation to call internal classes
manually.

Tests use fake process/Docker-exec/backend/archive-publication adapters and
task-specific temporary filesystem paths for archive and restore failure paths.
They exercise the writer budget, identity, timeout, cancellation,
late-completion, path-replacement, and report-redaction contracts without
starting Docker, `pg_dump`, or `pg_restore`.
One integration suite creates a uniquely
named database ending in `_test` on an already protected test server, migrates it
from zero, loads or rejects the fixture, and drops only that exact generated
database after rechecking the PostgreSQL system identity. That limited database
test is not the two-container drill and does not produce an archive.

The exact-exec port is a safety contract, not a concrete production adapter in
this batch. Its `stop` operation must synchronize with any in-flight `start`: when
`stop` resolves, that same exec cannot start later, and `waitForExit` must then
return a definite exit code for that exec. If an adapter cannot prove those
properties it must reject, leaving the run quarantined. Fake barrier tests cover
this ordering; a real Docker Engine adapter and real engine behavior remain Not
verified.

Archive publication has the same staged boundary. The manager requires a port
that binds no-clobber publication and partial-name removal to already captured
root, parent, and file identities using platform-safe relative-handle primitives.
No pathname-only production adapter is included; the current adapter exists only
inside tests and writes within its generated temporary run directory.

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
structured argument passing rather than interpolating untrusted strings. Each
command also supplies the explicit run-local socket/host, port, role, database,
`PGPASSFILE`, and, where applicable, unique `PGAPPNAME`; shortened examples below
do not authorize defaults.

### A. Preflight and setup

1. Confirm repository HEAD, operator identity, host load, free disk, Docker
   health, free loopback ports, and no other task using the chosen resources.
2. Generate the run ID, exact names, credentials, artifact directory, and labels;
   prove the planned resources do not exist.
3. Create the protected host artifact directory and run-local credential files.
4. Start two fresh `postgres:18.6-alpine` containers with separate data volumes,
   with the artifact directory mounted read-write at `/nf04-output` in source and
   read-only at `/nf04-input` in restore.
5. Re-inspect the actual resources and record container/volume/network IDs, image
   digest, ports, mounts, and labels.
6. Through each container-initialized, explicitly named `_test` control database,
   create the run-local roles and source database, but not the restore targets;
   then record each server's actual
   `pg_control_system().system_identifier`.
7. Prove the applicable section 4 guards and write the redacted manifest before
   proceeding.

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
docker exec -e PGPASSFILE=/run/secrets/nf04-source.pgpass `
  $sourceContainer pg_dump `
  -h /var/run/postgresql -p 5432 -U $sourceRole -d $sourceDatabase `
  -Fc --no-owner --no-privileges --lock-wait-timeout=5s `
  -f /nf04-output/.pre-delete.dump.partial
```

The command refuses to start if either its partial or final path already exists.
Enforce the dump timeout and size limit. After `pg_dump` exits successfully and
the partial file handle is closed, run `pg_restore --list` against that partial
file. If the archive table of contents is readable, use an exact-path host filesystem operation
to rename it atomically to `pre-delete.dump` without overwriting another file.
Record the final file's byte size and SHA-256 in the manifest and mark that
recovery point complete. A timeout, nonzero exit, unreadable directory, rename
failure, or size violation leaves a failed partial artifact that cannot be
restored.

Do not transfer the archive through stdout, a text pipeline, clipboard, or
shell-encoded content. The restore container observes the same completed host file
through its read-only `/nf04-input` mount. Immediately before restore, recompute
size and SHA-256 from `/nf04-input/pre-delete.dump` and require exact equality with
the fixed manifest values. This comparison is repeated for each recovery point.

### D. Delete the synthetic account

1. Revalidate the source identity and start exactly one isolated API process.
2. Authenticate as the synthetic User, acquire CSRF through the real Session flow,
   and call the account-deletion endpoint with the stable operation ID and test
   credential.
3. Require the confirmed success response, stop the API, and prove quiescence.
4. Validate the post-deletion primary state before creating another archive.

### E. Create the post-deletion archive

Repeat the protected dump, archive-list, size, and checksum procedure into
`.post-delete.dump.partial`, then atomically finalize `post-delete.dump`. Do not
overwrite the first archive. Revalidate the source container and then stop it
before any restore begins, so it can no longer write to `/nf04-output`.

### F. Restore both recovery points

For each archive, first revalidate the restore server, create the named target from
the verified control database, and prove that it is fresh and empty. Recompare the
read-only archive size and SHA-256 with its fixed manifest entry. Assign a unique
application name such as `mh-nf04-<run-id>-restore-pre`, and then run the equivalent
of:

```powershell
docker exec -e PGPASSFILE=/run/secrets/nf04-restore.pgpass `
  -e "PGAPPNAME=$restoreApplicationName" $restoreContainer pg_restore `
  -h /var/run/postgresql -p 5432 -U $restoreRole -d $restoreTarget `
  --single-transaction --exit-on-error --no-owner --no-privileges `
  /nf04-input/<archive>.dump
```

Do not use `--clean`, `--create`, parallel jobs, selective table restore, or a
previously failed target. A failed target can be dropped and recreated only after
the original restore writer has been proven absent and all exact identity and
label guards are rerun.

Before launch, the initialization manager records the exact target database OID
and proves that no session uses the unique application name. The harness allocates
and records the exact Docker exec identity before it starts the container command;
the host Docker CLI PID is diagnostic only and cannot prove that `pg_restore` has
exited. Because parallel jobs are disabled, one server backend performs each
restore. As soon as it appears in
`pg_stat_activity`, the manager records its `pid`, `backend_start`, target database
OID/name, restore role OID/name, unique `application_name`, and connection
endpoint. `backend_start` is preserved at PostgreSQL microsecond precision and is
never round-tripped through a JavaScript `Date`. The manager does not read or
record the `query` column. A PID without the matching lossless `backend_start` and
every other field is not the original writer and must never be signaled. Even an
exact Docker exec exit requires a final proof that no backend with the unique
identity remains before validation; an unknown client result always follows
section 9.1.

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

| Failure                                                                  | Required behavior                                                                                                               |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Wrong database name, container, volume, network, label, or system ID     | Stop before mutation; do not search for a substitute target.                                                                    |
| Missing, altered, or unreadable archive                                  | Fail archive listing/checksum; do not start restore.                                                                            |
| PostgreSQL image or tool version mismatch                                | Stop before dump or restore.                                                                                                    |
| Insufficient disk, excessive load, size limit, or timeout                | Stop and preserve bounded diagnostic evidence.                                                                                  |
| Restore SQL or constraint failure                                        | Treat the target as unresolved until the original backend exits; only then distinguish empty rollback from an anomalous target. |
| Restore timeout, connection loss, or client termination                  | Treat outcome as unknown; identify and settle the exact original backend before inspecting, cleaning, or retrying.              |
| Restore reports success but backend identity or validation is unresolved | Keep the target quarantined; do not promote command success into a verified restore.                                            |
| Account-deletion result unknown                                          | Do not take or label the post-deletion backup until exact reconciliation succeeds.                                              |
| Validation mismatch                                                      | Quarantine both targets, mark the drill failed, and do not start an API.                                                        |

A restore failure is never retried over the same partially used target. The target
is proven empty or is recreated under the exact guarded name. A process exit code,
a disconnected client, or a temporary read-only view with no application tables is
insufficient evidence of rollback.

### 9.1 Restore-writer reconciliation

Each restore has a 180-second operation deadline and the exact server-side identity
recorded in section 7F. Unknown-result reconciliation receives its own single,
monotonic deadline; it is not reset for each sub-operation and is not cancelled by
the original caller. On timeout, client loss, termination, or an otherwise unknown
outcome:

1. stop all new work for that target and keep the target and restore server
   quarantined;
2. stop the exact recorded Docker exec object and inspect/wait for that same exec
   to exit within the shared deadline, so a host CLI exit cannot hide a later
   container writer or server connection;
3. connect as the run-local initialization manager through the verified restore
   control database and revalidate the restore container ID and system ID;
4. query `pg_stat_activity` without selecting `query`, restricting by the recorded
   target database OID/name, restore role OID/name, and unique application name. If
   a single still-active match was not recorded earlier, record its `pid` and
   `backend_start` now; more than one match is an anomaly and no backend is
   signaled;
5. if the exact backend still exists, request cancellation using the lossless
   `(pid, backend_start)` identity and wait within the same reconciliation deadline
   for that exact backend to disappear;
6. if it remains, and only while all identity fields still match, use
   `pg_terminate_backend(pid, positive_timeout_ms)` as initialization manager, then
   independently query until the exact backend is absent; and
7. require that no other restore-role or drill application-name connection exists
   for the target before opening a validation connection.

PostgreSQL documents that `pg_terminate_backend` with its default zero timeout
returns true when the signal was sent, whether or not the process has actually
terminated. This runbook therefore requires a positive timeout and an independent
absence check. If the exact Docker exec cannot be proven exited, the PID has been
reused, `backend_start` differs, another field does not match, the server cannot be
reached, or absence cannot be proven before the reconciliation deadline, do not
signal an uncertain backend and do not inspect or reuse the target. Preserve
quarantine and mark the outcome Not verified.

Only after the original writer is proven absent may validation classify the target
as one of:

- a complete restore whose full section 8 checks pass;
- a proven empty rollback with no application objects and no restore writer; or
- an anomalous/partial state that stays quarantined and is never reused.

The restore target is never treated as empty merely because uncommitted objects
are invisible to another MVCC snapshot. No second restore, target drop, container
stop, or failed-target cleanup starts while the original writer might exist. A
recreated target receives the same exact name only after its previous catalog row
is dropped under the verified manager identity and the absence check is repeated;
the prior outcome remains recorded as failed/unknown.

## 10. Resource and secret cleanup

Cleanup is explicit and recoverable until validation evidence is complete:

1. while the containers are still present, inspect the exact recorded IDs and
   verify their current names, image digest, mounts, ports, run/role labels, and
   the recorded volume and network IDs/labels;
2. prove no restore writer remains and, when each database is responsive, confirm
   its recorded system ID through the verified control database;
3. stop and remove only those two verified container IDs;
4. re-inspect the exact recorded volume and network IDs, names, and labels after
   container removal, then remove only those two volumes and that one network;
5. if an expected object is already absent, record it as absent; if the same name
   resolves to a different object ID, leave it untouched and fail cleanup review;
6. resolve every artifact path and require it to be a child of the exact NF-04 run
   directory;
7. remove secret environment files and database archives; and
8. retain only the redacted manifest, SHA-256 values, validation summary, timings,
   and cleanup receipt if the review requires them.

Do not use `docker system prune`, `docker volume prune`, wildcard container
deletion, a recursive delete against a computed broad directory, or the project's
normal Compose resources. A cleanup mismatch stops cleanup and requests manual
review rather than guessing.

If a database that should be responsive cannot provide its system ID, automated
cleanup stops. If the database is already known to be unresponsive, exact current
Docker object ID/name/image/mount/label verification may authorize stopping that
container only; its data volume and artifacts remain quarantined for manual review.
Unavailability is never treated as a successful identity check or permission to
remove a volume.

## 11. Evidence and acceptance checklist

### 11.1 Static procedure walkthrough

This table is a documentation review of the future path. It is not evidence that
any drill step has run.

| Step                   | Available input and acting identity                                                             | Required guard                                                                                                         | Success condition                                                   | Failure exit                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Plan and create        | Approved image digest, run ID, exact absent names, operator, initialization manager credentials | Planned-state checks in section 4                                                                                      | Exact Docker IDs/labels/mounts and canonical artifact path recorded | Create nothing further; leave foreign/same-name resources untouched |
| Initialize source      | Verified source control database; initialization manager, then source/migration role            | Container/system identity; application-role/source-database catalog absence; explicit `_test` control and target names | Roles/source database created, migrations 0000-to-head applied      | Stop before fixture; retain bounded diagnostics                     |
| Load fixture           | Approved test-only loader and stable synthetic IDs; source/migration role                       | Exact source DB, `APP_ENV=test`, migration head, fixture bounds                                                        | Complete synthetic relationship set validates                       | Roll back loader; no archive                                        |
| Pre-deletion archive   | Quiescent populated source; source role; writable partial path                                  | Source identity, zero app sessions, path absent, resource/time limits                                                  | Finalized unique-name archive plus fixed size/digest evidence       | Partial remains unusable; no final recovery point                   |
| Controlled deletion    | Isolated API connection and stable operation ID                                                 | Exact source identity, only isolated API active, Development/Test feature rules                                        | Confirmed API result and verified post-delete rows                  | Unknown result stops sequence; reconcile same operation only        |
| Post-deletion archive  | Quiescent verified post-delete source                                                           | Same dump/path guards with distinct absent filename                                                                    | Second final archive plus independent size/digest evidence          | No post-delete recovery point                                       |
| Create restore targets | Verified restore control DB and initialization manager                                          | Exact restore IDs/system ID; each target absent from catalog                                                           | Two fresh `_test` targets owned by restore role                     | Do not connect to or drop any substitute target                     |
| Restore each archive   | Fixed manifest evidence, read-only archive mount, restore role                                  | Target empty; archive size/digest match; no target sessions                                                            | Command returns and exact restore backend exits                     | Reconcile section 9.1; quarantine on uncertainty                    |
| Validate               | Offline restored target and exact synthetic expectations; restore role                          | Writer absent, exact target/system ID, no API connections                                                              | Section 8 schema/data/lifecycle checks pass                         | Quarantine; never start API                                         |
| Cleanup                | Recorded Docker/database/artifact identities; initialization manager/operator                   | Pre-stop identity checks, writer absence, canonical child paths                                                        | Only exact run resources and secrets removed                        | Stop cleanup; do not touch same-name replacements                   |

The required negative walkthroughs are also bounded:

- a missing/mismatched resource ID, label, system ID, database, or path stops
  before mutation and never substitutes a same-name object;
- a partial, transferred-but-mismatched, or unreadable archive never enters
  restore and never replaces a completed recovery point; and
- a restore timeout or disconnect remains unknown until the exact writer exits;
  inability to prove that exit keeps the target isolated and blocks retry/cleanup.

### 11.2 Acceptance evidence

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

The tooling tests completed before that first execution do not satisfy this
checklist. In particular, actual PostgreSQL 18.6 image startup, migrations inside
the source container, `pg_dump`, `pg_restore --list`, both archive handoffs,
account deletion, restore-writer observation/exit, restored-data validation, and
resource cleanup remain **Not verified** until the separately authorized drill.

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

`ACCOUNT_DELETION_ENABLED` remains false by default and may be enabled only for
the bounded Development/Test source step described here. `ADMIN_AUTH_ENABLED`
remains false. The Production Safety Lock remains Enforced, Production AI Chat
remains Disabled, `productionSafe=false`, and real model safety evaluation remains
Not evaluated.
