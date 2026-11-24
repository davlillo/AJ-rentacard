# Work-responsible names without changing account authority

**Schema status: applied to the authorized local database; independent activation audit passed.** T3 implements S1 and S6–S8:
a freely typed work-responsible name, independent of authenticated assignment. Existing phase navigation,
financial gates, account permissions, technician visibility and timer ownership are unchanged.

## User behavior

- **Responsable del trabajo** accepts a name that does not appear in the account list.
- **Cuenta de seguimiento** remains a required eligible authenticated account.
- An old task displays **Sin nombre registrado**, with its account shown separately.
- Managers edit through the existing `assign` command with a reason and the version captured when
  opening the editor. Refresh does not silently rebase that version or overwrite a dirty name.
- Names are ordinary React text, not HTML. A name creates no account or access.

## Storage and command contract

Migration: `supabase/migrations/20261114000200_task_responsible_name.sql`.

| Input | Create | Assign |
|---|---|---|
| `responsibleName` omitted | SQL NULL | Preserve existing name |
| JSON null, empty or ASCII-whitespace-only string | SQL NULL | Clear name |
| String | Trim edges; store name | Trim edges; replace name |
| Number, boolean, array or object | Reject | Reject |
| More than 120 Unicode code points after trimming | Reject | Reject |

Edge trimming uses space, tab, LF, CR, vertical tab and form feed in both SQL and TypeScript.
The native input's `maxLength=120` is conservatively bounded in UTF-16 code units.
`WorkshopTask.responsibleName` is optional and nullable; `assignedTo` and `assigneeLabel` remain required.
There is no backfill, assignment default change, person inference or data rewrite.

The RPC signature stays `execute_task_command(text,jsonb,uuid)`. The migration narrowly replaces
the existing function, rather than wrapping it with a second UPDATE. It retains:

- command validation, shared advisory lock, task row lock and authorization **before replay**;
- actor-scoped idempotency over the **full original payload**, including untrimmed names;
- open-order and expected-version checks, eligible UUID lookup and derived account label;
- one task mutation/audit/version increment, existing transitions, RLS and timer update trigger.

Only `create` and `assign` accept the optional metadata. `transition` rejects its presence with
`UNSUPPORTED_TASK_METADATA`; technician transition authority cannot edit a name.
New metadata requests return `responsibleNameSupported:true`. Legacy requests retain the exact
`{id,version,status}` result shape. A missing acknowledgement is an error, never a success toast.

## Read compatibility and rollout

`loadBusiness()` requests `responsibleName:responsible_name`. It retries only the task selection
without that alias when **42703 or PGRST204 specifically identifies the responsible_name column**.
Other schema failures, authorization errors and connectivity failures propagate normally.
Customers, orders and other data follow their original reads.

The fallback sets `taskResponsibleNameAvailable:false`, disables name entry and explains the required
database update. Legacy task creation remains available without a name field. A draft name is not
silently discarded when capability disappears during editing.

Apply the migration elsewhere only after separate approval and operational review. The user authorized
the local activation recorded below; no business API writes, seed, service restart, installation or Git
mutation was performed.
If an old command implementation unexpectedly ignores metadata while the column exists, the client
reports that saving the name was not confirmed; it does not claim success. The underlying legacy task
mutation may have happened, so refresh before retrying and retain the original idempotency key.

## Non-destructive rollback

`supabase/rollback/20261114000200_task_responsible_name.sql` restores legacy mutations while retaining
the nullable column and **every saved name**. It deliberately rejects metadata requests with
`RESPONSIBLE_NAME_MIGRATION_REQUIRED` after authorization, even if a metadata replay exists.
Legacy payloads continue to work and do not overwrite names.

Because the column remains readable, the UI can still display names after this compatibility rollback;
attempted metadata writes receive a meaningful migration-required error. Reapplying the migration
restores writes without losing names. Dropping the column is not part of rollback: that would require
a separately approved export/data-loss decision.

## Verification and limits

Behavioral RED: before adding the migration, the current command successfully created a task but
discarded `responsibleName`; the isolated test expected `Unlisted mechanic` and received `undefined`.
GREEN uses one PGlite database for the new SQL suite, including rollback/reapply. The old task and timer
suites remain unchanged.

```text
node --import tsx --test tests/task-responsible-name.test.ts tests/task-responsible-name-sql.test.ts tests/tasks-sql.test.ts tests/task-timers-sql.test.ts
npx tsc --noEmit --incremental false
py -3.12 tests/browser/task_responsible_readonly.py
```

Targeted Node result: **21 passed, 0 failed**. TypeScript: exit 0.
The browser uses synthetic known HTTP responses and aborts unknown endpoints. It covers unlisted
create/edit names, unchanged UUID/account label, stale-version draft retention, keyboard/error focus,
revoked manager controls, UUID timer ownership, old rows and missing-column fallback at
1440/1024/390/320. Captures reset scroll to zero before full-page screenshots in
`test-results/task-responsible/`; the final `verification.json` is authoritative.

The initial browser run exposed a too-narrow mobile name column and blocked devtools stack resolution.
The correction reflows task cells into a single column and answers the exact local devtools endpoint
synthetically. A later diagnostic exposed duplicate synthetic IDs in the fixture; only that fixture
was corrected before a blocker-limited rerun.

These targeted checks prove isolated behavior, not live database authorization, production deployment,
participant usability or concurrent transaction scheduling. The parent subsequently completed the
application suite, build and synthetic rental-receipt integration checks recorded below.

## Authorized local activation

Only `20261114000200_task_responsible_name.sql` was applied at `2026-11-15T04:11:41Z` to the verified local
`supabase_db_aj-rentacar` container, atomically with its history record and schema notification.
The file SHA256 is `F325D25F3AC4EC5DA932AFEECD479EFA6E6063C6362527B45DCA5CB2DC05A7DE`.

A fresh independent snapshot confirmed that all 61 public tables and 2,135 rows retain their normalized
contents, excluding only the additive task column from both sides. Existing assignment, version, timer,
RLS, policy, grant and trigger fingerprints match. Migration history increased from 40 to 41 entries,
with all earlier entries unchanged.

The executor completed schema/function/grant/projection readback. Initial independent supplemental
probes encountered audit-tooling errors, not demonstrated database failures. After separate user
authorization, a fresh independent read-only batch completed the remaining checks successfully:
exact history reconstruction and function-body bytes, nullable text/no default or generated identity,
column ACL/effective privileges, and authenticated empty-column projection. Anonymous/PUBLIC RPC
execution and direct authenticated task updates remain denied. The batch ended with ROLLBACK and
performed no database writes, migration replay, service changes or business-record reads.

Final evidence: `test-results/task-responsible-activation/independent-final.json`.
Temporary snapshot/application scripts were removed after audit completion; evidence and intentional
implementation recovery backups remain. Reload the workshop screen to refresh schema capability.

The final application suite passed 292 tests and production generation passed 26 pages. These results
do not replace live authorization, application-write or production-concurrency verification.
