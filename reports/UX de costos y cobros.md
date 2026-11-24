# Reconnect costs and collections without confusion

**The screens need a clearer relationship between objects and actions, not just prettier labels.** Keep the successful phase circles, but rebuild the content beneath them around the operator’s questions: what work is being done, what it cost, whether the supplier has been paid, and what remains to collect from the customer. Present each cost once, with its breakdown, budget relationship, and supplier payments accessible inside the same context. In “Cobros”, show the financial position before offering document issuance or money-entry forms. Replace “Disposición comercial” with an understandable question and explicit consequences, without silently changing stored classifications. Manually entering a responsible person is a separate product decision because the current assignment controls access and timers. These are evidence-informed recommendations for validation, not implemented changes or measured improvements.

## The confusion comes from disconnected records, not the circles

### What the evidence establishes

This report synthesizes two research notes and a verified repository-audit handoff. **Observed repository facts**, recorded in [current-state evidence](../research_notes/UX%20de%20costos%20y%20cobros/estado%20actual.md), establish how the present screens and financial commands are connected. **Published guidance** supports interaction principles. **Design recommendations** below apply those principles to this application; they are not findings from workshop-user testing. The original screenshot pixels were not inspected by this writer. The supplied descriptions identify a $500 motor cost in a classification/payment table and the same cost in a separate breakdown accordion.

The audit explains that experience concretely. `workshop-case-screen.tsx:103–114` renders the cost list, then a separate breakdown component per cost; `case-cost-allocations.tsx:9–46` adds another accordion and repeats its description and amount. In `workshop-costs.tsx:43–87`, the third column combines commercial classification with supplier payment. Above it, several competing entry points ask the operator to understand expense, budget, linking, and purchase distinctions before choosing a task. The problem is not that these distinctions are unnecessary: **the interface exposes the system’s organization before explaining the operator’s job**.

“Cobros” has a related ordering problem. The audited `case-payments.tsx:19–47` puts explanatory prose and issuance ahead of the overview and existing financial records. Its underlying receipt logic already distinguishes new money from existing money. A redesign should expose that distinction sooner rather than replacing the financial model.

