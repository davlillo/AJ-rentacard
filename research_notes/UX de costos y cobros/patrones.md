# Within-phase UX patterns for a small workshop operational app

Research-only notes. Accessed 2026-11-14. No application inspection, participant research, or implementation performed. The brief supplies the reported problems; these are not independently verified defects. Recommendations below are hypotheses, not established workshop-specific findings. Financial fields, accounting rules, and repository mapping belong to other research tracks.

## 1. Which established patterns clarify the phase without replacing the successful circles?

### Takeaway

Retain the circular phase journey. Add a clear phase heading, a compact summary, and contextual actions inside it—not another wizard for each repeated item. This is a proposed application of the distinction between journey progress and task-level interaction, not a claim that a stepper represents payment status. [USWDS: Step indicator][S7]; [NN/g: Progressive Disclosure][S2]

### Cited Findings

**Source coverage: 10 primary-owner publications, read directly.** Dates below are publication/review/update dates actually displayed, not invented publication dates for undated guidance.

| Source | Date evidence | Contribution and limitation |
|---|---|---|
| [S1: NN/g, 10 Usability Heuristics][S1] | Published 1994-04-24; reviewed 2024-01-30 | Status feedback, familiar language, recognition, error prevention; broad heuristics, not a workshop trial. |
| [S2: NN/g, Progressive Disclosure][S2] | Published 2006-12-03 | Separate core/secondary information; distinguishes disclosure from linear staged disclosure. Established guidance, not “new 2026 research.” |
| [S3: GOV.UK, Task list][S3] | Component introduced December 2023; change log includes August 2024 | Task names, hints, and statuses; explicitly limited to complex tasks that can be completed across sessions/in a chosen order. Page acknowledges research gaps for its newer component. |
| [S4: GOV.UK, Check answers][S4] | No publication date displayed | Review before submission, edit and return directly, action-specific submit text. Transactional-service context differs from frequent workshop entry. |
| [S5: GOV.UK, Details][S5] | Change log includes October 2024 | Hide secondary help, never information most users need; notes discoverability and voice-assist concerns. |
| [S6: GOV.UK, Summary list / Summary cards][S6] | Change log includes March 2026 | Key/value facts and item-scoped actions; cards used in case-working systems; not for tabular data or task lists. |
| [S7: USWDS, Step indicator][S7] | Latest listed guidance change 2025-02-14 | High-level linear progression, explicit headings and separate navigation. Its accessibility result does not certify this app. |
| [S8: Carbon, Modal][S8] | Updated 2026-09-30 | Frequent tasks should be completable on the main page; modal validation/loading and explicit actions. |
| [S9: Carbon, Dialogs][S9] | Updated 2026-08-11 | Modal versus non-modal context, no nested modals, focus return; some general wording about focus is broader than its modal-specific accessibility rules. |
| [S10: W3C, WCAG 2.2][S10] | Retrieved Recommendation dated 2024-12-12 | Normative accessibility requirements, including financial/data safeguards, reflow and target size. Not an aesthetic specification. |

- NN/g says to use users’ familiar language rather than internal jargon; keep actions and required information visible or retrievable rather than requiring memory across screens. Errors should state what happened and how to recover. [S1][S1]
- Progressive disclosure exposes core options first and secondary ones on request. Staged disclosure forces a linear sequence; it is problematic when users must alternate between interdependent steps. The article warns that excessive splitting adds navigation. [S2][S2]
- USWDS says a step indicator complements linear progression, is not navigation itself, and needs an explicit heading below it. It is unsuitable for nonlinear tasks or very short forms. [S7][S7]
- GOV.UK recommends simplifying a service before adding a task list. Its task list is not an answers summary; it reports that users have mistaken status tags for buttons. Its newer full-row link design still has assumptions requiring testing. [S3][S3]
- Summary cards separate multiple objects of the same type, with unique titles and item-level actions. For very little information, headings and summary lists are preferable to cards. Borders help connect information to its actions, including under magnification. [S6][S6]

### Inferences

**Comparative decision table — proposed fit, not a requirement to use every pattern.** Supporting sources identify the relevant principle; layout choices remain recommendations.

