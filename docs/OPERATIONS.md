# Run the operational workflows locally

Apply migrations through `20261030001000` and sign in using the local account in `.env.local`. The operational routes use Supabase transactions and permissions, not localStorage demo actions. The main menu now has eight business entries; other authorized routes below remain secondary. Original Excel views open directly in Calendario, Presupuestos, Cargos y cobros and Libro diario; choose Gestión for system records. Start with [OPERATIONAL_FIT.md](OPERATIONAL_FIT.md) for the simplified UI and actual-workbook expansion. The 30 literal story criteria are tracked in [ESTADO_HU.md](ESTADO_HU.md); a Spanish usage explanation for each is in [GUIA_HISTORIAS_USUARIO.md](GUIA_HISTORIAS_USUARIO.md). This is not a production sign-off.

## Quick path

| Route | Workflow |
| --- | --- |
| `/vehiculos` | One bar: Toda la flota, Disponibles, Alquilados, Reservados. Customer cars remain in Taller, outside the rental list. |
| `/taller` | Todos los trabajos, Mecánica, Pintura and Tareas within one module. Open a visit for detailed actions. |
| `/taller/ingreso/?id=<order>` | Full visit sheet, inspection/photos, complete manual quote revisions, actual costs/receipt splits, charges/receipts, tasks and delivery. |
| `/vehiculos/alquiler/?id=<reservation>` | Full rental sheet, open-ended occupancy, charged/settled periods, scoped financial history, photos and return. |
| `/archivos` | Four preserved client XLSX originals plus organized, source-addressed observations. Explicit review; staging never posts money. |
| `/libro-diario` | Daily cash receipts, expenses/refunds, transfers and confirmed openings. No duplicate cash for charges/applications. |
| `/calendario` | Draft, confirm, WhatsApp evidence, departure/return inspections, proposed extras and cleaning release. Extension rechecks availability. Open a reservation for immutable contracts/PDF and acceptance evidence. |
| `/cobros` | Issue a document with its own due date, record receipt, explicitly apply/refund it. Import actual payments from XLSX/CSV with preview and reconciliation. |
| `/inventario` | Item, purchase request, owner authorization, partial receipt, order dispatch and return at original cost. |
| `/reportes` | Billed direct contribution with source IDs; versioned commission rules, explicit eligibility and signed adjustments after refunds. |
| `/asistente` | Source-grounded cost question or a frozen, expiring expense proposal requiring exact confirmation. |
| `/configuracion` | Owner-only role/catalog changes, periodic reports, spending plans and local integration inbox. |

Workshop estimates, task timers and reviewed delivery are described in [WORKSHOP.md](WORKSHOP.md).

## Rules that prevent false totals

- Active reservation, workshop and cleaning intervals share a PostgreSQL GiST exclusion constraint. Drafts do not occupy a vehicle. Unknown workshop duration is an explicit open-ended block. Return sets a readiness hold until its own active cleaning/review is explicitly released; cancelled/inactive/unrelated blocks cannot release it. Early return shortens physical occupancy and starts its actual cleaning without changing contractual dates/prices. A late cleaning conflict never erases the physical return.
- Reservation price, charge, receipt and application are separate. A 500 document with 200 applied leaves 300 pending. Cancellation preserves debt. Historical aging considers due date plus effective and recorded dates.
- Internal maintenance budgets may contain estimated costs with a zero commercial total and no commercial margin. No fictitious customer or sale is needed. Business command retries recheck the actor's current permissions before returning a cached result.
- Inventory receipt creates stock and supplier obligation, not vehicle cost or cash payment. Dispatch creates one cost; return restores stock and reduces the net cost. Settle direct purchases through their explicit partial payment action in workshop costs; payment records cash once without acquiring another part or increasing actual cost.
- Commission rates are owner-entered immutable revisions. The selected rule is frozen for the reservation. Only explicitly eligible net receipt applications enter the base. Refunds generate signed adjustments, not another full settlement. Commission calculation is not payroll disbursement.
- `scoped-billed-direct-contribution-v2` reports issued/scoped grouped charges minus credits and actual direct costs, including explicitly assigned rental/vehicle expenses. Source IDs are drillable. It is not cash flow, certified earned revenue or net profit; unvalued labor and unallocated overhead are explicit limitations.
- Contract PDF parties, price, interval and conditions come from that immutable version. New contract PDFs are generated inside the authorized database function; client PDF uploads are rejected rather than trusted by their magic prefix. Existing originals are preserved. The plain paginated template uses Courier/WinAnsi, supports Spanish and explicitly rejects unrepresentable characters. The business supplies legal terms and acceptance evidence. No fiscal certification or electronic-signature provider is invented. Workshop estimate PDFs keep their separate generation workflow.

