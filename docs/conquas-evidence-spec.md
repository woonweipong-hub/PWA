# SiteShrimp — CONQUAS Evidence Layer (Step 3)

**Status:** DRAFT — non-implementing. Held pending Step 2 ship + real-world soak before any code changes.
**Version:** v1.0 (2026-04-24).
**Scope:** A CONQUAS-faithful evidence layer built on top of the Step 2 per-photo foundation. Preserves the "first inspection stands" principle; tracks QP declarations and supporting documents for functional tests; provides append-only AI analysis history with field locks.
**Out of scope:** Multi-photo evidence roles (overview/close-up/markup/post-rectification per slot) — deferred to Step 4. Capture profiles (CONQUAS general / private residential / water seepage / …) — deferred to Step 4. New review states beyond the existing 5 — explicitly rejected; evidence semantics live in `analysis_run`, `locked_fields`, and the new FT/QP fields, not in status sprawl.
**Hard dependency:** Step 2 must be shipped and stable (`photo_meta` collection populated, hooks in enforce mode, backfill complete). Do not start Step 3 implementation until that's confirmed.
**Authoritative sources:** ISO 19650-1:2018 / -2:2018 for information-container principles; BCA CONQUAS (Private Residential) 2025 circular for functional tests + QP declarations + major-defect rules.

---

## 1. Why Step 3 exists

Step 2 gives every photo a unique ID, hash, and status-aware filename. That satisfies ISO 19650 container-level requirements, but it does not by itself capture the *evidence semantics* CONQUAS assessors care about:

- Did the AI interpretation change across runs? (First inspection stands — we need the history, not just the latest values.)
- Was a functional test declared by a Qualified Person? When, with what supporting documents?
- Which fields has a human reviewer locked against AI overwrite?
- Does this record have a major-defect flag, a common-area location, or a latent-defect linkage?

These are not container-metadata questions — they are *workflow* questions about the defect row and its evidence chain. Step 3 adds three collections and one field to `defects` to capture them, without rewriting the photo model.

Step 3 also **replaces the Type taxonomy** in the codification standard. The current 9-code set (PH / CQI / CQE / CQF / CQR / DEF / BFR / AFT / MKP) is content-classification. The new 11-code set (IF / EF / WTT / WPT / WFT / POT / HST / MD / RFX / VER / EVD) is workflow-classification, matching how CONQUAS assessors retrieve evidence. This is a breaking change to filenames; a migration v2 handles the remapping (see [iso19650-migration-v2.json](iso19650-migration-v2.json)).

---

## 2. Collections introduced

### 2.1 `analysis_run` — append-only AI interpretation history

One row per AI run on one defect. Never updated after creation (append-only). Renders as a timeline in REVIEW detail.

| Field | Type | Required | Notes |
|---|---|---|---|
| `defect_id` | text | yes | FK to `defects.id`, text-style to match existing convention |
| `primary_photo_index` | number | yes | Which `photo_meta.photo_index` was the AI input |
| `input_photo_indices` | json | no | Array of indices when AI analyses multiple photos |
| `trigger_source` | text | yes | `initial` / `manual_rerun` / `photo_replaced` / `batch_reanalyze` / `checkpoint_wizard` |
| `trigger_reason` | text | no | Free text; populated by the RE-ANALYZE reason picker |
| `model_provider` | text | yes | `gemini` / `ollama` / `openai` / `azure_openai` |
| `model_name` | text | yes | `gemini-2.5-flash` / `llava:latest` / `gpt-4o-mini` — whatever was actually called |
| `prompt_profile_version` | text | yes | e.g. `siteshrimp-2026-04-24-r1` so we can correlate outputs to prompt revisions |
| `started_at` | date | yes | UTC |
| `completed_at` | date | no | UTC; null until the run returns |
| `status` | text | yes | `pending` / `succeeded` / `failed` / `cancelled` |
| `raw_response_json` | json | no | The AI provider's raw response, capped at 64KB |
| `parsed_fields_json` | json | yes | Normalised output: `{title, description, severity, trade, component_id, checkpoint_id, …}` |
| `confidence_json` | json | no | Per-field confidence scores when the provider emits them |
| `field_diffs_json` | json | no | Array of `{field, old_value, new_value, applied_mode}` — the diff vs the previous values at run time |
| `applied_mode` | text | yes | `proposal` / `auto_applied_non_locked` / `manual_accept` / `ignored_locked` |
| `operator_id` | text | yes | User id who triggered the run (may be a system id for batch) |
| `input_manifest_sha256` | text | yes | SHA-256 of `JSON.stringify({photoHashes, promptProfileVersion, modelName})` — reproducibility anchor |

