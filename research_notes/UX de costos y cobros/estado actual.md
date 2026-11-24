# Current-state evidence supplied by the source-audit handoff

This English research note records the verified handoff received on 2026-11-14. The report writer did not independently reread the application, execute commands, inspect database services, or test behavior. File references and line ranges below are evidence locations supplied by the auditor, not newly verified citations. Only this note and the final research report are authorized outputs.

## Cost identity is split across separate compositions

`workshop-case-screen.tsx:103–114` renders `WorkshopCosts`, then an outer `CaseCostAllocations` for each cost. `case-cost-allocations.tsx:9–46` adds a nested accordion and repeats the cost description and amount. The operator therefore encounters the same cost through detached list and breakdown surfaces.

`workshop-costs.tsx:43–87` mixes commercial classification and supplier-payment controls in its third column. Competing entry points above it include registering an expense, linking an existing expense, budget actions, and direct purchase. Opening classification for a pending cost defaults to Internal. Changing this behavior requires an explicit policy/default-safety decision; the handoff does not establish a regression or authorize a fix.

## Expense distribution, itemization, and payment are different operations

`allocate_cost`, in `supabase/migrations/20261030000100_vehicle_case_files.sql:147–154,192–209`, accepts any `workshop_costs` kind, including direct purchase. It replaces active child allocations, requires their total to equal the cost, and increments a version. It creates no expense, purchase, or customer charge. Empty lines retire the breakdown with a reason. Estimate-item references must belong to the same order, but are not necessarily approved.

`record_linked_expense` distributes one cash expense into a cost share per order. `link_workshop_expense` distributes an eligible existing expense without new cash. The connected-money migration, `20261102000100_connected_money.sql:34–104`, requires 1–50 distinct orders, positive two-decimal allocation amounts, and an exact sum covering the whole expense; it rejects double linking. Subsequent `allocate_cost` itemizes one order's cost share, not the whole expense header.

`pay_direct_purchase`, in `20261022002100_review_integrity.sql:57–101`, is a separate canonical command. It creates an expense referencing `direct_purchase_cost_id`; a trigger prevents a duplicate cost. It validates purchase kind, destination, date, precision, and aggregate overpayment. A contextual interface must retain these command boundaries rather than suggest an unsupported atomic save.

## Customer collections have sound distinctions but weak ordering

`case-payments.tsx:19–47` places prose and the charge-issuance form before the overview, documents, advances, receipt, and applications. `linked-receipt.tsx:34–83` distinguishes new money from existing money and charge versus advance destinations. Grouped invoices follow a separate route.

The recommended collection overview must distinguish scoped issued amounts, applied amounts, balance, available advances, and approved-but-unbilled differences. Applying existing money is not a new cash receipt. A shared document needs an explicit broader-scope fallback unless a reliable work-level allocation exists.

## Free-text responsibility is not a cosmetic input change

`20261022000300_workshop_tasks.sql:2–8,28–29,64–93` requires `assignedTo` to be an eligible authenticated-user UUID. `assignee_label` is derived and read-only. Technician visibility, task transitions, and timers depend on that UUID.

Typed search that resolves an existing account is only an interface change; it does not support an arbitrary manually entered name. True free text requires separate metadata and a validated compatible command contract while keeping authenticated assignment independent. Whether account assignment becomes optional or can be substituted is a consequential product decision, not an established requirement.

Potential future review areas are task/domain/task-board/business-adapter code, a new migration, authorization checks, and timer tests. No implementation is authorized by this research.

## Constraints for the proposed design

Use one cost list and contextual detail with “Resumen”, “Desglose”, “Tratamiento”, and “Pagos”, retaining identity and total. Test “Tratamiento del costo” against the clearer question “¿Este costo ya está incluido en el presupuesto?” Preserve actual stored categories, including internal or warranty categories where applicable; the complete enum is not supplied and must not be invented.

A single “Registrar costo” entry can expose distinct paid-expense, direct-purchase, and existing-expense paths. Optional breakdown follows a successful parent save: no atomic parent-plus-breakdown API is evidenced. Partial failure must preserve the parent and retry only the breakdown. Parent classification refresh must not discard dirty allocation edits or their `expectedVersion`.

Financial visibility requires both `financialAccess` and the current `can('expenses.read')` permission. Cached revocation guards must cover all financial records and files. Preserve the existing approved workshop journey: three stages for internal jobs and six circles for customer jobs.

## Evidence limits

This is a supplied source-audit record, not a fresh audit or runtime test. Exact category taxonomy, charge/document wording, organization-specific defaults, receipt attribution, and the intended relationship between a manually named worker and authenticated task assignment remain decisions or verification gaps.

## Key Learnings

1. Cost itemization does not create additional cash movements.
2. Expense distribution spans orders before per-order itemization.
3. Authenticated task assignment currently requires eligible user identity.
4. Existing advance application is not another customer receipt.
5. Parent and breakdown saves have separate failure boundaries.