| Pattern | Useful here / proposed use | When bad / principal risk | Decision |
|---|---|---|---|
| Circular stepper | Preserve macro journey and current phase; add explicit phase title. [S7][S7] | Does not explain every pending cost, task, or money movement. Another stepper per row creates false linearity. [S2][S2] | Keep existing journey. |
| Task list | Compact “what needs attention” list if work genuinely spans sessions or has independently actionable tasks. [S3][S3] | Adds bureaucracy to a short form; cannot imply arbitrary order if dependencies forbid it. | Conditional, not default. |
| Status badges | Short non-interactive text near the item, e.g. “Pendiente de pago,” distinct from its action. [S3][S3]; [S10 §1.4.1][S10] | Chip looks clickable; color alone; generic “Pendiente” without saying what is pending. | Use sparingly. |
| Summary cards | One visual boundary per cost/receipt object, unique title and related actions. [S6][S6] | A giant KPI-card wall or separate card for every tiny attribute fragments context. | Prefer compact repeated blocks. |
| Master–detail | Selected cost and its receipt/detail remain visibly related on desktop; small screens use a single detail view with a clear return. Recognition/context rationale: [S1][S1]; [S9][S9] | Cramped split panes at 320px; stale selection; hidden identity when switching. No directly studied workshop layout found. | Optional for larger lists. |
| Inline forms | “Registrar costo” opens one bounded editor near the related list; related receipt information stays in that editor. Frequent-task rationale: [S8][S8] | Many expanded editors compete; editing creates confusing layout jumps. | Preferred frequent-entry baseline. |
| Drawers / modals | A non-modal detail surface may support comparison; a modal may isolate a short consequential decision. [S9][S9] | Calling something a drawer does not establish modality. Repeated modal entry, nested dialogs, and consulting obscured background information are poor fits. [S8][S8]; [S9][S9] | Secondary, not default entry. |
| Progressive disclosure | Reveal optional extra detail or payment-related inputs only when requested/relevant. [S2][S2]; [S5][S5] | Hiding core total, payment meaning, required receipt information, or main CTA. | Selective, one obvious level. |
| Review / confirmation | Compact editable review before consequential submission; explicit final action. [S4][S4]; [S10 §3.3.4][S10] | Review page plus confirmation modal plus success modal for every trivial edit. | Risk-proportionate. |
| Empty / error / pending states | State what exists, what failed, and the next useful action; preserve input on failure. [S1][S1]; [S8][S8] | Empty totals masquerade as zero; spinner masquerades as unpaid; toast is the only durable evidence. | Required state vocabulary. |

### Gaps

- No primary source establishes the best component combination for this particular workshop or proves a drawer beats inline editing here.
- The phase sequence and actual operational dependencies were not inspected. Do not copy GOV.UK’s “all tasks completed” submission gate into workshop progression without domain evidence.
- Ten sources cover the requested pattern families; Material was not additionally fetched because USWDS and Carbon already cover progression and action surfaces. This is targeted coverage, not a survey of all design systems.

## 2. What concrete interaction and language should be tested?

### Takeaway

Test a small connected composition: phase circles → explicit heading and plain summary → contextual list/editor → durable result. Keep registering a cost conceptually distinct from paying it, while keeping their relationship visible; the interaction proposal does not define new financial rules. [S1][S1]; [S2][S2]; [S6][S6]

### Cited Findings

- GOV.UK says summary-card actions should identify their effect and object, stay short, and usually be limited to two or three in the header. It recommends warnings/confirmation for serious or difficult-to-undo actions. [S6][S6]
- Carbon advises against vague “Done” or “OK” action labels and says title/button wording should describe the action and its consequences. Frequent tasks belong on the main page rather than repeatedly interrupting with dialogs. [S8][S8]
- GOV.UK review allows changing an answer with existing information populated and returning directly to review, without traversing the whole transaction again. [S4][S4]
- WCAG 3.3.7 requires previously entered/provided information needed again within the same process to be populated or selectable, subject to essential, security, and validity exceptions. [S10 §3.3.7][S10]

### Inferences

**Prioritize these four patterns; do not build the entire matrix.**

1. **Phase action panel, not another workflow.** Keep the circles, then a title such as “Costos del trabajo” and a one-sentence explanation: “Registra lo que se gastó en este trabajo.” Present a compact list and one prominent “Registrar costo.” Other actions are subordinate and attached to their objects. This is a proposed grouping based on recognition and item-scoped actions, not a published component prescription. [S1][S1]; [S6][S6]
2. **Connected cost/receipt editor.** “Registrar costo” reveals one editor. Keep the receipt and its itemization in the same bounded context, or show a clearly named linked receipt beside/within the selected cost. Do not require remembering identifiers and finding the same object in a detached payment screen. Keep itemization visible while entering it if it is core work, not behind “Más opciones.” Detailed field requirements remain for the finance track. [S1][S1]; [S2][S2]
3. **Optional payment branch in context.** After cost details, offer an explicit choice “Pagar ahora” / “Pagar después,” where supported by existing operations. “Pagar ahora” reveals only the relevant payment inputs. A final primary action could be “Registrar costo y pago” versus “Registrar costo”; these labels require verifying whether the app records a payment or actually executes one. Never imply funds were transferred if only a record was saved. No silent payment default, no duplicate cost re-entry. [S1][S1]; [S2][S2]; [S10 §§3.3.4, 3.3.7][S10]
4. **Readable result with direct next action.** After a confirmed save, retain a cost summary with clear state and object-specific “Ver detalle” / “Registrar pago” where applicable. Proposed text: “Costo registrado. Pago pendiente.” Show that only when the cost is actually saved and payment is not recorded. Preserve the selected object when moving between summary and detail. [S1][S1]; [S6][S6]

