# Local Supabase and controlled expense imports

The operational mode uses an isolated AJ Supabase project, real sessions and database authorization. The browser-only demo remains available. No production project is linked, and no browser data is automatically imported.

## Current status

The minimal AJ stack runs with forward migrations through `20261102000100`. The authorized fixture cleanup and subsequent source-backed data load are complete; the 27 imported fleet cars now have explicitly confirmed initial availability. See [OPERATIONAL_FIT.md](OPERATIONAL_FIT.md). Complete verified private archives precede cleanup, the availability update and the connected-money extension. No unrelated project was reset or deleted. Earlier fixture-producing HTTP suites are historical evidence, not a reason to repopulate this workspace.

The November 2 API/Auth outage was recovered with a Docker Desktop stop/start after a normal restart timed out. This briefly interrupted shared containers, which resumed automatically; no volumes were removed or databases reset. All pending API, responsive usability/redesign, login and session-recovery checks subsequently passed sequentially. Final hashes of all 59 existing AJ public tables were unchanged. Docker logs recorded disk-full errors before the freeze; C: has approximately 7 GB free, so preserve additional disk headroom rather than treating a restart as a storage fix.

The startup wrapper creates the dedicated network recommended by Supabase with `host_binding_ipv4=127.0.0.1`. **Docker Desktop on this machine still publishes ports on `0.0.0.0` / IPv6 despite that option.** The wrapper detects and warns about this. Keep this development machine on a trusted network and never expose these ports publicly; a localhost URL alone is not a security boundary. Restrict host port publication before loading sensitive real-world data or deploying.

The SQL acceptance suite runs independently using PGlite. That verifies actual PostgreSQL functions, constraints, migrations and RLS, but not Supabase HTTP/Auth, multiple database connections, browser interaction or disk recovery.

## Start

```sh
npm ci
npm run local:start
npm run local:migrate
npm run local:setup
npx next dev --hostname 127.0.0.1 --port 3030
```

In another terminal, run `npm run local:reports` for the minute-based report worker (or `npm run local:reports:once` for one cycle). Reports are captured only in Mailpit at `http://127.0.0.1:55324`; no public email service is configured. See `OPERATIONS.md` for recipient authorization, one-use claims and uncertain-delivery handling.

`local:start` excludes unused realtime, storage, image processing, logs, pooling, Studio and pgMeta services. Original import files are private database bytes for the bounded pilot, not public Storage objects. Studio/pgMeta health checks failed on this busy machine and are not needed for the operating flows. The CLI may mark Kong as still starting; the wrapper additionally waits for an actual successful API readiness response instead of treating `--ignore-health-check` as proof of health. The first startup applies migrations automatically; `local:migrate` applies subsequent migrations without resetting data.

| Service | Address |
| --- | --- |
| Application / browser acceptance | http://127.0.0.1:3030 |
| AJ API / Auth | http://127.0.0.1:55321 |
| AJ PostgreSQL | 127.0.0.1:55322 |
| AJ Studio | Not started by default; port 55323 reserved |
| Local email viewer | http://127.0.0.1:55324 |

Ports 54321–54324 belong to another local project and are not changed.

`local:setup` only accepts AJ's loopback API URL. It creates a random local owner account and writes `.env.local` without overwriting an existing configuration. Read `AJ_LOCAL_OWNER_EMAIL` and `AJ_LOCAL_OWNER_PASSWORD` there to sign in. Neither value uses a `NEXT_PUBLIC_` prefix. The service-role key is never written into the browser configuration. Windows file ACLs still govern local file access; keep this file private.

To return to the prototype, set `NEXT_PUBLIC_DATA_SOURCE=demo` and restart Next.js. Existing demo localStorage is preserved and is never copied into the operational database.

## Verify in order

```sh
npm test
npm run typecheck
npm run build
node scripts/verify-real-workspace.mjs
node scripts/verify-real-api.mjs
```