### 2.2 `functional_test_evidence` — QP declarations + supporting documents

One row per functional-test instance. Linked to a `defect_id` whose `evidence_role` (see §3) is one of `WTT / WPT / WFT / POT / HST`. Non-FT defects do not have rows here.

| Field | Type | Required | Notes |
|---|---|---|---|
| `defect_id` | text | yes | FK |
| `test_type` | text | yes | `WTT` (Water Tightness) / `WPT` (Water Ponding) / `WFT` (Water Flow) / `POT` (Pull-Off) / `HST` (Heat Soak) |
| `sample_reference` | text | no | Lab / batch / sample label from the test certificate |
| `sample_location` | text | no | Where the sample was taken / test performed (free text) |
| `test_date` | date | yes | When the test was performed |
| `performed_by` | text | yes | Name / company of the testing party |
| `witnessed_by` | text | no | Name of the QP or independent witness |
| `result` | text | yes | `pass` / `fail` / `pending` / `inconclusive` |
| `result_value_json` | json | no | Provider-specific result fields (pressure, head, temperature, etc.) |
| `supporting_document_ids` | json | no | Array of `defects.costDoc` ids or a parallel `ft_documents` collection (decision pending) |
| `qp_declaration_status` | text | yes | `not_required` / `required_pending` / `declared` |
| `qp_declared_by` | text | no | QP's name and reg number when status is `declared` |
| `qp_declared_at` | date | no | UTC when declared |
| `qp_declaration_notes` | text | no | QP's supporting remarks |
| `created` | date | auto | |
| `updated` | date | auto | |

**Relation to existing schema:** SiteShrimp already mentions QP-declared FT status in the Features tab ("Pull-Off, Heat Soak (EN 14179-2 + 3-yr warranty), WTT self-test, WPT self-test"). Those toggles presumably live on `defects` or `conquas_observations` today; migration v2 surfaces them as rows in the new collection while keeping the old fields as read-only mirrors during the transition.

### 2.3 `defects.locked_fields` — per-attribute overwrite protection

Not a collection — a single JSON array field added to `defects`. Each entry is a field name that an AI re-analyze must not overwrite.

Example value:
```json
["severity", "checkpoint_id", "component_id"]
```

Lockable fields (source of truth in [codification-standard.md §13.2](codification-standard.md)):

- `title`
- `description`
- `severity`
- `trade`
- `component_id`
- `checkpoint_id`
- `location` / `locationLevel` / `locationZone` / `locationSubzone` / `locationGrid`

Non-lockable by design: status, assignee, photo arrays, timestamps, audit fields. These change via their own hooks and shouldn't be subject to AI-originated writes anyway.

---

## 3. Evidence-role codes (replaces codification-standard.md §7)

The Type segment in the ISO container ID is re-vocabularied from content-classification to workflow-classification.

| Code | Meaning | When emitted |
|---|---|---|
| `EVD` | General evidence (default) | Any photo not matching a specific workflow below |
| `IF` | CONQUAS Internal Finishes evidence | Element in {FL, WL, CL, DR, WD, CP, ME}; captured via LOG or CONQUAS wizard |
| `EF` | CONQUAS External Finishes evidence | Element in {RF, EW, EX} |
| `WTT` | Water Tightness Test | Functional test; must have a `functional_test_evidence` row |
| `WPT` | Water Ponding Test | Functional test; must have a `functional_test_evidence` row |
| `WFT` | Water Flow Test | Functional test; must have a `functional_test_evidence` row |
| `POT` | Pull-Off Test | Functional test; must have a `functional_test_evidence` row |
| `HST` | Heat Soak Test | Functional test; must have a `functional_test_evidence` row |
| `MD` | Major Defect | Per CONQUAS Private Residential major-defect list — water seepage, shattered glass, popped tiles, ponding, drainage chokage, functionally deficient fittings, cracked glass |
| `RFX` | Rectification photo | Post-finding rectification work in progress |
| `VER` | Verification photo | Post-rectification verification / before-after close-out |

