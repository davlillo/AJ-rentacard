# Connected vehicle, workshop and rental cases

The October 30 expansion implements workflows derived from the four client workbooks. The subsequent simplified interface preserves the transactional APIs, Auth/RLS, audit trail and historical records while reducing the main navigation to eight business areas. Technical verification is not commercial, tax, legal or production acceptance.

## Quick path

| Route | Purpose |
| --- | --- |
| `/inicio` | Business dashboard: fleet, workshop, receivables, cash movements and upcoming bookings. Amounts come from authorized operational records, not unreviewed Excel observations. |
| `/clientes` | Paginated customer directory, verified contact corrections, identity matches and reviewed merges. |
| `/vehiculos` | One filter bar: Toda la flota, Disponibles, Alquilados, Reservados. Only explicit rental-fleet members appear. Ownership and fleet membership are independent. |
| `/vehiculos/expediente/?id=<vehicle>` | Permanent vehicle page: independent visits, rentals, costs, documents, photos and fleet data. |
| `/taller` | Todos los trabajos, Mecánica, Pintura and Tareas within the same module; customer cars remain outside the rental fleet. |
| `/taller/ingreso/?id=<order>` | One workshop visit: intake inspection, photos, complete quote revisions, purchases, split receipts, tasks, collections and reviewed delivery. |
| `/calendario` | Six-week monthly calendar, colored commitments and a reservation list that highlights the selected date range. Existing reservation/block dialogs and secondary URLs still work. |
| `/presupuestos` | Customer/vehicle/service-first editor without a prior physical intake; adaptive parts/labor lines, optional costs, complete revisions, approval and customer PDF. |
| `/vehiculos/alquiler/?id=<reservation>` | One rental: agreement, departure/return, charged periods, receipts, expenses, photos and contract versions. |
| `/libro-diario` | Receipts, expenses, refunds, transfers and confirmed openings. Archivo original shows readable historic source facts, not guessed postings. |
| `/cobros` | Operation cards showing budget, incurred costs, cash paid, charges, applied receipts and outstanding balance. Imports, grouped documents and adjustments remain in a secondary disclosure. |
| `/archivos` | Secondary source-review page, linked from each Excel: organized observations and explicit reconciliation. Not required merely to see the originals. |

The query-ID pages work with the existing static export: IDs are resolved after sign-in through authorized database APIs, not enumerated at build time. Direct URLs do not bypass permissions.

## Simplified workspace

The primary menu is **Inicio, Clientes, Vehículos, Calendario, Taller, Presupuestos, Cargos y cobros, Libro diario**, filtered by the same permissions as before. Technicians still use the restricted assigned-task route behind Taller. Inventory, reports, assistant, configuration and source-review routes remain authorized secondary pages; hiding them from the main menu does not delete their API or data.

The white/gray workspace with a red accent removes duplicate fleet navigation and session/SDK/development banners. Initial loading waits for permissions and data. Adaptive tables retain all fields and mobile headings without page-level or internal horizontal scrolling. Directories, fleet cards, budgets, workshop records, diary, reservation lists and original facts are paginated. Vehicle cards offer private real-photo upload; missing photos use a neutral placeholder, never invented car photography. Uploaded photos also appear in cases, budget screens and collection cards.

Original Excel views use structured searchable sections rather than a scaled spreadsheet grid. The original file remains byte-identical and privately downloadable; the review page exposes saved cells/formulas by row without a wide table. React renders cell content as text; formulas are never executed. Archive, sheet and cell limits still apply. Financial read permission remains required.

An available car is shown as **Reservado** when it has a confirmed, prepared, non-expired booking. Physically rented/workshop states take precedence. The filter is a commitment overview, not a substitute for date-specific availability in Calendario.

**The explicitly authorized fixture cleanup is complete.** A verified 1,557,013-byte database archive and source snapshot are in private `test-results/before-real-data-1793417922047/`. A rollback rehearsal and preservation hashes preceded removal of 1,085 fixture rows from 57 explicit tables. Users, roles, catalogs, audit and four original files were retained. No reset, cascade or disabled trigger was used.

