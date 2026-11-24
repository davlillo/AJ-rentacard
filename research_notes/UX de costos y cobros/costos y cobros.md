# Workshop financial workflow UX and Spanish microcopy

Research date/access date for every source: **2026-11-14**. English technical notes; proposed UI copy in neutral Spanish. Recommendations below are hypotheses, not tested outcomes or implementation instructions. Scope is the supplied descriptions of two screenshots, not an independent inspection of the application. No private source, screenshots, or customer data were sent externally. Financial distinctions supplied by the coordinator are constraints, not newly verified findings.

## 1. What evidence supports clearer financial tasks?

### Takeaway

Organize around the operator’s task and keep frequently needed decisions together. Use disclosure for genuinely optional detail, not for the relationship between a purchase, its components, and its payment.

### Cited Findings

Ten primary/first-party sources; product documentation demonstrates available patterns, **not comparative usability research**:

1. **GOV.UK, Writing for user interfaces**: minimize cognitive load with users’ language; fix confusing interfaces rather than explaining them; short, direct copy, one idea per sentence. Published 2017, updated 2018, not a new 2026 study. [Source](https://www.gov.uk/service-manual/design/writing-for-user-interfaces)
2. **NN/g, Progressive Disclosure**: defer advanced/infrequent options, keep frequent options initially visible, label the route to more detail clearly. Interdependent decisions can suffer when split across steps; excessive disclosure levels cause navigation difficulties. Published December 2006. [Source](https://www.nngroup.com/articles/progressive-disclosure/)
3. **NN/g, Onboarding Tutorials vs. Contextual Help**: guidance beside the current step reduces memorization; help should be dismissible and retrievable. Published February 2023; examples include screenshots, not this workshop’s users. [Source](https://www.nngroup.com/articles/onboarding-tutorials/)
4. **NN/g, Confirmation Dialogs Can Prevent User Errors — If Not Overused**: confirm serious consequences specifically; avoid routine confirmation fatigue and generic Yes/No wording. Published 2018; page reports review August 2026. [Source](https://www.nngroup.com/articles/confirmation-dialog/)
5. **Intuit, Enter bills in QuickBooks Online**: supplier, dates, amount, optional item details and optional billable-customer association share a purchase form. Paid expenses and unpaid bills are explicitly different transaction types. Page displays update 8/5/2026; retain date as displayed rather than infer date convention. [Source](https://quickbooks.intuit.com/learn-support/en-us/help-article/pay-bills/enter-bills-record-bill-payments-quickbooks-online/L1e9Ce5J7_US_en_US)
6. **Intuit, Enter a split transaction**: use the original transaction form for multiple accounts when possible; split amounts must add up to the transaction total. This supports reconciliation, not importing QuickBooks accounting categories into this application. Page displays update 8/5/2026. [Source](https://quickbooks.intuit.com/learn-support/en-us/help-article/accounting-bookkeeping/enter-split-transaction-register/L2uiuS0Ls_US_en_US)
7. **Xero, Record a payment on a customer invoice**: payment entry within invoice context includes editable amount/date, optional reference; applied payment appears under the invoice total. Search-index extract verified these steps; direct fetch returned no readable body. Undated in available extract. **Lower verification confidence; no screenshot inspected.** [Source](https://central.xero.com/0/article/Record-payment-of-a-sales-invoice)
8. **Xero, View or send a customer statement**: its activity statement includes prepayments; outstanding statement excludes them; prepayment affects receivables only when applied. This is Xero behavior, not a universal rule for our backend. Same search-only/direct-fetch limitation; undated extract. [Source](https://central.xero.com/0/article/Send-a-customer-statement)
9. **W3C, Understanding WCAG 2.2 SC 3.3.4**: qualifying financial/legal/data submissions require at least one of reversibility, checking with correction, or review/confirmation/correction. It does **not** mandate a modal for every save. Understanding document is informative; linked success criterion is normative. Page updated September 2025. [Source](https://www.w3.org/WAI/WCAG22/Understanding/error-prevention-legal-financial-data.html)
10. **GOV.UK Design System, Text input**: visible labels above fields, no placeholder-only hints, short relevant guidance, decimal keyboard where appropriate, explicit currency in label, field-specific errors. Living page with changes through June 2026; no single publication date established. [Source](https://design-system.service.gov.uk/components/text-input/)

### Inferences

**Recommendation, not sourced fact about this application:** preserve the existing stage circles and their navigation. Improve the content inside each stage rather than adding stages for every financial command. Stage headings should answer “what do I do here?”: “Trabajo y costos”, “Cobros”; supporting sentences: “Registra lo que costó realizar el trabajo” and “Consulta lo pendiente y registra los pagos del cliente”.

Use compact master–detail: a readable cost list plus **one selected purchase detail**, containing purchase facts, components, budget relationship, and payment summary. Desktop can place list/detail alongside; mobile opens a full-width detail with “Volver a costos”. This sacrifices simultaneous expansion of every record but avoids endless accordion forms and repeated toolbars. Keep amount/status visible in list rows. Optional detail remains discoverable, not buried in icon tooltips. Evidence basis: [2](https://www.nngroup.com/articles/progressive-disclosure/), [3](https://www.nngroup.com/articles/onboarding-tutorials/).

Visual direction: retain project typography, circles, and palette; calm surfaces, clear section spacing, aligned/tabular monetary values, one primary action per active form, restrained status chips with words. Do not replace the project with a generic finance dashboard.

### Gaps

No workshop-user observations, task-frequency analytics, comparative layout tests, or original screenshot pixels were available. Public product patterns do not prove that their accounting vocabulary suits a non-accountant. The required UI skill’s local design-system generator ran without persistence; it proposed an irrelevant operations landing/dark-only style. Reject that output as evidence; retain useful checklist principles only. Security skill loaded as guardrail; no code security audit was performed.

## 2. How should Cobros distinguish agreement, debt, cash and advances?

### Takeaway

Make **“Registrar cobro”** the ordinary action when an eligible amount-to-collect record exists. Do not make the operator infer that a quotation, payment receipt, advance, or recorded receivable is interchangeable.

### Cited Findings

Contextual invoice payment entry has a first-party precedent in [Xero payment help](https://central.xero.com/0/article/Record-payment-of-a-sales-invoice), subject to the retrieval limitation above. Xero also exposes the difference between prepayment and applied balance in its [statement documentation](https://central.xero.com/0/article/Send-a-customer-statement). Neither proves the local entity mapping. Specific review and correction rather than generic confirmation follows [W3C](https://www.w3.org/WAI/WCAG22/Understanding/error-prevention-legal-financial-data.html) and [NN/g](https://www.nngroup.com/articles/confirmation-dialog/).

### Inferences

**Recommended IA and exact copy**

Top summary, all scoped explicitly to this work:

| Label | Meaning / guardrail |
|---|---|
| “Total acordado” | Approved customer-facing price; not workshop cost or automatically a receivable. |
| “Importe registrado para cobrar” | Eligible recorded collectible amount, not quotation value. Show “Sin registrar” rather than misleading debt $0 when absent. |
| “Recibido del cliente” | Only actual incoming-money records attributable to this work. Omit if attribution cannot be proven; never substitute account-wide receipts. |
| “Aplicado a este trabajo” | Amount actually assigned to its collectible records; expose payments and advances separately. |
| “Pendiente” | Outstanding eligible balance after valid applications and domain-supported adjustments. Subtitle “Del importe registrado para cobrar”. |
| “Anticipo disponible” | Eligible unused advance with explicit scope: “De este cliente”, or “Para este trabajo” only when true. Not already applied, not new cash. |

Never use the combined label “Recibido/aplicado”: the slash hides two different measures. If space is constrained, prioritize pending/applied and put proven receipts in the history, not an ambiguous merged tile.

Example, **illustrative only, no credits/refunds**: agreed $1,200; recorded to collect $1,000; earlier advance received $300, of which $200 applied; direct payment received/applied $400. Then received $700 (300 + 400), applied $600 (200 + 400), pending $400 (1,000 − 600), advance available $100 (300 − 200). The $200 agreement/recording difference is **not automatically a new debt**.

**Flow, in priority order**

1. Show context: work/client/document identifier and outstanding amount. CTA **“Registrar cobro”**. Clarify “Registra dinero que ya recibiste del cliente” if this command records rather than initiates payment.
2. Form: “Importe recibido”, “Fecha del cobro”, “Medio de pago”, “Referencia (opcional)”; destination cash/bank account only if canonical command requires it. Use only supported payment methods. Editable date visibly defaults to today; amount must not imply the whole balance was paid.
3. Show application target and effect before submit: “Aplicar a [documento/trabajo identificado]”; “Pendiente después de este cobro: $250”. Never silently allocate to unrelated debt.
4. Review is inline for ordinary recording; explicit final button **“Registrar cobro de $150”**. Success: “Cobro registrado: $150. Pendiente: $250”. Persistent history entry, not toast alone.
5. Distinct secondary action **“Usar anticipo disponible”**. Form identifies original advance/date, available amount, target, and amount to apply. Explanation: **“Este dinero ya fue recibido. Aplicarlo no registra otro ingreso.”** Button “Aplicar $100 del anticipo”. Do not ask for another payment method or receipt date as though new cash arrived.

If billing/receivable registration is necessary first: **“Falta registrar el importe de este trabajo para poder aplicar cobros.”** Action **“Preparar importe a cobrar”** opens review of customer, lines, approved price, existing documents and resulting balance. Final button must name the actual command: e.g. **“Registrar importe de $1,000”** only if that is truthful. State **“Revisa el documento antes de confirmarlo”**. Never auto-issue a document, imply tax validity, or call this “cobrar” if no money is recorded. If the actual command issues an invoice, explicitly say **“Emitir factura”** at confirmation; simple entry copy must not conceal issuance. Supported advance receipt before billing stays a separate pathway, not blocked by this recommendation.

Grouped-document fallback: display “Documento compartido con otros trabajos”. Use a proven per-work allocation if available; otherwise show “Saldo del documento: $900” and **“El saldo de este trabajo no está desglosado”**. Link “Ver documento y registrar cobro” with visible broader scope. Never present the entire invoice balance/payment as this work’s own.

History separates “Cobro recibido”, “Anticipo recibido”, “Anticipo aplicado”, and supported reversals. A receipt evidences a payment; its attachment or generation must not itself create a second collection.

### Gaps

Code worker must verify invoice grouping, allocation identity, overpayment rules, advance eligibility, adjustments/refunds, permissions, and whether “registrar” only records or actually issues/transfers. No universal pending formula covers those uninspected states. Avoid claiming complete settlement from partial records.

## 3. How should purchase, breakdown, classification and payment stay connected?

### Takeaway

One purchase context can unify the operator’s understanding **without combining distinct financial commands**. Capture core cost facts first; expose itemization inline; keep payment status and budget treatment separate.

### Cited Findings

Intuit places optional itemization on the [purchase form](https://quickbooks.intuit.com/learn-support/en-us/help-article/pay-bills/enter-bills-record-bill-payments-quickbooks-online/L1e9Ce5J7_US_en_US), while [split documentation](https://quickbooks.intuit.com/learn-support/en-us/help-article/accounting-bookkeeping/enter-split-transaction-register/L2uiuS0Ls_US_en_US) requires totals to reconcile. Interdependent choices belong together, whereas rare options can be disclosed, according to [NN/g](https://www.nngroup.com/articles/progressive-disclosure/). Visible labels and field-specific messages follow [GOV.UK inputs](https://design-system.service.gov.uk/components/text-input/).

### Inferences

**Proposed cost registration/detail**

- Heading **“Registrar costo del trabajo”**. Core: **“Concepto”**, **“Importe total”** with explicit currency, **“Fecha de compra o servicio”**, **“Proveedor”**, and “Comprobante o referencia (opcional)” when supported. Preserve origin as metadata: “Compra directa”, vendor, date. Do not request facts already known.
- Separate **“Costo previsto”** from **“Costo real registrado”**. Recommendation: show both when linked, never sum them. An unpurchased estimate is not an unpaid real purchase. Do not add a mode that creates unsupported planned records.
- Visible classification group replaces “Disposición comercial” with **“¿Este costo ya está incluido en el presupuesto?”** Choices: **“Sí, ya está incluido”**, **“No, es adicional”**, **“Aún no lo sé”**. Included reveals **“Concepto del presupuesto”**; additional shows **“Esto no cambia el precio del cliente. Revisa y acuerda el adicional antes de cobrarlo.”** Unresolved state **“Por revisar: incluido o adicional”** plus action **“Revisar relación con el presupuesto”**, replacing vague “Clasificar costo”.
- **Do not collapse internal/warranty/historical categories into those three answers.** Preserve a separate, correctly mapped dimension **“Tratamiento del costo”** with e.g. “Lo asume el taller”, “Garantía”, “Registro histórico” only if those states exist. Legacy unmapped state stays visible as “Clasificación anterior: [valor]”; flag for review rather than silently migrating it. Exact taxonomy/mapping belongs to code/domain worker.

**Itemization within the same purchase**

Disclosure **“Desglosar este importe (opcional)”** beneath total, followed by **“Reparte el mismo costo entre conceptos. El total de la compra no aumenta.”**

Child-row fields: **“Concepto”**, **“Importe”**, **“Concepto del presupuesto relacionado (opcional)”**; unresolved option **“Sin relacionar todavía”**. Add button **“Agregar concepto al desglose”**, not “Agregar concepto al mismo comprobante”, which can sound like another purchase. “Motivo del desglose” becomes **“Nota del desglose (opcional)”** unless an existing audit rule actually requires a reason.

Example motor purchase total $500 → “Repuesto” $420 + “Envío” $80. Persistent reconciliation: **“Total de compra: $500 · Desglosado: $500 · Por repartir: $0”**. If $420 + $100: **“El desglose supera la compra por $20. Ajusta los importes para sumar $500.”** Require reconciliation on final save; if partial drafts are supported, label them explicitly and preserve remaining allocation without inventing cash.

Primary existing-record action **“Guardar desglose”**, supporting text **“La compra sigue siendo de $500. No se registra otro pago.”** New registration saves one parent purchase and child allocations under supported commands, not parent plus additive expenses. Removing a child redistributes/unassigns breakdown; it does not erase the purchase or refund money.

**Payment panel remains distinct, adjacent**

**“Pago al proveedor”** → **“Costo: $500 · Pagado: $0 · Pendiente de pago: $500”**. If command only records a prior payment, use **“Registrar pago al proveedor”**, not “Pagar compra directa”. Reserve “Pagar” for real payment initiation.

Optional section **“Registrar un pago de esta compra”** exposes amount, payment date, method/account, optional reference. Partial $200 → paid $200, pending $300; cost remains $500, child total remains $500, outgoing cash recorded once is $200. The client’s agreed price remains unchanged. Existing expense allocation references the original expense and must not create another cost or cash-out.

**Responsible person:** “Responsable” is free-text with partial-match suggestions, not a mandatory exact match. Hint **“Escribe un nombre o selecciona una sugerencia”**. Preserve typed accents/name, allow “Sin coincidencias. Puedes usar este nombre” where supported. Selecting a suggestion is explicit; free text must not create a user account or confer authorization. Schema/support is another worker’s scope.

**Command tradeoff and failures:** recommend one contextual editor with explicit **“Guardar costo”**, then **“Registrar pago”** inside its saved detail until transactional backend behavior is verified. Two confirmations cost a step but isolate retries and reflect independent commands. A future single “Guardar costo y registrar pago” is acceptable only with evidenced orchestration, identifiers, duplicate protection and recoverable partial states—not a promise of atomicity.

Known partial failure: **“Costo guardado. No se registró el pago. Reintenta el pago desde esta compra.”** Unknown timeout: **“No pudimos confirmar el resultado. Revisa los movimientos antes de volver a registrar.”** Never automatically repeat the full purchase/payment sequence. Disable repeated submission while pending, but do not mistake this UI guard for server duplicate protection. Authorization, eligible balances and totals require server enforcement; no sensitive references in public logs.

**Accessibility and evaluation recommendations:** persistent labels, textual status, keyboard operation and visible focus; one-column mobile flow, no hover-only instructions, comfortable ~44px action targets as a design recommendation, not a claimed WCAG minimum. Preserve entries on errors; open the relevant collapsed section, show linked summary plus field message, move focus predictably. Currency/decimal parsing must match locale. Final review lists supplier/client, amount, date, target and actual effect; no generic “¿Estás seguro?”.

Prioritize P0 semantic labels/balance truth/no duplication; P1 contextual purchase + breakdown/payment; P2 polish, suggestions and observed frequency tuning. **Five proposed usability tasks, not executed:**

1. Register a $500 unpaid motor purchase, split $420/$80; explain cost versus payment.
2. Record a $200 supplier payment later; verify cost $500, paid $200, pending $300.
3. Classify an included cost and a warranty/internal cost without increasing client price.
4. Use the Cobros example to receive $150, then apply $100 existing advance; pending $150, no second advance cash receipt.
5. On mobile/keyboard, recover from a $20 split mismatch and a payment timeout; recognize a shared invoice cannot establish this work’s full balance.

Observe independent completion, wrong commands, duplicate attempts, comprehension and recovery—not just speed.

### Gaps

No implementation, backend atomicity, schema change or tested accessibility conformance is asserted. Taxes, discounts, rounding, currencies, historical imports, adjustments and immutable/audited records need domain review before enforcing breakdown equality or editing past amounts. No strong conflict between sources: the real tension is disclosure versus visibility, and confirmation versus fatigue; use contextual decisions and proportionate review, then test.

#### Key Learnings

1. QuickBooks documents itemization inside purchase entry.
2. QuickBooks requires split amounts to reconcile.
3. WCAG financial safeguards need not be modals.
4. Xero distinguishes prepayments from applied balances.
5. Public product patterns are not workshop usability evidence.
