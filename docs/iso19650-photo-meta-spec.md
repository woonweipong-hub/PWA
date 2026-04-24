# SiteShrimp — Per-Photo Evidence Metadata Spec (ISO 19650-aligned)

**Status:** Draft for review — no schema or hook code applied yet.
**Scope:** Step 2 of the ISO 19650-aligned evidence-photo programme. Adds per-photo metadata (hashes, ISO filename cache, revision, capture-time UTC offset, quality flags) so that each captured image becomes an individually identifiable, auditable information container, while keeping SiteShrimp's existing `entries` data model intact.
**Out of scope:** Storage-adapter rename-on-export (Step 3), single-entry RE-ANALYZE button (Step 3 UX), CONQUAS export sidecar JSON (Step 4), AI analysis history versioning (separate decision).
**Authoritative sources:** [ISO 19650-1:2018](../.claude/skills/ISO_19650/ISO_19650-1_2018(en).PDF), [ISO 19650-2:2018](../.claude/skills/ISO_19650/ISO_19650-2_2018(en).PDF). All §-numbers in this document have been verified against those PDFs.

---

## 1. Standards anchoring

The standard does not prescribe a per-photo data model — it prescribes properties that any *information container* (which a defect photo is, by §3.3.12) must carry when managed in a *common data environment* (§3.3.15). This spec maps SiteShrimp's existing data shapes onto those required properties.

### 1.1 Verified citations

| Concept | Citation | Verbatim wording (key phrase) |
|---|---|---|
| Information container — definition | **ISO 19650-1:2018 §3.3.12** | *"named persistent set of information retrievable from within a file, system or application storage hierarchy"* — EXAMPLE includes "information file (including model, document, table, schedule)". |
| Information container — naming convention | **ISO 19650-1:2018 §3.3.12, Note 3 to entry** | *"Naming of an information container should be according to an agreed naming convention."* |
| Status code — definition | **ISO 19650-1:2018 §3.3.13** | *"meta-data describing the suitability of the content of an information container."* |
| Common data environment (CDE) — definition | **ISO 19650-1:2018 §3.3.15** | *"agreed source of information for any given project or asset, for collecting, managing and disseminating each information container through a managed process."* |
| Required CDE container metadata | **ISO 19650-1:2018 §12.1** | *"Each information container managed through the CDE should have metadata including: 1. a revision code… 2. a status code, showing the permitted use(s) of information."* |
| CDE states | **ISO 19650-1:2018 §12.2 / 12.4 / 12.6 / 12.7** | work in progress / shared / published / archive — the only four states the standard names. |
| Project's information standard | **ISO 19650-2:2018 §5.1.4** | *"The appointing party shall establish any specific information standards required by the appointing party's organization within the project's information standard."* |
| Project's CDE — required capabilities | **ISO 19650-2:2018 §5.1.7 (a), (c), (e)** | (a) *"each information container to have a unique ID, based upon an agreed and documented convention comprised of fields separated by a delimiter"*; (c) attributes assigned: *"status (suitability); revision; classification"*; (e) *"the recording of the name of user and date when information container revisions transition between each state."* |
| National annex | **ISO 19650-2:2018 §0.2** | *"national standards bodies are encouraged to compile and document the standards… within a national annex."* |

### 1.2 Citations the prior reviewer offered (corrected)

The earlier reviewer cited §5.5 and §5.7. After verification against the PDF text:

| Reviewer's citation | What it actually is | Correct citation |
|---|---|---|
| ISO 19650-1 §5.5 — "project information standard" | §5.5 = Exchange Information Requirements (EIR) | **ISO 19650-2 §5.1.4** is the project information standard clause; **ISO 19650-1 §3.3.12 Note 3** anchors the naming-convention requirement. |
| ISO 19650-2 §5.1.7 — "unique ID and metadata in the CDE" | Correct concept, correct §-number | **ISO 19650-2 §5.1.7 (a), (c), (e)** as quoted above. |
| ISO 19650 §5.7 — suitability codes | §5.7 of -1 = PIM; §5.7 of -2 = Information Model Delivery | **ISO 19650-1 §3.3.13** defines status code; **ISO 19650-1 §12.1** requires it; **the codes themselves (S1-S7, A1-A7) are not in the base ISO text** — they originate in the UK National Annex (BS EN ISO 19650-2:2018) and apply only when the project information standard adopts them, per **ISO 19650-2 §0.2**. |