`scripts/import-real-data.ts` subsequently loaded 16 named source contacts, 27 plated calendar cars and the unplated Nissan Rogue 2018, plus Rafael Vargas's 27-line draft quote totaling 2,190. The importer verifies original hashes, commits transactionally and can repeat without duplicating records. No phone, title, availability, odometer, daily rate, rental year or cash event was fabricated. Missing numeric storage defaults carry explicit `unverified_fields` and are not displayed as known zero values. Registry corrections require evidence, current version and authorization; physical readiness cannot bypass active rental/workshop workflows.

New vehicle registration also accepts unknown odometer, color and rental rate; it does not force a customer-only quote into a rental workflow. New vehicles explicitly included in rental fleet start available; non-fleet quote vehicles retain unconfirmed physical status. Availability does not fabricate mileage or replace the rental departure/intake inspection. Identity corrections reuse preserved merge-alias matching. Folios format actual database sequences (`PRE-00002`, `OT-00021`, `CAR-…`, `REC-…`, `ALQ-…`); sequence gaps after rollback are normal and are not replaced with fabricated numbers or UUID fragments.

## Workshop visit

1. Prepare a quote directly by selecting a customer, vehicle and service, or receive a vehicle that physically arrived. A pre-intake work record has status `Presupuesto` and creates no occupancy or cash event. Saving the actual inspection activates reception. An internal fleet-maintenance visit has `internal_job=true` and no fictitious customer. Every independent visit gets another order/folio.
2. In **Recepción**, record the actual odometer, fuel, condition and accessories. Save actual intake photographs under **Fotos y documentos**. Missing fields remain visible until supplied; acknowledgement at delivery is not fabrication of evidence.
3. In **Presupuestos**, enter parts/labor lines with quantities, optional estimated costs and customer prices. Leave unknown costs empty. The simplified editor replaces the tariff setup UI; existing tariff APIs and old snapshots are retained. An incomplete cost estimate has no complete margin. Each saved version is the entire revised scope; approval requires evidence. Draft totals round each line half-up before summing; the server validates and freezes the saved result.
   Internal maintenance may budget known costs with a zero commercial total; no commercial margin or customer sale is invented.
4. Record direct purchases once. Paying that purchase produces an expense linked to the acquisition, not another cost. Split a single receipt across several concepts/quote lines without creating more purchases or payments. Dirty split drafts survive a refresh and require review if the cost version changed.
5. In **Cargos y abonos**, bill only the approved amount not already charged. A new receipt and its selected application are atomic; an overpayment cannot leave an orphan cash receipt.
6. Review delivery. Open timers, unresolved tasks/costs and unbilled approved scope remain blockers. Credit authorization and exceptions identify the owner and reason. Fleet workshop delivery does not itself certify rental readiness; schedule and review its release in **Bloqueos**.

### Workbook acceptance examples

- Initial scope **1,856**, approved revised scope **2,190**, additional charge **334**, applied customer receipt **750**: remaining debt **1,440**.
- One **120** supplier receipt may be described as **75 + 25 + 20**. It remains one acquisition and one full payment, with three allocations.
- A budget's **750 abono** inside a section titled `COSTOS LIBRO DIARIO` is not an expense. Section headings do not determine financial type.

## Rental fleet and open-ended rentals

- `in_rental_fleet` is independent of title. The 27 imported calendar cars were initially unconfirmed. On November 1, the user explicitly confirmed their initial availability; all 27 are now **Disponible**, with mileage, rental rate and ownership still pending where unknown. `registered_holder` is not evidence that AJ owns a car. The unplated calendar continuation is not a second vehicle.
- The physical state, future commitments and payment state are distinct. A future booking does not mean the car is physically out today. Paying does not release a car.
- An open-ended rental stores an infinite occupancy boundary, not an invented return date or final price. Its UI and new contract PDFs state that there is no final agreed total. Confirmation still obeys the exclusion constraint.
- When a return date becomes agreed, `set_end` checks conflicts and already billed periods. Actual return shortens physical occupancy independently of the original contract snapshot. Cleaning/review remains a separate release.
- Rental periods use inclusive start/end dates and cannot overlap for the same rental. **Pagado hasta** derives from consecutive settled period documents, including explicit discounts/credits; a free-text `CANCELADO HASTA` note neither cancels the rental nor creates a receipt.
- A rental case contains that rental's share of documents and payments, not other rentals on the same vehicle. The permanent vehicle page remains the cross-operation history.