**Migration from v1 Type codes:**

| Old code | New code | Migration note |
|---|---|---|
| `PH` | `EVD` | Default for unclassified photos |
| `CQI` | `IF` | Internal finishes; element carries more specificity |
| `CQE` | `EF` | External finishes |
| `CQF` | `WTT` / `WPT` / `WFT` / `POT` / `HST` | Disambiguate by the existing `defects.checkpoint_id` or FT type fields; fall back to `EVD` if ambiguous |
| `CQR` | `EF` with element `RF` | Collapse Roof-specific back into `EF` + element |
| `DEF` | `EVD` | Generic defect (no workflow specificity) |
| `BFR` | `EVD` | Before-rectification is captured as a timeline event, not a type; revert to `EVD` |
| `AFT` | `VER` | After-rectification → verification |
| `MKP` | `EVD` | Markup-baked-in is a rendering concern, not a workflow; revert to `EVD` |

Note: `BFR` and `MKP` collapse to `EVD`. Callers who need to distinguish "before-rectification" should rely on `defects.status` + the `analysis_run.trigger_source` audit trail, not a filename prefix.

Migration is lossy for records where Type `CQF` cannot be disambiguated; those retain `EVD` with a `photo_meta.quality.warnings = ["type_migration_ambiguous"]` marker. Backfill script reports the count so assessors can triage manually.

---

## 4. Behaviour

### 4.1 AI analyze / re-analyze writes an `analysis_run` row

Every AI call (initial photo analyze in LOG, batch RE-ANALYZE in REVIEW, CONQUAS wizard analysis, single-entry RE-ANALYZE when added) writes exactly one `analysis_run` row with `status: pending` before the call, and updates it to `succeeded` / `failed` on return.

`defects` fields are written only for unlocked fields, and only when `applied_mode = auto_applied_non_locked` or `manual_accept`. `proposal` mode writes the run row but leaves `defects` untouched — the user sees the diff in REVIEW detail and chooses to accept per-field.

### 4.2 Lock semantics

- Locks are set by the user via REVIEW detail (padlock icon next to each lockable field).
- Locks persist until explicitly unlocked.
- Re-analyze computes the diff, filters out locked fields from the write set, and records the filtered fields in `analysis_run.field_diffs_json` with `applied_mode: ignored_locked`.
- The audit trail explicitly names which fields were proposed but not applied. Reviewers can unlock and re-run later.

### 4.3 `photo_meta.revision` bump integrates with `analysis_run`

Per [codification-standard.md §13.2](codification-standard.md), the revision bump fires on watched-field diff. Step 3 adds the `analysis_run` side effect: when a run's `applied_mode` is non-proposal and any watched field was written, the `photo_meta.revision` bump happens **in the same transaction** as the `analysis_run` insert. If the run is a pure proposal (no fields applied), no revision bump.

### 4.4 Major-defect rules

When `defects.evidence_role = MD` (Major Defect), the LOG save path enforces:

- At least one `photo_meta` row with a context shot (`quality.warnings` not including `undersize`).
- At least one close-up shot (same quality requirement).
- `rectification_status` field on `defects` must be non-empty (`pending` as default).

These are soft validations (non-blocking warning toast) to match the product's existing low-friction save philosophy; promote to hard gate only if field usage shows users routinely skip them.

### 4.5 Functional test rules

When `defects.evidence_role ∈ {WTT, WPT, WFT, POT, HST}`:

- A `functional_test_evidence` row is required before status can move from `In Progress` to `Done`.
- `qp_declaration_status = declared` is required before status can move to `Verified` for tests that require QP declaration (WTT, WPT, WFT per CONQUAS 2025 circular; POT and HST via EN 14179-2 + 3-yr warranty model — the specific rule lives in the per-project information standard, not here).

### 4.6 Status lifecycle stays at 5

Per the rejected-scope note at the top: SiteShrimp's 5 statuses (Open / In Progress / Done / Verified / Closed) are retained. Step 3 does not introduce `ai_prefilled`, `review_pending`, `rectification_pending`, or `verification_pending`. The evidence semantics live in:

- `analysis_run` history (was the row AI-prefilled? when? how many runs?)
- `defects.locked_fields` (has a human reviewed and locked anything?)
- `defects.evidence_role` (is this MD / RFX / VER / FT?)
- `functional_test_evidence.qp_declaration_status` (is the QP declaration pending or complete?)

REVIEW list filters layer these cleanly on top of the 5-status axis: e.g. "In Progress, MD, QP declaration pending" is a concrete, filterable query.

---

## 5. `defects` field additions

Minimal — most evidence state lives in the new collections.

| Field | Type | Required | Notes |
|---|---|---|---|
| `evidence_role` | text | no | One of the 11 codes in §3; default `EVD`; nullable for legacy rows |
| `locked_fields` | json | no | Array per §2.3; default empty |
| `major_defect_flag` | bool | no | Derived from `evidence_role == MD`; cached for filter speed |
| `common_area_flag` | bool | no | True when `defects.locationZone` is a CONQUAS common-area code (lobby / lift lobby / corridor / stairs / car park) |
| `latent_defect_flag` | bool | no | Set by operators; distinguishes DLP-era findings |
| `rectification_status` | text | no | `pending` / `in_progress` / `completed` / `not_required`; default `pending` for MD, else null |
| `current_analysis_run_id` | text | no | FK to the latest `analysis_run` where `applied_mode != proposal` |
| `analysis_version_no` | number | no | Denormalised count of applied `analysis_run` rows |

**Why some of these are denormalised (`major_defect_flag`, `analysis_version_no`):** PB's filter engine doesn't join across collections efficiently at REVIEW-list scale (hundreds of rows, phone client). The denormalised mirrors are kept correct by hooks.

---

## 6. Hooks added (outline only — see hook-outline v1.1)

1. **`onRecordBeforeCreateRequest("analysis_run")`** — compute `input_manifest_sha256`, validate `model_provider` + `prompt_profile_version` are in known-good lists.
2. **`onRecordAfterCreateSuccess("analysis_run")`** — if `applied_mode != proposal` and any watched field in `parsed_fields_json` differs from the current `defects` row (filtered by `locked_fields`), write the unlocked fields, bump `photo_meta.revision`, update `defects.current_analysis_run_id` + `analysis_version_no`.
3. **`onRecordBeforeUpdateRequest("defects")`** — reject writes to a field that's in `locked_fields` *unless* the requesting user is the one who set the lock (revoking a lock is a two-step: unlock then write).
4. **`onRecordBeforeCreateRequest("functional_test_evidence")`** — validate `defect_id` points at a defect whose `evidence_role` is in the FT set; reject otherwise.
5. **`onRecordBeforeUpdateRequest("defects")`** — when `status` transitions to `Done` and `evidence_role` is an FT code, require `functional_test_evidence` row exists.

Full outline in [iso19650-hook-outline-v1.1.md](iso19650-hook-outline-v1.1.md).

---

## 7. Client wiring (outline only)

**REVIEW detail — Evidence panel (new):**

- Timeline of `analysis_run` rows, latest first, with model name + timestamp + applied_mode.
- Per-run expander shows `field_diffs_json` as old → new table.
- Field-lock toggles next to `title`, `description`, `severity`, `trade`, `component_id`, `checkpoint_id`.
- FT subsection (only when `evidence_role` is FT): editable `functional_test_evidence` fields + QP declaration state machine.

**REVIEW detail — RE-ANALYZE button (new):**