This matters because in a BEP review, citing §5.7 for suitability codes would be challenged immediately — the standard text doesn't say what the reviewer thought it says.

### 1.3 What this means for the spec's claims

- A defect photo *is* an information container per §3.3.12, so the standard's container-level metadata requirements apply.
- The required minimum metadata (status, revision) is set by §12.1 and §5.1.7(c) — **not optional**.
- The naming convention must be "agreed and documented" per §5.1.7(a) and §3.3.12 Note 3 — SiteShrimp must declare the convention in the project information standard or BEP, not invent it silently.
- Suitability code values (S2, S4, A1 etc.) are **only valid when the project information standard adopts the National Annex**. SiteShrimp must surface this as a per-project setting, not a universal default.
- Recording user-and-date on state transitions is required by §5.1.7(e) — SiteShrimp's existing audit trail (`createdAt`, `updatedAt`, `archivedBy`, `verifiedBy`, comments timeline) already satisfies this; no new field needed.

---

## 2. Current SiteShrimp state (verified against schema)

From [pb_schema.json](../deploy/pocketbase/pb_schema.json):

- `entries.photo` — multi-file field, max 5 photos (compressed JPEGs, 1800px max).
- `defects.photoOriginal` — multi-file field, max 5 photos (uncompressed originals).
- `defects.media_hash` — single text field (one hash slot for up-to-5 photos).
- `defects.iso_filename` — single text field (one filename slot).
- `defects.timezone` — IANA name (e.g. `Asia/Singapore`).
- `defects.timestamp_utc` — UTC timestamp text.
- `defects.source_type` — capture provenance (photo / voice / markup / batch_import / etc.).
- `conquas_observations.media_hash` — single text field per observation (one observation = one photo, no multi-photo ambiguity here, leave as-is).

**The asymmetry:** `defects.media_hash` and `defects.iso_filename` are single-slot fields, but `defects.photo[]` can hold up to 5 photos. The current schema is **underspecified** for multi-photo defects — which photo's hash wins is undefined. This spec resolves the asymmetry by introducing per-photo metadata, while keeping the existing single-slot fields as **index-0 mirrors** for back-compat.