**Language proposals to validate, not final domain definitions:**

| Reported wording/request | Proposed treatment |
|---|---|
| “Trabajo y costos reales” is unclear | Separate task-oriented headings: “Trabajo realizado” for actual work, “Costos registrados” for entered expenses. Verify that “registered” accurately reflects the data; do not disguise estimates as actuals. |
| “Responsable … escrito a mano” | Offer a normally typed text input labeled “Responsable del trabajo,” hint “Escribe el nombre de quien realizará el trabajo.” Treat “a mano” as manual entry, not a signature canvas, pending confirmation of intended meaning. Do not require account selection unless the domain requires it. |
| “Disposición comercial” is incomprehensible | Do not guess a cosmetic synonym. If it means a decision about charging the customer, a possible heading is “Qué se cobrará al cliente”; otherwise obtain the actual meaning and test ordinary-language alternatives. |
| “Cobros” | Reserve customer-receipt language for money received from customers, and payment language for money paid out, if that matches existing domain terminology. This is a proposed distinction for testing, not an accounting specification. |

These wording recommendations apply NN/g’s familiar-language principle, not evidence that those exact Spanish phrases have been validated. [S1][S1]

**State examples to test:** “Aún no hay costos registrados” + “Registrar costo”; “Guardando costo…” during submission; “No se pudo guardar el costo. Revisa la conexión e inténtalo de nuevo” only for a known connection failure; otherwise use an accurate non-speculative error. On partial success, say exactly which operation succeeded and which did not. Do not show “Pago registrado” before confirmation. These are applications of status visibility and recovery principles. [S1][S1]; [S8][S8]

### Gaps

- Confirm whether “Pagar ahora” executes a payment, records an already completed payment, or creates an intended payment. Copy and confirmation must match that meaning.
- Whether receipts are mandatory, itemized costs share a receipt, or multiple payments exist is unresolved here; do not encode a one-to-one relationship from this visual recommendation.
- Manual responsibility entry is a user constraint from the brief, not evidence against all selection controls. Assignment consequences and duplicate-name handling need domain review.

## 3. What accessibility safeguards and validation should constrain the choice?

### Takeaway

Use WCAG 2.2 as a testable floor, with larger comfortable touch areas as a product choice. Validate understanding, not just whether users can click through: they must distinguish phase progress, cost saved, payment pending, and final financial action. [S10][S10]; [S1][S1]

### Cited Findings

- WCAG 1.4.10 requires reflow without lost information/functionality or two-dimensional scrolling at 320 CSS pixels for vertically scrolling content, except content genuinely requiring a two-dimensional layout. This is not permission for the entire cost form to scroll sideways. [S10 §1.4.10][S10]
- WCAG 2.5.8 AA specifies targets of at least 24×24 CSS pixels with stated exceptions, including spacing. The 44×44 requirement is the enhanced AAA criterion, not the universal AA minimum. [S10 §§2.5.8, 2.5.5][S10]
- Keyboard operation, meaningful focus order, visible focus, and focus not entirely hidden by author-created content are required by 2.1.1, 2.4.3, 2.4.7, and 2.4.11. Status must not rely solely on color (1.4.1); input requires labels/instructions (3.3.2), textual error identification (3.3.1), and correction suggestions when known (3.3.3). [S10][S10]
- WCAG 3.3.4 requires **at least one** safeguard for relevant legal/financial/data submissions: reversible submission, checked data with correction opportunity, **or** review/confirmation/correction before finalization. It does not mandate a second confirmation dialog for every action. [S10 §3.3.4][S10]
- Carbon explicitly differentiates modal focus containment from non-modal access to the page and specifies returning focus to the invoking element after modal closure. Do not blindly apply its broad “trap focus” behavior sentence to a non-modal surface. [S9][S9]

### Inferences

**Responsive and keyboard contract to prototype:**

