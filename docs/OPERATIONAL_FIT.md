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
| `/calendario` | Responsive weekly agenda, reservations and blocks; original annotations remain separately searchable. Existing secondary reservation/block URLs still work. |
| `/presupuestos` | Customer/vehicle/service-first editor without a prior physical intake; adaptive parts/labor lines, optional costs, complete revisions, approval and customer PDF. |
| `/vehiculos/alquiler/?id=<reservation>` | One rental: agreement, departure/return, charged periods, receipts, expenses, photos and contract versions. |
| `/libro-diario` | Receipts, expenses, refunds, transfers and confirmed openings. Archivo original shows readable historic source facts, not guessed postings. |
| `/cobros` | Documents, receipts, allocations, credits and refunds, separate from original historical receivables annotations. |
| `/archivos` | Secondary source-review page, linked from each Excel: organized observations and explicit reconciliation. Not required merely to see the originals. |

The query-ID pages work with the existing static export: IDs are resolved after sign-in through authorized database APIs, not enumerated at build time. Direct URLs do not bypass permissions.

## Simplified workspace

The primary menu is **Inicio, Clientes, Vehículos, Calendario, Taller, Presupuestos, Cargos y cobros, Libro diario**, filtered by the same permissions as before. Technicians still use the restricted assigned-task route behind Taller. Inventory, reports, assistant, configuration and source-review routes remain authorized secondary pages; hiding them from the main menu does not delete their API or data.

The white/gray workspace with a red accent removes duplicate fleet navigation and session/SDK/development banners. Initial loading waits for permissions and data. Adaptive tables retain all fields and mobile headings without page-level or internal horizontal scrolling. Directories, fleet cards, budgets, workshop records, diary, calendar and original facts are paginated. Vehicle cards reserve photography space only when an actual photo exists.

Original Excel views use structured searchable sections rather than a scaled spreadsheet grid. The original file remains byte-identical and privately downloadable; the review page exposes saved cells/formulas by row without a wide table. React renders cell content as text; formulas are never executed. Archive, sheet and cell limits still apply. Financial read permission remains required.

An available car is shown as **Reservado** when it has a confirmed, prepared, non-expired booking. Physically rented/workshop states take precedence. The filter is a commitment overview, not a substitute for date-specific availability in Calendario.

**The explicitly authorized fixture cleanup is complete.** A verified 1,557,013-byte database archive and source snapshot are in private `test-results/before-real-data-1793417922047/`. A rollback rehearsal and preservation hashes preceded removal of 1,085 fixture rows from 57 explicit tables. Users, roles, catalogs, audit and four original files were retained. No reset, cascade or disabled trigger was used.

`scripts/import-real-data.ts` subsequently loaded 16 named source contacts, 27 plated calendar cars and the unplated Nissan Rogue 2018, plus Rafael Vargas's 27-line draft quote totaling 2,190. The importer verifies original hashes, commits transactionally and can repeat without duplicating records. No phone, title, availability, odometer, daily rate, rental year or cash event was fabricated. Missing numeric storage defaults carry explicit `unverified_fields` and are not displayed as known zero values. Registry corrections require evidence, current version and authorization; physical readiness cannot bypass active rental/workshop workflows.

New vehicle registration also accepts unknown odometer, color and rental rate; it does not force a customer-only quote into a rental workflow. It explicitly records unknown status instead of declaring the vehicle available. Identity corrections reuse preserved merge-alias matching. Folios format actual database sequences (`PRE-00002`, `OT-00021`, `CAR-…`, `REC-…`, `ALQ-…`); sequence gaps after rollback are normal and are not replaced with fabricated numbers or UUID fragments.

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