Familiar language, visible status, recognition rather than recall, and actionable errors are established usability principles. GOV.UK also explicitly recommends fixing an unclear interface rather than adding explanations to compensate for it. Neither source proves a particular layout will work for this workshop. ([NN/g heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/); [GOV.UK interface writing](https://www.gov.uk/service-manual/design/writing-for-user-interfaces))

### Preserve the journey; choose only a few supporting patterns

Retain the approved three-stage internal-job journey and six-circle customer journey. Add an explicit current-phase heading beneath the circles. A step indicator communicates high-level progression; it does not establish that each cost is paid or that each receivable is settled. USWDS distinguishes indication from navigation and warns against using the pattern for nonlinear work. This guidance supports preserving the circles’ scope, not certifying the existing implementation. ([USWDS step indicator](https://designsystem.digital.gov/components/step-indicator/))

| Pattern | Recommended role here | When not to use it |
|---|---|---|
| Stepper/circles | Existing phase journey with a readable current-phase heading. | Another wizard for every cost, payment, or breakdown. |
| Task list | A short attention list only when operators genuinely return across sessions to independent tasks. | As a mandatory checklist for a small entry form or an invented gate on phase progression. |
| Text status badges | Distinguish “Por revisar”, “Pendiente de pago”, and “Pago registrado” beside the relevant object. | Generic “Pendiente”, color-only meaning, or chips that resemble buttons. |
| Compact summary and master–detail | One cost list; one selected record with identity, total, and contextual actions. | Cramped mobile split panes or a wall of separate cards for every number. |
| Inline form | Frequent “Registrar costo” entry next to its list. | Several simultaneously expanded editors with competing save buttons. |
| Detail panel/drawer | Optional desktop comparison when enough width remains; full-width detail on mobile. | Repeated modal entry, hidden reference information, or nested dialogs. |
| Progressive disclosure | Optional breakdown, supporting documents, or relevant payment inputs. | Hiding total, payment meaning, or a required next action. |
| Review and confirmation | Editable, amount-specific review for consequential submission. | Review page plus confirmation modal plus success modal for routine edits. |
| Empty/error states | Explain what exists, what failed, and how to continue. | A failed request displayed as $0 or a toast as the only record of success. |

The selected composition is deliberately small: **phase heading, compact summary, contextual list/detail, and one active editor**. GOV.UK’s task list is conditional, not a universal simplification tool; its guidance notes that users can mistake tags for buttons. Summary cards can connect an object to its actions, but they are not replacements for every table. Carbon recommends keeping frequent work on the main page and distinguishes modal from non-modal interaction. ([GOV.UK task list](https://design-system.service.gov.uk/components/task-list/); [GOV.UK summary lists/cards](https://design-system.service.gov.uk/components/summary-list/); [Carbon modal guidance](https://carbondesignsystem.com/components/modal/usage/); [Carbon dialogs](https://carbondesignsystem.com/building-blocks/core/patterns/dialogs/))

## One cost needs one identity, with separate financial actions

### Connect the purchase and its breakdown without inventing one transaction

Use “Trabajo y costos” as the phase heading, with separate “Trabajo realizado” and “Costos registrados” sections. Avoid suggesting that every estimate or direct purchase has already been paid. Place one “Registrar costo” entry above the list, then offer plain-language paths matching the actual operations: “Gasto pagado”, “Compra directa”, and “Vincular gasto existente”. A short consequence statement should distinguish creating a money-out record from linking an existing one. This is a proposed entry structure, not permission to combine commands.

The audit establishes three different operations. A linked expense distributes **one whole expense across orders**. Linking an eligible existing expense does not create new cash. A breakdown then divides **one order’s cost share into concepts**. Finally, recording payment against a direct purchase is a separate operation with its own validation and duplicate-cost protection. Therefore “Repartir gasto entre trabajos” and “Desglosar costo de este trabajo” must not be interchangeable labels. If a $1,000 expense was distributed as $500 to this job and $500 elsewhere, this job’s breakdown must reconcile to $500, not $1,000.

Keep the selected cost’s identity, origin, and total visible while exposing “Resumen”, “Desglose”, “Tratamiento”, and “Pagos” as sections within the same record. These are not four required wizard steps. For short records, headings and a single open detail are preferable to tabs that conceal context. The proposed master–detail arrangement applies recognition and contextual-help principles; no source establishes that a drawer is best for this workshop. Intuit provides a first-party precedent for item details inside purchase entry and for split totals reconciling, but its product documentation is not comparative usability evidence. ([NN/g contextual help](https://www.nngroup.com/articles/onboarding-tutorials/); [QuickBooks purchase entry](https://quickbooks.intuit.com/learn-support/en-us/help-article/pay-bills/enter-bills-record-bill-payments-quickbooks-online/L1e9Ce5J7_US_en_US); [QuickBooks split transactions](https://quickbooks.intuit.com/learn-support/en-us/help-article/accounting-bookkeeping/enter-split-transaction-register/L2uiuS0Ls_US_en_US))

Show “Desglosar este importe (opcional)” beside the saved cost, with “Reparte el mismo costo entre conceptos. El total no aumenta.” For the motor example, “Repuesto $420” and “Envío $80” are children of the original $500. Keep “Total del costo: $500 · Desglosado: $500 · Por repartir: $0” visible. A mismatch becomes a specific correction: “El desglose supera el costo por $20. Ajusta los importes para sumar $500.”

The existing command requires exact equality, replaces active allocations, and increments a version. Do not imply partial persisted breakdowns are supported. Empty-line submission retires a breakdown with a reason; it is not a harmless empty draft. Preserve required audit reasons rather than renaming them optional. Budget references belong to the same order but are not necessarily approved, so a reference cannot become an “approved” badge automatically.

### Replace jargon with a question and preserve the real categories

Do not merely rename “Disposición comercial” to “Tratamiento”. Lead with **“¿Este costo ya está incluido en el presupuesto?”** Test “Sí, ya está incluido”, “No, es adicional”, and “Aún no lo sé” as wording for that relationship, with a related budget concept where supported. Beside an additional cost, state “Esto no cambia el precio del cliente. Revisa y acuerda el adicional antes de cobrarlo.”

These answers cannot replace every stored classification. The audit identifies internal/warranty-type concerns but does not supply the complete taxonomy. Show other supported treatment decisions separately, using truthful language and preserving unfamiliar legacy values for review. Do not invent enum values or map every cost into included/additional. The pending-cost form currently defaults to Internal; require an explicit product decision about safe defaults before changing it. A proposed safeguard is to avoid committing an unconfirmed default, but the report does not establish that Internal is always wrong.

Keep “Pago al proveedor” visibly separate: “Costo: $500 · Pagado: $0 · Pendiente de pago: $500”. Use “Registrar pago al proveedor” for recording a payment, not wording that implies a bank transfer. Recording $200 leaves cost and breakdown at $500, paid at $200, and pending supplier payment at $300. It does not change the customer’s agreed price.

### Desktop and mobile share one cost record

The following schematic is a design proposal, not an implemented screen. Amounts are illustrative.

```text
DESKTOP — TRABAJO Y COSTOS
[Existing phase circles — unchanged]
Trabajo y costos                         [Registrar costo]
Trabajo realizado
Motor · Responsable: [entered/displayed name] · [Ver tarea]

Costos registrados          | Motor · Compra directa · $500
Motor       $500            | Resumen
Por revisar                 | Costo $500 · Pagado $0 · Pendiente $500
[Ver detalle] selected      |
                            | Desglose
Other cost rows             | Repuesto                       $420
                            | Envío                           $80
                            | Total $500 · Por repartir $0
                            | [Guardar desglose]
                            |
                            | ¿Este costo ya está incluido
                            | en el presupuesto? [Revisar]
                            | Otros tratamientos: [actual value]
                            |
                            | Pago al proveedor
                            | [Registrar pago al proveedor]

MOBILE — SELECTED COST, ONE COLUMN
[Existing circles + readable current-phase heading]
[Volver a costos]
Motor · Compra directa
$500
Costo $500 · Pagado $0
Pendiente de pago $500
Desglose [visible when editing]
Repuesto                         $420
Envío                             $80
Por repartir                       $0
[Guardar desglose]
¿Este costo ya está incluido
en el presupuesto? [Revisar]
Pago al proveedor
[Registrar pago al proveedor]
```

Save the parent first; then offer its optional breakdown immediately in the same context. **No atomic parent-plus-breakdown API is evidenced.** If the second save fails, say “Costo guardado. No se pudo guardar el desglose. Reintenta el desglose desde este costo.” Keep the parent identifier and retry only the failed operation. A classification refresh must preserve unsaved breakdown values and their original `expectedVersion`; conflict requires reconciliation, not silent overwrite.

## Cobros should explain the balance before asking for money

### Separate cost, agreed price, issued amount, and applied money

Place the overview before issuance and entry forms. “Cobros” should first answer what has been issued, what has been applied, and what remains outstanding. The following copy is proposed for comprehension testing, not a validated vocabulary.

| Spanish label | Exact distinction to preserve |
|---|---|
| “Costo registrado” | Workshop cost; not the price charged to the customer and not necessarily paid out. |
| “Total acordado” | Approved customer-facing price; not automatically an issued receivable. |
| “Importe emitido para cobrar” | Issued collectible records scoped to this work; final wording must identify the actual document type. |
| “Aplicado a este trabajo” | Valid applications against this work’s collectible records, including supported advance applications. |
| “Pendiente de cobro” | Outstanding scoped balance after supported applications and adjustments. |
| “Recibido del cliente” | Actual incoming-money records attributable to this work; omit this total if attribution is unproven. |
| “Anticipo disponible” | Eligible unused money already received, with “De este cliente” or “Para este trabajo” only when true. |
| “Acordado aún sin emitir” | An agreement/issuance difference; not automatically additional outstanding debt. |

Do not use “Recibido/aplicado”. For an illustrative case without adjustments, the agreed price is $1,200 and issued amount $1,000. An earlier $300 advance has $200 applied; a separate $400 payment was received and applied. Received is $700, applied is $600, pending is $400, and unused advance is $100. The $200 agreed-but-unissued difference is not another $200 of issued debt. This arithmetic illustrates distinctions, not a universal balance formula for refunds, credits, or shared documents.

### Make the next action depend on the actual state

When an eligible outstanding amount exists, emphasize “Registrar cobro” and clarify “Registra dinero que ya recibiste del cliente.” Reveal amount, date, supported payment method, required destination, and optional reference according to the actual command. Keep the target document visible and preview the resulting balance. An explicit final action such as “Registrar cobro de $150” is clearer than “Guardar”.

Offer “Usar anticipo disponible” as a distinct existing-money action. Show the original advance, available amount, destination, and application amount. Explain **“Este dinero ya fue recibido. Aplicarlo no registra otro ingreso.”** Do not request a new receipt date or payment method as if cash arrived again. History should distinguish “Cobro recibido”, “Anticipo recibido”, and “Anticipo aplicado”, plus supported reversals. Attaching or generating a receipt must not create another collection.

If a charge must first be issued, show “Falta emitir el importe de este trabajo para aplicar cobros” and a preparation action. At final review, name the real operation, including “Emitir factura” if that is what occurs. Do not conceal issuance behind “cobrar”, auto-issue documents, or imply tax validity. A supported advance-receipt pathway remains available independently; the proposed main action must not block it.

For a grouped invoice, show “Documento compartido con otros trabajos”. If work-level allocation is unavailable, display “Saldo del documento: $900” with “El saldo de este trabajo no está desglosado” and “Ver documento y registrar cobro”. The document route already exists; preserve its broader scope instead of displaying its entire balance as this job’s debt.

```text
DESKTOP — COBROS
[Existing phase circles — unchanged]
Cobros · Trabajo / cliente / document identity
Emitido $1,000 | Aplicado $600 | Pendiente de cobro $400
Anticipo disponible: $100 · [truthful scope]
Total acordado $1,200 · Acordado aún sin emitir $200

[Registrar cobro]              [Usar anticipo disponible]
Active editor                 | Documentos y movimientos
Importe recibido [$150]        | Documento [identity] · Ver
Fecha [editable]              | Cobro recibido $400
Medio de pago [supported]     | Anticipo recibido $300
Destino [required if needed]  | Anticipo aplicado $200
Aplicar a [document identity]  |
Pendiente después: $250       |
[Registrar cobro de $150]      |

MOBILE — COBROS, ONE COLUMN
[Existing circles + readable current-phase heading]
Cobros · [work identity]
Pendiente de cobro                 $400
Del importe emitido de $1,000
Aplicado                          $600
Anticipo disponible               $100
[Registrar cobro]
[Usar anticipo disponible]
Selected editor + editable review
[amount-specific final action]
Documentos y movimientos
[explicit shared-document warning when applicable]
```

Review should remain editable and return directly to the affected field. GOV.UK supports review with prefilled correction paths; NN/g warns against generic, overused confirmations. WCAG’s financial safeguard requires at least one qualifying mechanism—reversibility, checking with correction, or review/confirmation/correction—not a universal second modal. ([GOV.UK check answers](https://design-system.service.gov.uk/patterns/check-answers/); [NN/g confirmations](https://www.nngroup.com/articles/confirmation-dialog/); [W3C financial error prevention](https://www.w3.org/WAI/WCAG22/Understanding/error-prevention-legal-financial-data.html))

Xero documents contextual invoice payments and distinguishes prepayment behavior in statements. These are only supporting precedents: both pages were available to the researchers through search extracts, not readable full-page fetches. **No foundational recommendation here depends on those two extracts.** The local audit establishes the essential existing-money distinction. ([Xero payment extract](https://central.xero.com/0/article/Record-payment-of-a-sales-invoice); [Xero statement extract](https://central.xero.com/0/article/Send-a-customer-statement))

## Manual responsibility needs a product decision before an input change

Treat “escrito a mano” as typed name entry, not a signature canvas. However, the audited task migration requires an eligible authenticated-user UUID; its displayed assignee label is derived. Visibility, task transitions, and timers depend on that identity. A searchable account selector allows typing but **does not satisfy arbitrary name entry**.

The recommendation is to separate a human-readable responsible-person name from the authenticated assignment where true free text is required. A label such as “Responsable del trabajo” and hint “Escribe el nombre de quien realizará el trabajo” can then be tested. Suggestions must not silently overwrite the typed name, create accounts, or grant access. Existing account-based assignment remains independent until an explicit decision establishes whether it stays mandatory, becomes optional, or changes its operational meaning.

That choice affects authorization and timer behavior, not only usability. It needs a compatible validated command contract and appropriate future verification; no schema, command, or implementation is authorized by this report. The decision to carry forward is whether manual naming supplements authenticated assignment or replaces it for some jobs. A free-text-only mockup must not pretend this boundary has already been resolved.

## Deliver understanding first, then validate polish and recovery

### Priorities and minimum useful paths

**First priority is financial truth and object continuity.** Move the collection overview first, distinguish issued/applied/received amounts, make shared-document scope explicit, separate supplier-payment status from classification, and prevent an unconfirmed classification default from being mistaken for a chosen policy. Next, connect each cost to its breakdown and payment detail with one selected identity. Then refine responsive spacing, status emphasis, and suggestions against operator feedback. Do not add charts, a new dashboard, more journey stages, or a new accounting model.

Retain the existing typography, circles, and palette. Use calm surfaces, consistent spacing, aligned monetary values, and restrained textual badges. A divider and clear headings can bind cost and breakdown more effectively than additional nested cards. Optional help can use a details disclosure, but core totals and consequences must stay visible; GOV.UK cautions against hiding information most users need. Visible labels and currency-specific input guidance support usable entry. ([GOV.UK details](https://design-system.service.gov.uk/components/details/); [GOV.UK text input](https://design-system.service.gov.uk/components/text-input/); [NN/g progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/))

The minimum cost path is entry choice → supported parent save → saved detail → optional breakdown → independent supplier-payment recording. The minimum collection path is scoped overview → new-money or existing-money choice → editable effect review → confirmed command → persistent history. These paths preserve command boundaries while removing detached re-entry.

### Failure, permissions, and accessibility are part of the design

| Situation | Required visible behavior |
|---|---|
| No records yet | “Aún no hay costos registrados” with the entry action; no invented financial conclusion. |
| Loading or failed overview | “Cargando…” or an accurate error with retry; never substitute $0. |
| Breakdown mismatch | Keep entered rows and show the difference beside the reconciliation total. |
| Parent saved, breakdown failed | Retain the parent; retry only the breakdown. |
| Payment result confirmed failed | State which prior operation succeeded; retry only payment when safe. |
| Timeout with unknown outcome | “No pudimos confirmar el resultado. Revisa los movimientos antes de volver a registrar.” Do not blindly replay financial commands. |
| Concurrent change | Preserve edits and version context; require review of the latest record before resubmission. |
| Access revoked | Remove protected records/files and prevent cached financial detail from remaining accessible. |

The audited permission constraint requires both `financialAccess` and the current `can('expenses.read')`, including cached-revocation protection for money and files. This is a required boundary, not a newly performed security audit. Disabling a pending submit button helps avoid accidental repetition but is not proof of server-side duplicate protection.

At 320 CSS pixels, use a single-column detail without losing identity or forcing the whole form sideways. Keep visible labels, text errors, logical keyboard order, visible unobscured focus, and non-color status. Aim for comfortable approximately 44px touch areas as a product choice; WCAG AA’s target criterion is 24×24 CSS pixels with exceptions, while 44×44 is the enhanced criterion. Modal surfaces need appropriate focus containment and return; non-modal detail must not trap page access. No accessibility conformance is claimed. ([WCAG 2.2](https://www.w3.org/TR/WCAG22/); [Carbon dialogs](https://carbondesignsystem.com/building-blocks/core/patterns/dialogs/))

### Test understanding, not preference alone

A proposed formative study should use representative entry and collection operators, realistic fictional records, small-screen use, and keyboard-only interaction. A small initial group of five or six can reveal problems but cannot establish statistical benefit. Compare with the current screen only after collecting an actual baseline.

| Proposed acceptance task | Evidence to collect before acceptance |
|---|---|
| Register a $500 motor purchase and split $420/$80. | One parent identity, reconciled breakdown, and correct explanation that itemization creates no extra expense. |
| Record a later $200 supplier payment. | Operator predicts cost $500, paid $200, pending $300; customer price is unchanged. |
| Review an included cost and an internal/warranty-type record. | Existing classifications survive; no unintended default or automatic customer charge. |
| From the illustrative $400 pending balance, receive $150 and apply $100 of existing advance. | Final pending $150; no second advance cash receipt. |
| Open a shared invoice without a work-level allocation. | Operator identifies broader scope rather than attributing the full document balance to this job. |
| Enter an unlisted responsible-person name. | Test the approved assignment policy; do not count account-only search as free-text success. |
| Recover from mismatch, concurrent edit, and uncertain timeout on mobile. | Input survives, focus remains usable, wrong-object and duplicate attempts are recorded. |

Measure unaided completion, first action, wrong turns, backtracks, assistance, time, and the operator’s own explanation of what changed. Set the gate before testing: an observed wrong-money interpretation or wrong-object financial action blocks acceptance and triggers revision. Report actual counts and observed failures, not an invented pass rate or percentage improvement.

### Source strength and remaining gaps

The research notes contain **19 distinct public URLs: 17 directly read and two Xero search-extract-only sources**, plus the supplied repository-audit record. There were 20 public-source entries across the notes because progressive disclosure appeared in both. Owner-published design guidance and normative WCAG requirements carry different weight from product-help examples; none is workshop participant research. Sources were accessed on 2026-11-14, but access date is not publication date. Several guidelines are older or undated living pages.

No implementation, browser test, database operation, accessibility certification, participant finding, or quantified benefit resulted from this assignment. Remaining gaps include the complete classification taxonomy and default policy, exact issuance/document terminology, grouped-document attribution, advance eligibility and adjustments, and the responsibility/assignment decision. Taxes, currencies, refunds, historical edits, and unsupported payment methods must not be inferred from the illustrative arithmetic.

## Conclusion

The decisive design boundary is between **one understandable record** and **one financial command**. Operators should not have to navigate detached cost records to understand a single purchase, but visual unity must not imply atomic saves, new cash, or automatic customer charges. A calmer, connected presentation can preserve the existing accounting safeguards instead of working around them.

The next design should therefore be judged by whether an operator can predict the consequence of an action before submitting it. The unresolved responsible-person policy is the main decision to settle before promising fully manual entry; the other recommendations provide a research-backed direction for a prototype and subsequent validation, not a claim that the problem has already been fixed.