## Financial boundaries

### Capture in the diary or the folio

Migration `20261102000100` connects capture points without requiring a diary-first workflow:

1. **Registrar gasto** uses the same form from Libro diario, a workshop folio, a budget or Cargos y cobros. Select a workshop destination immediately, or explicitly leave it **Por asociar**. Other vehicle, rental and administration destinations remain available.
2. Associate an existing workshop expense from the diary or a folio's **Costos** section. A single cash source can be split across several jobs; the split must equal the original amount. The source expense is not rewritten and another cash outflow is not created. Linking to delivered work requires management.
3. **Presupuestos → Costos ya registrados** shows source expenses. Incorporating a cost adds a draft line with its internal cost and a persistent origin allocation; enter the customer price separately. Opening a revision from a job retains the complete previous scope. Approval and differential charge issuance remain separate actions.
4. **Registrar cobro / anticipo** is shared by diary, folio and collection card. An intended advance is visible in its operation before a charge exists. Applying an existing receipt later does not create another cash inflow; unapplied money is never shown as settled debt.

The diary shows original cash events, searchable client/vehicle/folio links, **Por asociar** and **Por aplicar** filters, daily movement cards and account balances only when confirmed. A shared expense appears in full once in the diary; each folio counts only its allocated share. Quote revisions, source allocations and applications are not additional cash events. Collection cards distinguish partial payments and delivered work with an open balance.

New RPCs retain permission checks, a pinned search path, transactional audit and actor-scoped idempotency. Invalid allocations, duplicate destinations, stale cost versions and incompatible customers reject the entire operation. The guarded down migration refuses to discard used linkage records.

### Edit a budget and select the diary context

- **Presupuestos → Editar presupuesto** is visible in each list row and at the top of the detail view. Add, change or remove lines, enter the reason and save. Editing starts from the latest complete revision, even when an older revision is being viewed; its parent remains fixed while editing so a concurrent revision is rejected rather than silently losing scope.
- Saving creates another **draft version of the same workshop folio**, not a second work order. Earlier versions, expenses, charges and receipt applications remain linked to that operation. A revision is not a cash event or automatic debt; approval and differential charge issuance are still explicit.
- **Libro diario → Folio de taller o contrato de alquiler** groups workshop folios separately from rental contracts/reservations. Selecting one filters its original movements and preselects that operation when opening **Registrar gasto** or **Registrar cobro**. **Todo el diario** keeps general capture available; select the destination inside the form instead.
- Rentals show their real `ALQ` folio, vehicle, customer and start date; drafts are labeled as reservations, not signed contracts. Empty lists explain that no rental has been registered. A contract's money belongs to its rental operation, not to a particular PDF version. Internal maintenance accepts costs/expenses, not customer receipts.

The diary retains its selected operation, focused movement and date range in its URL, including after a browser reload. Case, rental, collection and budget reads follow the existing shared refresh on focus, reconnection and the 15-second check. A late response cannot replace a newer case/collection/quote read. A server refresh updates facts without reinitializing the open budget editor; its unsaved lines and original parent remain unchanged, so a conflicting revision requires explicit review rather than a silent rebase.

### Distinct financial facts

| Fact | Meaning |
| --- | --- |
| Quote price | Proposed/approved complete commercial scope; not cash. |
| Actual cost | Acquisition, workshop expense or consumed stock; not automatically a customer charge. |
| Charge/document | Receivable with its own due date; not cash. |
| Receipt | One actual cash inflow; an advance can remain unapplied. |
| Application/reversal | Allocates or reverses a receipt against debt; never another cash entry. |
| Transfer/remesa | Moves the same funds between accounts; net zero across all accounts. |
| Opening/noncommercial cash | Explicit reviewed treasury facts; not assumed sales or vehicle costs. |