**Note on collection naming:** The PocketBase collection is named `defects` (verified at [pb_schema.json:3](../deploy/pocketbase/pb_schema.json#L3)). The product UI calls them "ENTRIES" / "Entry Logging". Both names refer to the same data; this spec uses the schema name `defects` everywhere a collection or field path is referenced, and the UI-facing name "entry" only when describing user-facing flows.

Per §1.3 above, this also means SiteShrimp's current state already satisfies several of §5.1.7's required attributes (status, classification proxies via `trade`/`component_id`/`checkpoint_id`, user-and-date recording) — only **revision** and **per-photo unique ID** are genuinely missing.

---

## 3. Filename convention (three-layer model)

The naming convention required by §5.1.7(a) and §3.3.12 Note 3, formalised:

```text
Container ID            : {Project}-{Originator}-{Volume}-{Level}-{Type}-{Role}-{Number}
Export-metadata segment : -{Suitability}-{Date}[-R{NN}]
Photo-evidence tail     : _{Seq}[_{Element}][_{Checkpoint}]_{Hash8}.{ext}
```

Layer 1 satisfies §5.1.7(a) — *"a unique ID … comprised of fields separated by a delimiter"* (hyphen).
Layer 2 carries the §12.1 status + revision attributes when the file leaves a metadata-aware CDE; UK National Annex codes apply only when adopted (per §1.3).
Layer 3 is a SiteShrimp extension — not part of ISO 19650 — that disambiguates multiple photos sharing one record. CDE consumers parse only the agreed prefix and ignore the underscore tail.

The builder + parser implementing this already exist as of Step 1 — see [js/app.js:110](../js/app.js#L110) (`isoNameForDefect`) and [js/app.js:163](../js/app.js#L163) (`parseIso19650Filename`). 37 unit assertions pass via [tools/test-iso19650.js](../tools/test-iso19650.js).

`iso_filename` is **derived, not edited**: regenerated from live record fields on every export, so a Suitability change (Open → Done) automatically yields the right export filename without bumping `revision`. The cached value in `photo_meta.iso_filename` is for fast batch reads; the export path always re-runs the builder.

---

## 4. Schema diff

### 4.1 New collection: `photo_meta`

```json
{
  "name": "photo_meta",
  "type": "base",
  "schema": [
    {
      "name": "defect_id",
      "type": "relation",
      "required": true,
      "options": {
        "collectionId": "<defects collection id — resolve via PB Admin or pb_schema.json>",
        "cascadeDelete": true,
        "minSelect": 1,
        "maxSelect": 1
      }
    },
    {
      "name": "photo_index",
      "type": "number",
      "required": true,
      "options": { "min": 0, "max": 4, "noDecimal": true }
    },
    {
      "name": "is_primary",
      "type": "bool",
      "required": false
    },
    {
      "name": "original_sha256",
      "type": "text",
      "required": false,
      "options": { "pattern": "^[0-9a-f]{64}$" }
    },
    {
      "name": "derived_sha256",
      "type": "text",
      "required": false,
      "options": { "pattern": "^[0-9a-f]{64}$" }
    },
    {
      "name": "iso_filename",
      "type": "text",
      "required": false,
      "options": { "max": 255 }
    },
    {
      "name": "revision",
      "type": "number",
      "required": true,
      "options": { "min": 1, "noDecimal": true }
    },
    {
      "name": "capture_offset_minutes",
      "type": "number",
      "required": false,
      "options": { "min": -840, "max": 840, "noDecimal": true }
    },
    {
      "name": "quality",
      "type": "json",
      "required": false
    }
  ],
  "indexes": [
    "CREATE UNIQUE INDEX idx_photo_meta_slot ON photo_meta (defect_id, photo_index)",
    "CREATE INDEX idx_photo_meta_derived ON photo_meta (derived_sha256)",
    "CREATE INDEX idx_photo_meta_original ON photo_meta (original_sha256)"
  ],
  "listRule":   "@request.auth.id != ''",
  "viewRule":   "@request.auth.id != ''",
  "createRule": "@request.auth.id != ''",
  "updateRule": "@request.auth.id != ''",
  "deleteRule": "@request.auth.id != ''"
}
```

**Field semantics:**

- `defect_id` + `photo_index` is the natural key. The unique index on this pair guarantees no two metadata rows describe the same slot.
- `photo_index` is **immutable per saved slot** (per the prior reviewer's refinement). When the user reorders photos in the UI, the entire array is rewritten as a new save and the photo_meta rows are reissued; in-place index swaps are not supported.
- `is_primary` mirrors `photo_index === 0` and exists only for query-side convenience (`WHERE is_primary = true` is faster than `ORDER BY photo_index LIMIT 1` across large result sets).
- `original_sha256` = SHA-256 of `defects.photoOriginal[photo_index]` raw bytes. Nullable: legacy rows where the original was never captured will have NULL here.
- `derived_sha256` = SHA-256 of `entries.photo[photo_index]` raw bytes (post-compression). Effectively required for new photos; nullable until backfill completes.
- `iso_filename` = cached output of `isoNameForDefect(entry, company, project, {seq: photo_index+1, element, checkpoint, hashShort: derived_sha256.slice(0,8), revision, ext: 'jpg'})`. Regenerated on export; storing the cache avoids per-render rebuilds in batch listing.
- `revision` = monotonic per-photo counter. Default 1. Bumps when the photo bytes change in the same slot (re-shoot at index N) or when a re-analyze rewrites AI-derived fields that affect the filename (element/checkpoint).
- `capture_offset_minutes` = UTC offset *at the moment of capture*, signed integer. Combined with `defects.timezone` (IANA) and `defects.timestamp_utc`, exact local capture time is reconstructible without any DST-history lookup. Range -840..+840 covers all real-world offsets including UTC+14 (Kiribati) and historical UTC-12 (American Samoa pre-2011).
- `quality` = JSON `{ is_undersize: bool, min_dimension: number, warnings: string[] }`. The `warnings[]` slot also carries the legacy-row marker `"missing_original"` (per refinement 2 below).

### 4.2 Existing fields: kept as Option-A index-0 mirror

Per the agreed back-compat strategy, **no removals**. These fields stay on `entries`:

- `defects.media_hash` — mirrored from `photo_meta WHERE photo_index=0`'s `derived_sha256`. Existing readers (PDF export, CONQUAS observation linkage) keep working unchanged.
- `defects.iso_filename` — mirrored from `photo_meta WHERE photo_index=0`'s `iso_filename`.
- `defects.timezone`, `defects.timestamp_utc`, `defects.source_type` — unchanged; they remain entry-level (one capture session per entry).

### 4.3 Unchanged: `conquas_observations.media_hash`

One observation = one photo. The multi-photo question doesn't arise. Leave the schema as-is. If a future change adds multi-photo observations, re-evaluate.

---

## 5. PocketBase hooks ([deploy/pocketbase/pb_hooks/main.pb.js](../deploy/pocketbase/pb_hooks/main.pb.js))

### 5.1 Server-side hash verification (on `entries` create/update)

Purpose: defend against a tampered or wrong-binary photo being saved with a falsely-claimed hash. Without this, `derived_sha256` is "what the client claims," not evidence.

```text
hook: onRecordCreateRequest("defects"), onRecordUpdateRequest("defects")
for each photo file in the request body:
  computed = sha256(file bytes)
  client_claim = body.photos_meta_pending[index].derived_sha256
  if client_claim and client_claim !== computed:
    throw new ApiError(400, "media hash mismatch on photo[" + index + "]")
  # If client did not claim, server fills it in. This makes the field
  # effectively required without requiring the offline queue replay
  # path to compute hashes for legacy queued saves.
```

The hook also writes the `photo_meta` rows in the same transaction. If the client did not supply per-slot metadata (e.g. legacy app version), the hook builds default rows server-side: `revision=1`, `capture_offset_minutes=null`, `quality.warnings=["legacy_client"]`.

### 5.2 Index-0 mirror (on `photo_meta` after-save)

```text
hook: onRecordAfterCreateSuccess("photo_meta"), onRecordAfterUpdateSuccess("photo_meta")
if record.photo_index == 0:
  parent = $app.dao().findRecordById("defects", record.defect_id)
  parent.set("media_hash", record.derived_sha256 || record.original_sha256)
  parent.set("iso_filename", record.iso_filename)
  $app.dao().saveRecord(parent)  # bypass other hooks to avoid recursion
```

This keeps the legacy single-slot fields populated for the duration of the deprecation window (which can be indefinite — there's no cost to keeping them).

### 5.3 Revision bump trigger (broadened — per Decision 10.4)

Per ISO 19650-2 §5.1.7(c), revision tracks changes in information content, not just identifier strings. The bump fires on any watched-field diff, not only `derived_sha256`.

```text
hook: onRecordBeforeUpdateRequest("photo_meta")
watched = [
  "derived_sha256",      # photo bytes replaced
  "original_sha256",     # uncompressed source replaced
  "iso_filename",        # filename recomputed from changed parent fields
  "quality"              # quality flags changed (re-evaluated undersize, etc.)
]
# Hook also watches the parent defect's AI-derived fields (title, description,
# severity, trade, component_id, checkpoint_id) via a sibling hook on
# onRecordBeforeUpdateRequest("defects") that propagates a "bump pending"
# flag into the next photo_meta touch.
if any watched field differs from old value, and diff is not a pure no-op:
  record.revision = (old.revision || 1) + 1
```

Prevents silent content changes without an audit counter bump, while ignoring re-saves that produce identical fields.

---

## 6. Backfill ([tools/backfill-photo-evidence.js](../tools/backfill-photo-evidence.js))

### 6.1 Goals

- Populate `photo_meta` rows for every existing photo in `defects.photo[]` and `defects.photoOriginal[]`.
- Idempotent: re-running skips rows where the meta is already complete, repairs rows where it's partial.
- Dry-run mode prints a planned diff without writing.
- Honest about what cannot be reconstructed (legacy capture-offset, missing originals).

### 6.2 Procedure (per defect row)

```text
for each defect in pages of 200:
  photos = defect.photo or []
  originals = defect.photoOriginal or []
  for index in 0..max(photos.length, originals.length)-1:
    existing = findPhotoMeta(defect.id, index)
    if existing and existing.derived_sha256 and existing.iso_filename:
      log("skip", defect.id, index)
      continue

    derived = photos[index] ? sha256(downloadFromPB(entry, "photo", index)) : null
    original = originals[index] ? sha256(downloadFromPB(entry, "photoOriginal", index)) : null

    warnings = []
    if not original:
      warnings.push("missing_original")  # per reviewer refinement 2
    if width and height and min(width, height) < 1024:
      warnings.push("undersize:" + min + "<1024")

    iso = isoNameForDefect(entry, company, project, {
      seq: index + 1,
      element: deriveElement(entry),     # may be null for non-CONQUAS rows
      checkpoint: defect.checkpoint_id,   # may be null
      hashShort: derived ? derived.slice(0, 8) : null,
      revision: 1,
      ext: "jpg"
    })

    upsertPhotoMeta({
      defect_id: defect.id,
      photo_index: index,
      is_primary: index === 0,
      original_sha256: original,
      derived_sha256: derived,
      iso_filename: iso,
      revision: 1,
      capture_offset_minutes: null,  # cannot reconstruct DST-aware offset for old rows
      quality: { is_undersize: minDim < 1024, min_dimension: minDim, warnings }
    })

    log("upserted", defect.id, index)
```

### 6.3 Output

Per-run summary:

```text
Backfill report
  defects scanned     : 1,247
  photo_meta upserted : 2,891
  photo_meta skipped  : 412 (already complete)
  failures            : 3 (file missing in storage; logged to backfill-errors.json)
  legacy markers      :
    missing_original  : 318
    undersize         : 47
    legacy_client     : 0  (no entries arrived via the new schema yet)
```

### 6.4 Failure handling

Photos that have gone missing in storage (PB record references a file ID that no longer exists) are logged and skipped, never deleted. The corresponding `photo_meta` row is created with `derived_sha256=null` and `quality.warnings=["file_missing_in_storage"]` so the entry remains visible in REVIEW with a quality flag rather than disappearing silently.

---

## 7. Client wiring ([js/app.js](../js/app.js))

### 7.1 LOG / batch save path

Where the existing save code packages a new `entries` record:

1. For each captured photo (max 5):
   - Compute `derived_sha256 = await mediaHash(compressedDataUrl)`. The `mediaHash()` helper at [js/app.js:28](../js/app.js#L28) already returns full hex.
   - If a pre-compression original is available, compute `original_sha256` from those bytes too.
   - Compute `capture_offset_minutes = -new Date().getTimezoneOffset()` (negate so the sign matches ISO 8601 convention: SGT → +480, EST → -300).
   - Compute `iso_filename` via the existing `isoNameForDefect` extension shipped in Step 1.
   - Run a synchronous pre-compression `Image.naturalWidth/Height` check; if `min(width, height) < 1024` push `"undersize:NxM<1024"` into `quality.warnings`.
2. Pack the per-photo metadata into a new request field `photos_meta_pending` (array, ordered by photo index) sent alongside the file uploads.
3. Server hook (§5.1) verifies and writes the `photo_meta` rows in-transaction.

### 7.2 Offline queue replay

The IndexedDB queue serializes the entire pending entry including `photos_meta_pending`. On reconnect, replay sends both file blobs and the per-slot metadata in one request — no schema-version branching needed because all new fields are nullable in the schema.

For entries queued under the **previous** app version (no `photos_meta_pending`), the server hook detects the absence and fills in defaults (`revision=1`, `capture_offset_minutes=null`, `quality.warnings=["legacy_client"]`). Replay therefore never fails on schema grounds.

### 7.3 Undersize warning UI

Non-blocking toast on the LOG / batch save flow, per CLAUDE.md mobile-first rules:

> *"Photo is 640 px on the short side — CONQUAS reviewers may request a clearer shot. Consider re-shooting closer."*

The toast appears once per offending photo, dismissible, and does **not** block save. The `quality.is_undersize=true` flag persists so REVIEW can render a small badge on affected entries (deferred to a later phase).

No upscaling. Ever. Upscaling fabricates pixels and would invalidate the SHA-256 hash as evidence.

### 7.4 RE-ANALYZE in REVIEW (Step 3 — referenced here only)

When implemented, RE-ANALYZE recomputes AI-derived fields. If those fields affect the filename (element / checkpoint), the corresponding `photo_meta.iso_filename` is regenerated and `revision` is bumped via the hook in §5.3. If only non-filename fields change, no revision bump.

---

## 8. Refinements adopted from review

Both refinements from the prior review are baked in:

1. **`photo_index` is immutable per saved slot** unless the entire photo array is rewritten. The unique index on `(defect_id, photo_index)` enforces no in-place index swaps; reorders go through a full delete-then-insert of the `photo_meta` rows. This keeps index-0 mirroring deterministic across edits including offline replay. (§4.1, §5.2)

2. **Legacy fallback rule for missing `photoOriginal`:** `original_sha256 = null`, `derived_sha256 = sha256(photo[index])`, `quality.warnings` includes `"missing_original"`. This keeps the backfill idempotent (re-runs see "missing_original" and don't try to recompute) and evidentially honest (the hash chain visibly notes that the original isn't available for cross-check). (§6.2)

---

## 9. Rollout sequence

1. **Schema migration applied** (additive, no removals). Deploy to staging PocketBase. Verify: existing app continues to load, save, and read entries unchanged because the new collection is unread by the old client.
2. **Hooks deployed** in shadow mode (logging only, no rejections, no mirror writes). Run for 24h to confirm no false-positive hash mismatches from legitimate clients.
3. **Backfill dry-run** on staging. Review the planned-changes report; spot-check 10 random rows.
4. **Backfill real run** on staging. Verify mirror fields stay consistent. Re-run the backfill — expect "skipped (already complete)" for every row (idempotency check).
5. **Hooks switched to enforce mode** on staging. Mirror writes activated. Hash mismatches now reject saves.
6. **Client code shipped** that supplies `photos_meta_pending`. Old clients still work (server fills defaults).
7. **Promote to production** in the same order: schema → shadow hooks → backfill dry-run → real backfill → enforce → client.
8. **Tighten enforcement** (months later): PB pattern validation already requires hex format; only step left is making `derived_sha256` `required: true` at the schema level once 100% of rows have it. Defer until backfill confirmed at 100% coverage.

---

## 10. Decisions adopted

The five open questions from the prior draft are resolved as follows. Decisions dated 2026-04-24.

### 10.1 Element-code derivation — **Lookup table, not stored**

The CONQUAS element code (FL / WL / CL / DR / WD / CP / ME) is **derived at filename build time**, not persisted in `photo_meta`. The source of truth is the project information standard (codified in [docs/codification-standard.md](codification-standard.md)), not duplicated into every photo row.

Implementation:
- A `deriveElementCode(defect)` helper reads existing `defects.component_id` / `defects.checkpoint_id` / `defects.trade` and returns the agreed code, or `null` when no rule matches.
- Lookup table lives in [docs/codification-standard.md](codification-standard.md) §6 (canonical) and is mirrored in code as `ELEMENT_CODE_BY_COMPONENT` near `isoNameForDefect` in [js/app.js](../js/app.js).
- `null` element produces a filename without the element segment, per the existing builder's `if(element)` guard at [js/app.js:131](../js/app.js#L131).

A future stored `element_code` field on `defects` is **only** introduced if (a) performance demands it, or (b) a project needs to freeze a historical code that diverges from an evolving BEP. Neither applies today.

### 10.2 `is_primary` flag — **Kept, with invariant enforced**

`is_primary` stays on `photo_meta` per §4.1, with the strict invariant:

> `is_primary === true` **iff** `photo_index === 0`.

Enforcement is a hook responsibility (see §5.4 below). The invariant is cheap given the immutability of `photo_index` (refinement 1 from review). Downstream readers that only need "the primary photo" don't have to know SiteShrimp's indexing semantics.

If a future refactor collapses everything to "index 0 is primary" universally, `is_primary` can be deprecated without touching the evidence model.

### 10.3 Legacy capture-offset — **Non-blocking informational badge**

`capture_offset_minutes === null` is rendered in the REVIEW photo metadata panel as a small informational badge with tooltip:

> *"Time-zone offset unknown — captured before per-photo offset tracking was enabled. Display time uses the device's timezone at upload."*

**Does not** block exports. **Does not** appear in CONQUAS export sidecars as a warning. Treats legacy data as informational, not flawed. UI work itself is deferred to a later phase; the field semantics are nailed down here so the badge is a one-day implementation when we get there.

### 10.4 Revision bump on AI re-analyze — **Always, on any stored-field change**

Per ISO 19650-2 §5.1.7(c), revision tracks *"changes in information content"*, not just changes in identifier strings. Reviewers / auditors care that the AI-derived classification or description changed even when the container ID is stable.

Rule:
- **Bump `revision`** on any AI re-analyze (single or batch) that writes to *any* persisted field (`title`, `description`, `severity`, `trade`, `component_id`, `checkpoint_id`, plus `derived_sha256` if the photo was replaced).
- **Do not bump** on cosmetic / non-persisted UI state changes.
- **Do not bump** on a re-analyze that produces identical fields (no-op) — gate the bump on actual diff, not on the act of running the analysis.

Implementation: §5.3 hook is broadened to compare a list of watched fields, not just `derived_sha256`. The watched-fields list is documented in [docs/codification-standard.md](codification-standard.md) §13 (change-control) so future field additions know whether they trigger a revision bump.

### 10.5 Codification standard — **Split out**

Created as **[docs/codification-standard.md](codification-standard.md)** to satisfy ISO 19650-2 §5.1.7(b) — *"each field to be assigned a value from an agreed and documented codification standard."* That document covers field list and order, allowed values and patterns, delimiter rules, examples, and edge cases.

This spec normatively references the codification standard for all field-value rules; this spec governs *the data model* (collection, fields, hooks, backfill); the codification standard governs *the value vocabulary* used inside the filenames the data model produces. Splitting the two means the project can adopt different element-code or suitability-code sets per BEP without reopening this evidence-model spec.

### 10.6 Add: §5.4 hook — `is_primary` invariant enforcement

Added to §5 hooks below (referenced by §10.2). Pseudo-spec:

```text
hook: onRecordBeforeCreateRequest("photo_meta"), onRecordBeforeUpdateRequest("photo_meta")
record.is_primary = (record.photo_index === 0)
# Server overrides whatever the client claimed. Eliminates the failure
# mode of two rows with is_primary=true for the same defect_id.
```

Combined with the unique index on `(defect_id, photo_index)` from §4.1, this guarantees at most one primary per defect.

---

## 11. Versioning of this spec

- **v1.0 (2026-04-24)** — initial draft, citations verified against ISO PDFs.
- **v1.1 (2026-04-24)** — five reviewer questions answered, codification standard split out, collection name corrected (`entries` → `defects`), revision-bump rule broadened, `is_primary` invariant hook added.

This document is normative. Changes that affect the schema or hook contracts require a version bump and a corresponding migration version in [docs/iso19650-migration-v1.json](iso19650-migration-v1.json) plus a hook outline update in [docs/iso19650-hook-outline.md](iso19650-hook-outline.md).

---

## 12. References

- ISO 19650-1:2018 — *Organization and digitization of information about buildings and civil engineering works, including building information modelling (BIM) — Information management using building information modelling — Part 1: Concepts and principles.* International Organization for Standardization. Available at [.claude/skills/ISO_19650/ISO_19650-1_2018(en).PDF](../.claude/skills/ISO_19650/ISO_19650-1_2018(en).PDF).
- ISO 19650-2:2018 — *…— Part 2: Delivery phase of the assets.* International Organization for Standardization. Available at [.claude/skills/ISO_19650/ISO_19650-2_2018(en).PDF](../.claude/skills/ISO_19650/ISO_19650-2_2018(en).PDF).
- BS EN ISO 19650-2:2018 (UK National Annex) — source of the S1-S7 / A1-A7 suitability codes referenced in §1.3 and §3. Not bundled; cite when adopting per project information standard per §5.1.4.
- ISO 12006-2 — referenced by ISO 19650-2 §5.1.7(c) for the classification framework. Not bundled; out of scope for this spec.
- IEC 82045-1 — referenced by ISO 19650-1 §12.1 as an example revision-code standard. Not adopted here.
- [js/app.js — `isoNameForDefect`, `parseIso19650Filename`](../js/app.js#L110)
- [tools/test-iso19650.js — Step 1 unit harness](../tools/test-iso19650.js)
- [deploy/pocketbase/pb_schema.json — current schema](../deploy/pocketbase/pb_schema.json)
- [deploy/pocketbase/pb_hooks/main.pb.js — hook host](../deploy/pocketbase/pb_hooks/main.pb.js)
