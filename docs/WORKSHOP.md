# Versioned estimates, actual costs and reviewed delivery

HU08–HU12 use the local operational database, not the localStorage prototype. Run `npm run local:migrate` before opening `/presupuestos`, `/taller` or `/tareas`.

The October 30 workflow now starts in the full `/taller/ingreso/?id=<order>` sheet, with intake photographs, inspection, free-line complete quote revisions, receipt splits and atomic collections. See [OPERATIONAL_FIT.md](OPERATIONAL_FIT.md). The tariff path below remains supported; it is not required to create every ad-hoc workshop budget.

## Quick path

1. In **Presupuestos**, create a tariff revision with its internal cost and commercial price. Reusing a code creates a new revision; it does not replace old prices.
2. Select a work order, tariff revisions and quantities. Choose commercial prices, target margin **or** markup; calculate on the server and save the complete scope with a reason.
3. Record the customer's decision, name and evidence. A discount requires the owner role to approve. Download the PDF for that exact version/status.
4. In **Taller → Costos y clasificación**, record an unexpected direct purchase against its order, supplier and invoice/line reference. It starts pending. Classify it with a reason; included/additional customer work needs an approved scope from that order.
   To settle that acquisition, use **Pagar compra directa** on the same cost. Partial cash payments show their own `EG-` references and remaining balance, without adding another actual cost. Settlement is allowed after workshop delivery and never rewrites its original receipt.
5. In a task in progress, the assigned worker can start the server timer, pause, resume and finish it. Finish all timers before finishing/reassigning the task. Closed intervals can be corrected with a reason and optimistic version check.
6. Open **Revisar entrega**. Ordinary delivery rejects pending cost dispositions, unfinished tasks and a pending estimate decision. An exception requires the owner and a reason; open timers cannot be overridden. The receipt freezes its checklist, responsible actor and evidence.

## Rules that preserve history

| Topic | Behavior |
| --- | --- |
| Calculation | PostgreSQL decimal arithmetic, line-level half-up rounding to cents, explicit policy/currency and tariff revision snapshots. No tax rate is assumed. |
| Scope changes | A new version is a complete revised scope, not an automatically additive supplement. Previous approved scope and decisions remain intact. Only approval changes the order's estimate. |
| PDF | Client-visible fields are whitelisted; internal costs/margins are excluded. A licensed local font is embedded. Original bytes and SHA-256 are private and retained per version/status. Generation occurs in the authorized browser; this is not a certified server signature or fiscal document. |
| Actual cost | Existing/new imported cash expenses have one corresponding cost record. A direct purchase is a cost, not a cash payment or customer charge. Supplier plus invoice/line reference prevents re-entering the same direct source. |
| Commercial disposition | Included, approved additional, internal or absorbed. A disposition does not automatically create a charge. Company-owned vehicles cannot be classified as a customer sale. |
| Time | Server timestamps close active spans. Pauses add no active seconds. A technician has at most one active timer. Corrections retain old/new values and actor in audit, require a reason and cannot overlap another interval. |
| Delivery | A shared transaction lock serializes checklist validation with other business commands. Receipt snapshots cannot be edited. Owner-only late cost/disposition adjustments are separately audited and never rewrite the original receipt. |
| Availability | Delivering a company-owned vehicle does not automatically make it rentable. Calendar/cleaning release is handled by the operational HU13 workflow. |

## Explicit boundaries

- Incomplete reception/inspection fields remain visible. The visit sheet now captures immutable inspection and actual private photos. Delivery still requires acknowledging missing evidence rather than silently completing it.
- Delivery now uses the immutable RF15 document ledger, not the former quote-minus-paid placeholder. Unbilled approved scope remains a pending item. A positive document balance requires an owner credit reason.
- Labor timers do not yet generate labor cost using approved, frozen internal rates. Inventory consumption, partial receipt and supplier obligations are now operational; see `OPERATIONS.md`. Direct-purchase cash payment must not be entered as another independent cost.
- Direct-purchase payments explicitly reference the acquired cost. They cannot exceed its unpaid amount. The generic expense form rejects an order expense with the same invoice/line reference as an existing direct purchase, directing the user to its linked payment; it never guesses identity from equal amounts. Existing historical expenses are not automatically reclassified.
- Tariff calibration, tax policy and business acceptance require the business's real examples. Synthetic tests do not supply those policies.

## Verification and recovery

```sh
npm test
npm run test:local
npm run typecheck
npm run build
```

Run `.venv\Scripts\python.exe tests/browser/acceptance.py` with the app on port 3030 for desktop/mobile sign-in, quotes/PDF, direct costs, timers and reviewed delivery. Tests retain clearly synthetic records and never reset the database.

`supabase/rollback/20261022000500_to_000900_workshop.sql` removes migrations 0005–0009 **only when those modules contain no data**, after newer dependent modules have been reversed in an isolated recovery environment. The SQL suite tests rollback/reapplication and refusal after use. Never run it against this used local database; use a forward corrective migration.