Grouped documents have one external reference and explicit operation lines. GPS deductions need a reason and owner authorization. Payments, refunds and credits must specify line amounts; the system never distributes a header equally or repeats it per car. Vehicle contribution and commissions use those scoped allocations.

The diary computes an account balance only with a confirmed opening at/before the requested start and no unresolved refund accounts. Historical refunds lacking a confirmed outgoing account remain unassigned. A displayed movement total is not a certified complete bank balance. Labor valuation, depreciation, guarantees and overhead policies are not invented.

### Read an operation card

1. **Presupuesto** is the latest proposed scope, not money received. A newer draft does not erase the prior approved scope that is still billable.
2. **Costos del trabajo** are incurred costs; **Pagado en caja** is the separate cash view. Do not add the two together. Rental cards show their actual paid expenses. Internal maintenance is not a customer sale.
3. **Cargos emitidos → Abonos aplicados → Por cobrar** use only that operation's document amounts and applications, not every receipt belonging to its customer.

The links connect budget, operation, collections and diary. A filtered diary still shows complete original receipts/refunds, which may cover more than one operation; it hides global account totals rather than presenting them as scoped totals. Applications are not another diary inflow.

The customer quote PDF uses AJ branding, frozen customer/vehicle details, quantity/unit-price/amount columns, repeated page headers and numbered footers. The actual 27-line quote fits in two pages, including the total. Internal costs, margins and unposted historical advance/balance controls remain outside the customer PDF.

## Actual workbook review

The four originals from `docs/excels/` are conserved in private local database tables, with SHA-256 and read authorization. They are not copied into public web assets.

| Original | Prepared observations | Safeguard |
| --- | ---: | --- |
| `LIBRO DIARIO EJEMPLO MAYO 2026.xlsx` | 431 | Supports all 707 physical rows; separates controls from business observations. |
| `Ejemplo presupuesto taller.xlsx` | 72 | Retains parts/labor lanes, actual dates, mixed abono and manual controls. |
| `ejemplo calendario carros renta.xlsx` | 28 | 27 plated rows, one unplated continuation unresolved; 12 open-ended annotations retained. |
| `Ejemplo cuadro cuentas por cobrar.xlsx` | 26 | Preserves the first debtor and grouped CCF/GPS descriptions without invented line amounts. |

These are **review observations**, not a count of transactions to import. After the source-backed entity load, **54 are linked** (27 fleet identities and 27 quote lines), **503 remain pending**, and **zero are published financial movements**. The original quote's 750 advance and 1,440 balance remain clearly labeled source annotations, not received cash or a newly issued debt.

1. Consult the original directly in its business module; follow **Revisar y vincular datos** when ready to reconcile it. Compare **Organizado** with the referenced original sheet/cells. Original formula text and cached values are visible but are never executed or silently recalculated.
2. Exclude controls/non-movements with a reason, or link an observation to an existing verified record. A source is not published again once linked/published.
3. For a genuinely new expense, customer receipt or vehicle, enter the missing verified fields and evidence. Financial publication requires an explicitly reconciled amount. Similar date/amount candidates require linking or a reasoned confirmation of a different real fact.
4. Build complete budgets, rentals and grouped documents through their operation pages, resolving identities and dates there; then link their source observations. The API can publish reviewed proposals, but the UI deliberately does not invent a complete quote, lease or grouped allocation from one ambiguous row.

No client workbook photos existed. Photos must be captured/uploaded: PNG/JPEG/WebP or PDF support, up to 2 MB per private vehicle attachment. Source workbooks allow 5 MB compressed, 30 MB declared expanded ZIP data, 20 sheets, 2,000 rows/50 columns per sheet and 20,000 nonempty cells. The older **tabular** batch importers retain their separate 500-row limit.