- `in_rental_fleet` is independent of title. The requested real-data load includes the 27 identified calendar cars in the managed fleet, with property and physical status `Por confirmar`. `registered_holder` is not evidence that AJ owns a car. The unplated calendar continuation is not a second vehicle.
- The physical state, future commitments and payment state are distinct. A future booking does not mean the car is physically out today. Paying does not release a car.
- An open-ended rental stores an infinite occupancy boundary, not an invented return date or final price. Its UI and new contract PDFs state that there is no final agreed total. Confirmation still obeys the exclusion constraint.
- When a return date becomes agreed, `set_end` checks conflicts and already billed periods. Actual return shortens physical occupancy independently of the original contract snapshot. Cleaning/review remains a separate release.
- Rental periods use inclusive start/end dates and cannot overlap for the same rental. **Pagado hasta** derives from consecutive settled period documents, including explicit discounts/credits; a free-text `CANCELADO HASTA` note neither cancels the rental nor creates a receipt.
- A rental case contains that rental's share of documents and payments, not other rentals on the same vehicle. The permanent vehicle page remains the cross-operation history.

## Financial boundaries

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
.venv\Scripts\python.exe -B tests/browser/login_acceptance.py
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

Current real-data iteration results (superseding the previous 113-test UI baseline):

| Gate | Verified result |
| --- | --- |
| `npm test` | **121/121** unit/SQL tests passed, including semantic adaptive tables, source-backed import/repeat, pre-intake quotes, registry corrections and ordered migration recovery. The optional unknown-registration extension also passed its targeted nine SQL/recovery assertions. |
| Live PostgreSQL rehearsal | `verify-real-workspace.mjs` passed quote save/replay, case links, registry correction and anonymous-denial checks; rollback preserved registry/audit counts and original hashes. |
| Data integrity | 16 contacts, 28 vehicles, one draft quote, no financial postings, 54 linked/503 pending source observations. |
| Read-only responsive browser | Passed at **320/390/768/1440 px**: eight modules, source views, directory/fleet pagination, customer corrections, optional vehicle registration, real 2,190 quote, 130 commercial draft and 120 internal cost-only draft. No page/internal horizontal overflow, runtime errors or business mutations. All eight workshop case sections additionally passed at 320 px. |
| TypeScript / production build | Passed; **22 static pages** generated. |
| Real HTTP/Auth / originals | `verify-real-api.mjs` passed authenticated endpoint validation, anonymous denial and byte-identical download of all four originals, with unchanged business counts. |

Do not run legacy fixture-producing HTTP, role or browser journeys against this clean workspace. Their selectors and retained data are not acceptance of the new UI. Use isolated SQL tests, read-only browser acceptance and the rollback-only real-database rehearsal. Run heavy PGlite suites separately from browser sign-in on this busy machine: overlapping workloads produced a local Auth HTTP 504 `request_timeout`, while a subsequent direct sign-in succeeded.

The real HTTP run caught a renamed PL/pgSQL function still qualifying a parameter with its previous name. Migration `20261030000700` replaces that qualifier with `$1`; the original business HTTP suite passes after the repair. This is why in-memory SQL tests are not the only gate.

Migration `20261030000900` allows internal cost-only estimates without inventing a commercial price. Migration `20261030001000` rechecks current business-command permissions before returning an idempotent result, including after role revocation.

Migrations through `20261031000400` are applied forward extensions. Quote workspace, verified details, merge-alias integrity and optional unknown vehicle registration have rollback files; migration dependency recovery is tested in isolated databases. **Do not run rollbacks or resets on this used workspace.** Database archives contain private data and must stay out of public assets/source control.

`node --import tsx scripts/stage-client-workbooks.ts` repeats original-file staging safely; it has no publication call. `node scripts/setup-local.mjs --restore-missing-local-owner` only restores an absent generated AJ local identity and never resets an existing password.

## Acceptance still required

Client decisions remain necessary for title/physical-readiness ambiguities, missing calendar years/identities, source financial reconciliation, legal terms and fiscal/valuation policies. Styling and authorized fixture cleanup are implemented, not deferred. Docker Desktop's development port-exposure warning, deployment security, production backups and production-provider configuration remain separate release blockers.