Browser acceptance on Windows (start the application on port 3030 first):

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r tests/browser/requirements.txt
.\.venv\Scripts\python.exe -m playwright install chromium
.\.venv\Scripts\python.exe tests/browser/usability_acceptance.py
.\.venv\Scripts\python.exe tests/browser/redesign_acceptance.py
.\.venv\Scripts\python.exe tests/browser/connected_money_acceptance.py
.\.venv\Scripts\python.exe tests/browser/login_acceptance.py
.\.venv\Scripts\python.exe tests/browser/session_recovery_acceptance.py
```

These browser checks are read-only for business records and save ignored private screenshots under `test-results/`. The real-database verification calls the new RPCs inside a rolled-back transaction and confirms unchanged counts/hashes. They do not use personal browser profiles or reset the database. Run heavy PGlite suites before, not concurrently with, browser sign-in to avoid resource-induced local Auth timeouts.

`redesign_acceptance.py` simulates populated monthly reservations, blocked dates, costs, charges, receipt applications and private-photo propagation only inside the isolated browser. Business writes are blocked before reaching the API; no test photos, reservations or money are persisted. The ordinary usability run still checks the actual live-data workspace at 320/390/768/1440 px.

`connected_money_acceptance.py` additionally exercises capture from diary and folio, one expense split across three jobs, a linked advance before billing, application of an existing receipt without new cash, and an existing cost incorporated into a complete budget revision. Its populated responses exist only in the browser; before/after financial-table snapshots verify no real writes.

`node scripts/apply-connected-money.mjs` defaults to a real PostgreSQL rollback rehearsal. The authorized `--apply` path verifies a private archive and unchanged hashes for existing business tables before completing the schema extension. Never substitute a reset or an import of historical workbook balances.

**Do not run `test:local`, `test:roles` or the legacy `acceptance.py`, `rentals_acceptance.py`, `operational_fit_acceptance.py` against this clean workspace.** Those suites retain synthetic users/business records. Run them only against a separately provisioned disposable environment; never use production.

Manual acceptance:

1. Create two different customers. Search a phone and document with different punctuation. Attempt a duplicate and verify it is rejected.
2. Register a customer-owned vehicle. Its file must show its actual owner. A company-owned vehicle has no customer owner.
3. Receive it using only customer, vehicle, area and reason. Verify the unique `OT-` folio, actor, timestamp and explicit pending inspection fields.
4. Record an expense for that order. Verify the same `EG-` folio and amount in the ledger and vehicle file. Reload in another browser session.
5. Merge the source customer into the other customer with a reason. Verify the vehicle, order, expense and old contact search remain linked.
6. Test a reception/technician account against the Data API directly. Cash must not become visible by bypassing the UI.

The initial UI refreshes shared data on focus, reconnection and every 15 seconds, without overlapping checks. A renewed access token also triggers a new permission/data check. Command results trigger an immediate reload. Failed reloads do not turn a committed command into a second write.

### Session recovery after a restart

An HTTP 200 from `/inicio/`, a healthy Auth endpoint or successful direct SQL is not proof that the browser loaded its authorized workspace. Verify a real sign-in, a saved-session reload, permissions and actual business data.

If the operational-session load fails, **Reintentar** renews the saved session before reloading permissions and data. **Volver a ingresar** clears only the current session, not sessions on other devices. A transient failure does not publish an empty workspace or reset records. Diagnostic logs include only failure codes and the affected resource, never tokens, credentials or business values.

`session_recovery_acceptance.py` checks real sign-in/persistence, simulated permission/data outages, rejected access tokens, expired session metadata, an invalid refresh token and local sign-out. API failure simulations happen only in the isolated test browser; no service is stopped and no business-mutating RPC is called.

## Security and scope

- Public sign-up is disabled. Roles are assigned by trusted administration, never client metadata.
- Tables grant read access through RLS. Authenticated clients cannot directly insert, update or delete business rows or assign roles.
- Mutations run through `execute_command`, with explicit permission checks, a pinned search path, transactional audit and user-scoped idempotency keys.
- Customer creation checks active identities and preserved merge aliases. Concurrent pilot writes use a single advisory transaction lock; measure throughput before replacing it with ordered aggregate locks.
- Merging checks both customer versions. Original rows and contact snapshots remain available; no cash amount is changed or summed.
- Money is stored as PostgreSQL numeric, in USD for this delivery. Taxes and commercial policies are not invented.
- Expense references identify existing open workshop operations or a real cost center, never a fabricated vehicle.
- New operational modules are gated. Prototype-only transitions, assistant actions and resets cannot write the operational database. The import wizard uses separate authorized RPCs, private staging, version checks and explicit reconciliation.

Workshop tasks are managed separately through `execute_task_command`: responsible user required, versioned transitions and reasoned reassignment. Office users can manage assignments; technicians can read/transition their assigned tasks and record their own server-timed work in `/tareas`. They do not gain access to the full work order, customers, cash or other technicians' times. Completing a task does not close its siblings or the order and does not automatically record work time.

HU08–HU12 add deterministic tariff-based estimates, immutable approved versions and PDF bytes, destination-bound actual costs, audited task timers and reviewed delivery. Migration `20261022002100` adds explicit partial payments for direct purchases without duplicate actual costs. See [WORKSHOP.md](WORKSHOP.md) for the workflow and explicit inspection/valuation boundaries.

Rentals, payment documents/applications/imports, inventory, contracts, commissions, reports and owner controls now have operational workflows. See [OPERATIONS.md](OPERATIONS.md). Private photo uploads have isolated SQL and browser-response simulation coverage; no synthetic photos are persisted in the real workspace. Production file provisioning, calibrated labor valuation, external-provider setup and production administration/security remain separate acceptance boundaries. RPCs expose fixed commands, not arbitrary SQL or arbitrary HTTP access.

## Migration recovery

Prefer a forward corrective migration once operational data exists. `supabase/rollback/20261022000100_operational_foundation.sql` is an explicit development-only rollback: it refuses to run if business data exists. The automated SQL suite tests apply → rollback → reapply on an empty database. Never run `db reset` or delete volumes to repair a live instance.

## Import scope and parser

The vulnerable registry version `xlsx@0.18.5` was replaced with the official `0.20.3` tarball from `cdn.sheetjs.com`, with integrity recorded in the lockfile. Official source: https://docs.sheetjs.com/docs/getting-started/installation/nodejs/. `npm audit --omit=dev` now reports zero known vulnerabilities. This is not a complete security audit of the parser.

Expenses and customer payments have separate bounded import workflows. Payments are real receipts, never disguised as expenses. See `IMPORTACIONES.md` for source identity, ambiguity resolution and remaining broader RF05 work. The shared parser bounds expansion/rows/columns, flags formulas and preserves spreadsheet calendar dates.