## Verification and recovery

```powershell
npm test
node scripts/verify-real-workspace.mjs
node scripts/verify-real-api.mjs
npm run typecheck
npm run build
.venv\Scripts\python.exe -B tests/browser/usability_acceptance.py
.venv\Scripts\python.exe -B tests/browser/redesign_acceptance.py
.venv\Scripts\python.exe -B tests/browser/connected_money_acceptance.py
.venv\Scripts\python.exe -B tests/browser/login_acceptance.py
.venv\Scripts\python.exe -B tests/browser/session_recovery_acceptance.py
```

Before the workspace simplification, the expansion passed **104 unit/SQL tests** and **six local HTTP/Auth/RLS suites** through migration `20261030001000`. SQL/unit coverage includes `vehicle-cases-sql`, `fleet-periods-sql`, `grouped-billing-sql`, `cash-diary-sql`, `rental-case-sql`, `source-review-sql`, `source-workbooks`, `renamed-checklist-sql`, `internal-estimates-sql` and `command-replay-permissions` tests. Actual PostgreSQL HTTP coverage is in `tests/local/cases.test.ts` and `tests/local/grouped-cases.test.ts`, alongside all previous local suites. The expanded role-browser test denies new case/original-file routes to technicians.

That pre-simplification operational browser run also passed:

- Workshop inspection/photo, approved **1,856 + 334 − 750 = 1,440**, one **120 = 75 + 25 + 20** purchase and reviewed ordinary delivery. The unsaved split, quote-line targets and reason survive opening/cancelling the global expense dialog and both resulting case refreshes.
- Diary cash movement **750 − 120 = 630**, without another cash entry for documents or applications.
- Open-ended rental confirmation, period charge, atomic receipt/application and departure/return.
- One grouped **290** document with a GPS deduction and an explicit **90 / 60** allocation of one **150** receipt.
- Actual Excel organized/original navigation and byte-identical original download; no page-level overflow on the three new pages at **390 px**, and no browser runtime errors.

The pre-simplification build generated **22 static pages**, including `/vehiculos/alquiler`. TypeScript, local `public,private` SQL lint and the repeated technician direct-URL browser check passed. That dependency audit reported zero known production vulnerabilities; it does not replace a current security audit. Browser evidence is under `test-results/case-summary-desktop.png`, `case-mobile.png`, `rental-case-mobile.png` and `source-books-mobile.png` (private synthetic test records, not public assets).

The current UI gate is `tests/browser/usability_acceptance.py`: eight navigation entries, one four-filter fleet bar, source-backed names, readable numeric folios, customer/fleet pagination, real 2,190 quote detail, material/labor **2 × 45 + 45 − 5 = 130**, original sections and navigation at **320/390/768/1440 px**. It checks both page and internal-container overflow, not just the document width, and asserts that no business-mutating RPC was called. Screenshots use the private `test-results/real-ui-` prefix.

Previous real-data iteration results (before the November 1 card/calendar/PDF redesign):

| Gate | Verified result |
| --- | --- |
| `npm test` | **121/121** unit/SQL tests passed, including semantic adaptive tables, source-backed import/repeat, pre-intake quotes, registry corrections and ordered migration recovery. The optional unknown-registration extension also passed its targeted nine SQL/recovery assertions. |
| Live PostgreSQL rehearsal | `verify-real-workspace.mjs` passed quote save/replay, case links, registry correction and anonymous-denial checks; rollback preserved registry/audit counts and original hashes. |
| Data integrity | 16 contacts, 28 vehicles, one draft quote, no financial postings, 54 linked/503 pending source observations. |
| Read-only responsive browser | Passed at **320/390/768/1440 px**: eight modules, source views, directory/fleet pagination, customer corrections, optional vehicle registration, real 2,190 quote, 130 commercial draft and 120 internal cost-only draft. No page/internal horizontal overflow, runtime errors or business mutations. All eight workshop case sections additionally passed at 320 px. |
| TypeScript / production build | Passed; **22 static pages** generated. |
| Real HTTP/Auth / originals | `verify-real-api.mjs` passed authenticated endpoint validation, anonymous denial and byte-identical download of all four originals, with unchanged business counts. |