- Single-tap invokes the AI on the current primary photo.
- Modal before dispatch: trigger_reason picker (better photo / changed site condition / wrong classification / after rectification / other), `applied_mode` toggle (proposal / auto-apply non-locked).
- On return, toast shows how many fields were written vs how many were ignored due to locks.

**LOG save path:**

- No change to UX beyond Step 2's zero-tap flow. Internally, the first AI analysis writes an `analysis_run` row.

---

## 8. Rollout (all contingent on Step 2 ship + soak)

1. **Soak gate.** Step 2 must be in production, `photo_meta` backfilled at 100%, hooks in enforce mode, for at least 7 calendar days with no hash-mismatch reports. Document the soak end date before starting Step 3.
2. **Schema migration v2** applied to staging — adds `analysis_run`, `functional_test_evidence`, new `defects` fields.
3. **Type migration** (v1 → v2 codes) dry-run → real run on staging. Ambiguous `CQF` rows reported for manual triage.
4. **Hooks deployed in shadow mode**; soak 24h.
5. **Client evidence panel shipped** to staging; user-test with a CONQUAS-focused subset (ideally a single active project).
6. **Hooks switched to enforce**; major-defect + FT rules become soft validations.
7. **Promote to production** in same order.
8. **Measure** for 1 sprint: how often do users lock fields? How often does a re-analyze ignore locks? How often does QP declaration get stuck at `required_pending`? Tune rules based on data.

---

## 9. Open questions for the Step 3 review cycle

Do NOT answer these in this draft — they need data from the Step 2 soak + user feedback first.

1. Should FT `supporting_document_ids` point at `defects.costDoc` (existing file field) or a new `ft_documents` collection? File-field reuse is simpler; a dedicated collection is more auditable.
2. `latent_defect_flag` — who sets it, when, under what rule? CONQUAS talks about "valid latent defects" that are moderation-relevant; the trigger is almost certainly outside-the-app (DLP notification), so the flag is set by import or by an admin action, not by a normal user save.
3. `common_area_flag` derivation — is the CONQUAS common-area code list something we maintain in-app, or does it come from the project information standard per-project?
4. `rectification_status` as `defects` field vs a separate `rectification` collection with its own timeline — one row is probably enough for now, but a collection is the right shape if we later track multiple rectification attempts per defect.
5. Should `evidence_role` on `defects` be nullable for legacy non-CONQUAS work categories (Interior Works, FM, Infrastructure, Others)? Probably yes — those categories don't need a role code. But the filename builder needs a null-safe path.

---

## 10. References

- [iso19650-photo-meta-spec.md](iso19650-photo-meta-spec.md) — Step 2 data-model spec (hard dependency).
- [codification-standard.md](codification-standard.md) — field vocabulary; this document supersedes §7 (Type codes).
- [iso19650-migration-v2.json](iso19650-migration-v2.json) — applyable schema diff for Step 3.
- [iso19650-hook-outline-v1.1.md](iso19650-hook-outline-v1.1.md) — hook pseudo-code for the Step 3 collections.
- ISO 19650-1:2018 §3.3.12, §12.1 — container definition + CDE metadata.
- ISO 19650-2:2018 §5.1.7(a)(c)(e) — unique ID + required attributes + user/date audit.
- BCA CONQUAS (Private Residential) 2025 circular — authority for IF/EF/FT weightings, WTT/WPT/WFT rules, QP-declared status, major-defect list.
- EN 14179-2 — Heat Soak Test standard (cited by CONQUAS for glass).

---

## 11. Non-implementation notice

This document is a draft specification. **No code, schema, hooks, or client work should be applied from this spec until:**

1. Step 2 has shipped (committed, deployed, backfilled).
2. Step 2 has soaked in production for ≥7 days without hash-mismatch incidents.
3. A Step 3 review cycle has answered the five open questions in §9.
4. An explicit go-ahead is given for a named subset of Step 3 work (e.g. "approve analysis_run collection; hold FT/QP pending data").

Implementation that skips this gate risks destabilising Step 2 before it has proven itself in the field.