- Desktop: compact vertical list plus contextual editor, optionally side-by-side only when both remain legible. Mobile 320px: one column; wrap labels, titles, actions and amounts without losing identity or meaning. Keep a textual current-phase heading if all circle labels cannot fit. [S7][S7]; [S10 §1.4.10][S10]
- Prefer approximately 44px touch hit areas for frequent controls as a comfort recommendation; do not shrink controls merely to achieve compactness. Never misreport that as WCAG AA’s universal minimum. [S10 §§2.5.5, 2.5.8][S10]
- Use visible field labels, logical Tab order, explicit save/cancel actions and a keyboard-operable reveal control. A sticky action bar must not hide the focused field; a modal needs focus containment/return, while a non-modal panel must allow page access. [S9][S9]; [S10][S10]
- Keep an editable compact review near consequential submission, naming the affected object and amount where relevant. Prefer one meaningful final confirmation, not repeated generic “¿Está seguro?” screens; routine safe edits should not get the same interruption as irreversible financial actions. [S4][S4]; [S8][S8]; [S10 §3.3.4][S10]

**Small formative usability plan — proposed, not executed.** Recruit 5–6 representative operators across entry and customer-collection responsibilities; include keyboard-only and small-screen use. Use realistic fictional data. Counterbalance old/proposed order if comparing prototypes. Record unaided success, first action, wrong turns, backtracks, time, assistance and the participant’s explanation; do not treat a small sample as statistical proof.

| Task prompt, without naming the control | Measures / failure signals |
|---|---|
| Identify current phase and what remains to do | Time to answer; confusing circle completion with all costs paid. |
| Record a receipt with two items; leave payment for later | Completion, duplicate entry, searching detached screens; explain whether money moved. |
| Record another cost with immediate payment where supported | Correct object and final action; participant can predict the consequence before submitting. |
| Correct the first cost and reopen its receipt | Backtracks, lost edits, wrong receipt association, unnecessary wizard traversal. |
| Enter a responsible person not in an account list | Unaided manual entry; no forced account creation. |
| Recover from a failed save on a 320px viewport using keyboard | Input retained, error understood, retry possible, focus visible, no accidental duplicate action. |

Set decision gates before testing: any wrong-money interpretation or wrong-object action blocks acceptance and triggers revision; log all participants’ success counts rather than inventing a pass rate. For efficiency, compare median time/backtracks with the current-screen baseline only after obtaining it. Ask participants to paraphrase headings and status, not merely whether the design “looks better.” This validation plan operationalizes the cited recognition, status and error-prevention principles; its sample and gates are researcher proposals. [S1][S1]; [S10][S10]

### Gaps

- No measured baseline, conversion/error metric, or participant results exist from this task.
- No browser testing was needed or performed; therefore `webapp-testing` was not loaded under the assignment’s conditional instruction. `ui-ux-pro-max` was loaded; its read-only design-system lookup ran, but its sales/landing-page recommendation was rejected as mismatched to operational work. No generated palette or claimed accessibility grade is used as evidence.
- The exact researcher guide was readable and followed without loading the coordinator or spawning agents. Engram returned ambiguous project history; initial memory reads and writes were skipped as instructed.

### Key Learnings

1. USWDS separates journey indication from action navigation.
2. GOV.UK task lists are conditional, not universal simplification tools.
3. Carbon recommends main-page interaction for repeated tasks.
4. WCAG financial safeguards do not require universal double confirmation.
5. WCAG AA target minimum is distinct from enhanced touch sizing.

[S1]: https://www.nngroup.com/articles/ten-usability-heuristics/ "NN/g — 10 Usability Heuristics for User Interface Design"
[S2]: https://www.nngroup.com/articles/progressive-disclosure/ "NN/g — Progressive Disclosure"
[S3]: https://design-system.service.gov.uk/components/task-list/ "GOV.UK Design System — Task list"
[S4]: https://design-system.service.gov.uk/patterns/check-answers/ "GOV.UK Design System — Check answers"
[S5]: https://design-system.service.gov.uk/components/details/ "GOV.UK Design System — Details"
[S6]: https://design-system.service.gov.uk/components/summary-list/ "GOV.UK Design System — Summary list and Summary cards"
[S7]: https://designsystem.digital.gov/components/step-indicator/ "USWDS — Step indicator"
[S8]: https://carbondesignsystem.com/components/modal/usage/ "Carbon Design System — Modal; redirected to current guidelines"
[S9]: https://carbondesignsystem.com/building-blocks/core/patterns/dialogs/ "Carbon Design System — Dialogs"
[S10]: https://www.w3.org/TR/WCAG22/ "W3C — Web Content Accessibility Guidelines 2.2"