### November 1 redesign verification

- **130/130 unit/SQL tests passed**, including the connected operation-card/diary example: a 2,190 approved charge, one 120 purchase/payment, one 750 receipt/application, 1,440 outstanding and 630 net cash. Replay and rejected overpayment never leave a second receipt.
- TypeScript and the production build passed; all **22 static pages** were generated.
- Read-only live-data acceptance passed at **320/390/768/1440 px**, including all eight modules, the four fleet filters, collection breakdown/expense form, monthly calendar and all eight workshop-case sections at 320 px.
- Browser-only simulations passed date-range selection, month navigation, draft/returned states, expanded blocked events, connected collection actions, the 2 MB photo limit and photo propagation to case/budget/collection views. These simulations do not create database fixtures.
- The real 27-line customer PDF was rendered and visually inspected: two pages, complete line items and totals, with no internal costs or historical payment controls.
- Final real API/Auth verification passed, including byte-identical downloads of all four originals. The PostgreSQL rollback rehearsal preserved business counts/hashes, and all seven session-recovery checks passed again after the build.

### November 2 connected-money verification

- **141/141 unit/SQL tests passed** with `node --import tsx --test --test-concurrency=1 tests/*.test.ts tests/review/*.test.ts`. TypeScript and the **22-page** production build passed.
- The new browser-only journey passed at **320/390/768/1440 px**, without page or internal horizontal overflow: split an existing 180 expense as 75/100/5, capture another 20 from the folio, receive a linked 200 advance, issue a 500 charge, apply 100 from the existing receipt, and incorporate a source cost into a complete 590 draft revision. These amounts are temporary simulations, not real business movements. Financial-table snapshots were unchanged.
- Native PostgreSQL migration/rollback/reapply rehearsal passed. Applying the extension preserved hashes of existing business records after a verified private backup. Evidence is in `test-results/connected-money-migration-1793648691816.json`; responsive screenshots use the `connected-diary-` prefix.
- The post-recovery real API run passed Auth, existing quote/registry endpoints, all **four connected-money endpoints**, expense-inbox access, anonymous denial and four byte-identical originals (`test-results/real-api-verification-1793652446781.json`), without business writes.
- **The environment blocker is resolved.** Docker logs recorded disk-full errors before the API/Auth freeze. A normal Desktop restart timed out; the supported forced Desktop stop followed by start recovered the existing containers without deleting volumes, resetting data or reimporting. Shared containers resumed automatically. All AJ services are running; DB/Auth/Kong health checks pass.
- Updated general usability and populated redesign acceptance passed sequentially at **320/390/768/1440 px**, including eight modules, original facts, calendar, connected collections and photo propagation. Login and all **seven session-recovery scenarios** passed. The connected-money browser journey also passed again after recovery.
- Final integrity comparison found **all 59 existing public-table hashes unchanged** from the migration evidence, with zero receipt contexts and no real financial postings (`test-results/recovery-final-integrity-1793652738166.json`).

The previously pending local verification gates are closed. C: still has approximately 7 GB free; maintain disk headroom to avoid another Docker outage. This work does not redefine commercial delivery/credit policy or implement promises to pay or individual customer statements.

### Budget-edit and diary-context follow-up

- The full isolated suite passed **142/142** tests. The final rental-label/Salvador-date boundary refinement additionally passed its **11/11** targeted checks. TypeScript and the **22-page** production build passed.
- Read-only usability passed again at all four widths, including opening **Editar presupuesto** on the real 27-line, 2,190 draft, retaining its complete scope and identity, adding an unsaved 20 line to preview 2,210, and cancelling without a business write.
- The connected browser journey passed visible editing from the list/header, editing the latest complete scope from a historical detail view, grouped workshop/rental selectors, automatic capture preselection and the internal-maintenance receipt guard. Populated calendar, collection and photo regression also passed.
- The real API/originals check passed again (`test-results/real-api-verification-1793654563384.json`). Final comparison found all 59 public-table hashes unchanged (`test-results/quote-diary-clarity-integrity-1793654649600.json`); no migration, real rental, budget revision or financial fixture was persisted by these checks.
- Private screenshots use `budget-edit-action-`, `diary-rental-selector-` and `real-ui-quote-edit-` prefixes. Source backups are under `test-results/before-quote-diary-clarity-1793653432289/` with `.bak` extensions.