## Local periodic mail

Messages are captured by the existing Mailpit instance at **http://127.0.0.1:55324**. No SMTP port or public provider is added.

```sh
npm run local:reports:once
npm run local:reports
```

The worker authenticates using local owner configuration, checks schedules every minute, persists cutoff/filters/report snapshot, atomically claims a job and submits it to Mailpit's HTTP capture API. It does **not** send public email.

Claims are one-use, including identical request-key replays. `Enviando` or `Incierto` after a crash/ambiguous response is not automatically resent. Reconcile with the mailbox first. Recipient role authorization is rechecked before claiming.

## Bounded assistant and integration adapter

This is a domain assistant with an explicit language grammar and real database APIs, not a general-purpose LLM or simulated chat transcript:

```text
¿Cuánto costó el vehículo P123 en OT-7?
gasto de 35.10 en OT-7 por aceite
gasto de 12 en centro workshop por limpieza
```

Cost answers identify vehicle, operation, cutoff and source IDs; multiple operations require disambiguation. Proposals freeze normalized amount/destination/account/date, SHA-256 and 15-minute expiry. Confirmation checks actor/hash and returns the actual `EG-` folio once. The assistant cannot bypass cash permissions.

The inbox is an **owner-authorized local expense adapter**, not a public webhook or configured fiscal/WhatsApp service. `source + external_id` correlates an event; changed payload under that identity is a conflict. Failed transactions record error and can be retried after configuration recovery. Successful events return their original business result.

## Spending plans

Purchases and expenses are explicitly associated with a plan. Authorized, unreceived quantities are committed; received supplier obligations are executed. A linked cash payment for those same goods is not executed again. Historical positions reconstruct purchase state from audit and exclude plans, allocations and receipts recorded after the cutoff; a later authorization does not leak into earlier totals. This is the chosen allocation scope, not an inferred classification of all historical spending or a general ledger.

## Verify and recover

```sh
npm test
npm run test:local
npm run test:roles
npm run typecheck
npm run build
```

```powershell
.venv\Scripts\python.exe -B tests/browser/usability_acceptance.py
.venv\Scripts\python.exe tests/browser/login_acceptance.py
```

`npm test` bounds isolated PostgreSQL test concurrency to three workers and includes `tests/review/*.test.ts` so the five independent counterexamples cannot be left outside the standard gate. Usability and login browser checks do not add business records. **`test:local`, `test:roles` and the older full operational browser journeys create/retain synthetic users or records**; never run them to populate real business data. The older broad `acceptance.py` and `rentals_acceptance.py` still require selector/flow updates for the simplified UI. `test:local` runs sequentially to bound Auth/database load; explicit competing requests still execute concurrently. No test resets data.

The October 30 expansion passed **104 unit/SQL tests, six HTTP suites, the full operational browser journey and technician URL checks, TypeScript, SQL lint and the 22-page static build before the simplified workspace**. See [OPERATIONAL_FIT.md](OPERATIONAL_FIT.md) for current UI checks and historical evidence boundaries. All 557 observations from the four actual workbooks remain pending review; none were financially published. Existing test records remain untouched pending explicit cleanup confirmation and backup.

October 30 recovery files must run in reverse order, `20261030001000` through `20261030000100`, only in an isolated unused database. Then `supabase/rollback/20261022002100_review_integrity.sql` restores the pre-review function definitions before `20261022001000_to_002000_operations.sql`. The SQL suite tests reversal/reapplication and refusal after use. **Never run these recovery files against this used workspace.** Prefer forward corrective migrations.

## Business and deployment boundaries

The four real Excel examples are now supplied and privately staged, not blindly published. Their unresolved identities/dates and commercial classifications, calibrated tariffs, tax treatment, legal terms, labor valuation, multi-site policies and external-provider credentials still require validation/configuration. Docker Desktop's existing Supabase port-exposure warning in [LOCAL_SUPABASE.md](LOCAL_SUPABASE.md) remains applicable. Local user-story acceptance does not certify every broader RF or production readiness.