### Cross-screen refresh follow-up

- New browser regressions reproduced diary selection loss on reload and a workshop case remaining at a simulated 590 after an external draft became 640. Draft quote creation does not increment the work-order version; a version/count-only refresh key was insufficient.
- The expanded connected journey now passes operation/date persistence at four widths, focus-driven case/collection/budget/rental updates, an older delayed response arriving last, preservation of an unsaved 695 edit after a simulated external 740 revision, and a stale-save conflict without draft loss or automatic rebasing. All examples remain browser-only, not actual finance.
- Updated general usability, populated redesign and all seven session-recovery cases passed sequentially. The **17/17** targeted connected-money/operation-finance tests, TypeScript and **22-page** build passed. The earlier full-suite result remains 142/142; this refresh-only follow-up used targeted SQL coverage and the expanded browser regressions.
- Final API/original verification passed (`test-results/real-api-verification-1793657043080.json`), and all 59 existing table hashes remained unchanged (`test-results/connected-refresh-integrity-1793657051954.json`). No schema migration, business fixture, reset or reimport was required. Prior source/test copies are under `test-results/before-connected-refresh-1793656072827/`.

Do not run legacy fixture-producing HTTP, role or browser journeys against this clean workspace. Their selectors and retained data are not acceptance of the new UI. Use isolated SQL tests, read-only browser acceptance and the rollback-only real-database rehearsal. Run heavy PGlite suites separately from browser sign-in on this busy machine: overlapping workloads produced a local Auth HTTP 504 `request_timeout`, while a subsequent direct sign-in succeeded.

The real HTTP run caught a renamed PL/pgSQL function still qualifying a parameter with its previous name. Migration `20261030000700` replaces that qualifier with `$1`; the original business HTTP suite passes after the repair. This is why in-memory SQL tests are not the only gate.

Migration `20261030000900` allows internal cost-only estimates without inventing a commercial price. Migration `20261030001000` rechecks current business-command permissions before returning an idempotent result, including after role revocation.

Migrations through `20261102000100` are applied forward extensions. The fleet-availability migration permits an explicit availability decision independently of unknown mileage. Its recovery and dependent migration chains are tested in isolated databases. `scripts/confirm-fleet-availability.mjs` defaults to a rollback rehearsal; its authorized `--apply` path verifies a complete private archive before using versioned, audited per-vehicle RPCs. The November 1 application preserved all other vehicle facts, all 17 current customers, the four original files, the draft quote and the zero-finance state. The additional customer found since the previous 16-contact baseline was retained, not overwritten.

`scripts/apply-connected-money.mjs` rehearses the connected-money migration and guarded rollback in real PostgreSQL, including transient split/advance/application cases reverted to a savepoint. Its `--apply` path verifies a private archive and before/after hashes of every existing public table. The November 2 application changed no business records. It does not import or repost the original workbooks.

**Do not run rollbacks or resets on this used workspace.** Database archives contain private data and must stay out of public assets/source control.

`node --import tsx scripts/stage-client-workbooks.ts` repeats original-file staging safely; it has no publication call. `node scripts/setup-local.mjs --restore-missing-local-owner` only restores an absent generated AJ local identity and never resets an existing password.

## Acceptance still required

Client decisions remain necessary for title/physical-readiness ambiguities, missing calendar years/identities, source financial reconciliation, legal terms and fiscal/valuation policies. Styling and authorized fixture cleanup are implemented, not deferred. Docker Desktop's development port-exposure warning, deployment security, production backups and production-provider configuration remain separate release blockers.
