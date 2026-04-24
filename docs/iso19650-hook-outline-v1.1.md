# PocketBase Hooks v1.1 — CONQUAS Evidence Layer (Step 3)

**Status:** DRAFT — non-implementing. Extends [iso19650-hook-outline.md](iso19650-hook-outline.md) (Step 2 v1.0) with hooks for `analysis_run`, `functional_test_evidence`, and `defects.locked_fields`.
**Version:** v1.1 (2026-04-24). Matches [conquas-evidence-spec.md](conquas-evidence-spec.md) v1.0.
**Target file:** [deploy/pocketbase/pb_hooks/main.pb.js](../deploy/pocketbase/pb_hooks/main.pb.js) — append, don't rewrite.
**Runtime:** PocketBase JSVM ES5 — same constraints as v1.0.
**Gate:** Do not implement any of this until Step 2 has shipped + soaked ≥7 days per [conquas-evidence-spec.md §11](conquas-evidence-spec.md).

---

## 0. Relationship to the v1.0 outline

[iso19650-hook-outline.md](iso19650-hook-outline.md) remains the source of truth for:

- Hash verification on `defects` create/update (hook 1).
- `photo_meta` sync + index-0 mirror (hook 2).
- `is_primary` invariant on `photo_meta` (hook 3).
- `photo_meta.revision` bump on local diff (hook 4).

v1.1 adds five new hooks, introduces a second gate flag `ISO_STEP3_ENFORCE`, and extends v1.0 hook 4 to count `analysis_run`-driven field changes in the watched-field diff. It does NOT modify hooks 1-3 — they keep working exactly as in Step 2.

---

## 1. Module-level additions (append after v1.0 block)

```javascript
// ===== ISO 19650 EVIDENCE HOOKS — STEP 3 =====
// See docs/conquas-evidence-spec.md for the evidence layer model.

var ISO_STEP3_ENFORCE = false;  // shadow mode. Flip true per migration-v2 step 11.

// Evidence-role codes recognised by the filename builder (codification-standard.md §7.2).
var ISO_EVIDENCE_ROLES = [
  "EVD", "IF", "EF", "WTT", "WPT", "WFT", "POT", "HST", "MD", "RFX", "VER"
];

// Functional-test evidence roles (subset of above). FT records must have
// a functional_test_evidence row before Done status.
var ISO_FT_ROLES = ["WTT", "WPT", "WFT", "POT", "HST"];

// Fields on defects that are lockable per codification-standard.md §13.2.
var ISO_LOCKABLE_FIELDS = [
  "title", "description", "severity", "trade",
  "component_id", "checkpoint_id",
  "location", "locationLevel", "locationZone", "locationSubzone", "locationGrid"
];

// Compute a stable input-manifest hash for analysis_run reproducibility.
// Anchors the run to the exact photo hashes, model, and prompt version used.
function iso19650BuildInputManifest(record, photoMetas, modelName, promptVersion) {
  try {
    var photoHashes = [];
    for (var i = 0; i < photoMetas.length; i++) {
      photoHashes.push(photoMetas[i].get("derived_sha256") || "");
    }
    var payload = JSON.stringify({
      model: modelName,
      prompt: promptVersion,
      hashes: photoHashes
    });
    return $security.sha256(payload);
  } catch (e) {
    return "";
  }
}
```

---

## 2. Hook 5 — `analysis_run` input-manifest computation (pre-create)

```javascript
onRecordBeforeCreateRequest((e) => {
  if (e.collection.name !== "analysis_run") return e.next();
  try {
    var defectId = e.record.get("defect_id");
    var defect = $app.dao().findRecordById("defects", defectId);
    if (!defect) throw new BadRequestError("analysis_run.defect_id does not exist");

    // Collect photo_meta rows for the input photos
    var indices = e.record.get("input_photo_indices") || [e.record.get("primary_photo_index")];
    var metas = [];
    for (var i = 0; i < indices.length; i++) {
      var meta = $app.dao().findFirstRecordByFilter(
        "photo_meta",
        "defect_id = {:d} && photo_index = {:i}",
        { d: defectId, i: indices[i] }
      );
      if (meta) metas.push(meta);
    }

    // Compute manifest hash so the client can't pass a manufactured value
    var manifest = iso19650BuildInputManifest(
      defect, metas,
      e.record.get("model_name"),
      e.record.get("prompt_profile_version")
    );
    if (manifest) e.record.set("input_manifest_sha256", manifest);

    // Validate model_provider / applied_mode enums
    var provider = e.record.get("model_provider");
    if (["gemini", "ollama", "openai", "azure_openai"].indexOf(provider) < 0) {
      if (ISO_STEP3_ENFORCE) throw new BadRequestError("unknown model_provider: " + provider);
      console.log("iso19650 step3 unknown provider (shadow):", provider);
    }
    var mode = e.record.get("applied_mode");
    if (["proposal", "auto_applied_non_locked", "manual_accept", "ignored_locked"].indexOf(mode) < 0) {
      if (ISO_STEP3_ENFORCE) throw new BadRequestError("unknown applied_mode: " + mode);
    }
  } catch (err) {
    if (err && err.status === 400 && ISO_STEP3_ENFORCE) throw err;
    console.log("iso19650 analysis_run pre-create:", err && err.message);
  }
  return e.next();
});
```

---

## 3. Hook 6 — `analysis_run` applies unlocked field changes (after-create)

```javascript
onRecordAfterCreateSuccess((e) => {
  if (e.collection.name !== "analysis_run") return e.next();
  try {
    var mode = e.record.get("applied_mode");
    if (mode === "proposal" || mode === "ignored_locked") return e.next();  // no writes

    var defectId = e.record.get("defect_id");
    var defect = $app.dao().findRecordById("defects", defectId);
    if (!defect) return e.next();

    var parsed = e.record.get("parsed_fields_json") || {};
    var lockedFields = defect.get("locked_fields") || [];
    var diffs = [];
    var anyApplied = false;

    // Apply unlocked fields only
    for (var key in parsed) {
      if (!parsed.hasOwnProperty(key)) continue;
      if (ISO_LOCKABLE_FIELDS.indexOf(key) < 0 && key !== "title" /* allow-list guard */) continue;

      var oldVal = defect.get(key);
      var newVal = parsed[key];
      if (oldVal === newVal) continue;  // no-op diff

      if (lockedFields.indexOf(key) >= 0) {
        diffs.push({ field: key, old: oldVal, new: newVal, applied: "ignored_locked" });
        continue;
      }

      defect.set(key, newVal);
      diffs.push({ field: key, old: oldVal, new: newVal, applied: "auto_applied_non_locked" });
      anyApplied = true;
    }

    // Persist diffs back to the run for audit
    e.record.set("field_diffs_json", diffs);
    $app.dao().saveRecord(e.record);

    // Update defect denormalised fields
    if (anyApplied) {
      defect.set("current_analysis_run_id", e.record.id);
      defect.set("analysis_version_no", (defect.get("analysis_version_no") || 0) + 1);
      $app.dao().saveRecord(defect);

      // Bump photo_meta.revision for the primary photo (propagates through hook 4 in v1.0)
      var primaryMeta = $app.dao().findFirstRecordByFilter(
        "photo_meta",
        "defect_id = {:d} && photo_index = {:i}",
        { d: defectId, i: e.record.get("primary_photo_index") || 0 }
      );
      if (primaryMeta) {
        primaryMeta.set("revision", (primaryMeta.get("revision") || 1) + 1);
        $app.dao().saveRecord(primaryMeta);
      }
    }
  } catch (err) {
    console.log("iso19650 analysis_run after-create:", err && err.message);
  }
  return e.next();
});
```

**Notes:**

- The hook writes `field_diffs_json` back onto the run row — `analysis_run` is append-only in the sense that *rows* aren't deleted, but the `field_diffs_json` field is written once during the after-create handler (effectively atomic with creation).
- The `photo_meta.revision` bump here fires hook 4 from v1.0, which sees the change and bumps again — double-bump risk. Mitigation: hook 4's diff check considers only differences from the *previous* saved value, so the second fire sees no diff and no-ops. Verify on staging with a dedicated test case.

---

## 4. Hook 7 — `defects.locked_fields` enforcement (pre-update)

```javascript
onRecordBeforeUpdateRequest((e) => {
  if (e.collection.name !== "defects") return e.next();
  try {
    var oldDefect = $app.dao().findRecordById("defects", e.record.id);
    if (!oldDefect) return e.next();

    var locks = oldDefect.get("locked_fields") || [];
    if (!locks.length) return e.next();

    // Check each locked field — if it changed AND the requester is not the lock owner, reject
    var operatorId = e.requestInfo().authRecord ? e.requestInfo().authRecord.id : "";
    var lockOwner = oldDefect.get("locked_fields_by") || "";  // denormalised; see note below

    for (var i = 0; i < locks.length; i++) {
      var f = locks[i];
      if (e.record.get(f) !== oldDefect.get(f)) {
        // Allow lock owner to modify; otherwise reject
        if (operatorId && operatorId === lockOwner) continue;
        if (ISO_STEP3_ENFORCE) {
          throw new BadRequestError("field '" + f + "' is locked; unlock before modifying");
        }
        console.log("iso19650 locked field write (shadow):", f);
      }
    }
  } catch (err) {
    if (err && err.status === 400 && ISO_STEP3_ENFORCE) throw err;
    console.log("iso19650 locked_fields enforcement:", err && err.message);
  }
  return e.next();
});
```

**Notes:**

- Needs a `locked_fields_by` companion field on `defects` (single user id) to implement "only the lock owner can overwrite". Alternative: maintain a separate `locked_fields` JSON as `[{field, locked_by, locked_at}]` with richer metadata. **Decision deferred** — see open question in [conquas-evidence-spec.md §9](conquas-evidence-spec.md). For draft purposes, treat `locked_fields_by` as a future addition; without it, the check falls back to "anyone can overwrite if they explicitly unlock first."
- AI-driven writes flow through hook 6, which already filters locked fields — so this hook is for direct client edits via PB API, not for hook 6's path.

---

## 5. Hook 8 — FT evidence / QP gate on status transition (pre-update)

```javascript
onRecordBeforeUpdateRequest((e) => {
  if (e.collection.name !== "defects") return e.next();
  try {
    var oldDefect = $app.dao().findRecordById("defects", e.record.id);
    if (!oldDefect) return e.next();

    var oldStatus = oldDefect.get("status");
    var newStatus = e.record.get("status");
    var role = e.record.get("evidence_role") || oldDefect.get("evidence_role");

    if (oldStatus === newStatus) return e.next();
    if (ISO_FT_ROLES.indexOf(role) < 0) return e.next();  // not an FT defect

    // Check FT evidence row exists when moving to Done
    if (newStatus === "Done") {
      var fte = $app.dao().findFirstRecordByFilter(
        "functional_test_evidence",
        "defect_id = {:d}",
        { d: e.record.id }
      );
      if (!fte) {
        if (ISO_STEP3_ENFORCE) {
          throw new BadRequestError("FT defect requires functional_test_evidence row before Done");
        }
        console.log("iso19650 FT evidence missing (shadow):", e.record.id);
      }
    }

    // Check QP declaration when moving to Verified for QP-required FTs
    if (newStatus === "Verified" && ["WTT", "WPT", "WFT"].indexOf(role) >= 0) {
      var fte2 = $app.dao().findFirstRecordByFilter(
        "functional_test_evidence",
        "defect_id = {:d}",
        { d: e.record.id }
      );
      if (fte2 && fte2.get("qp_declaration_status") !== "declared") {
        if (ISO_STEP3_ENFORCE) {
          throw new BadRequestError("QP-required FT must have qp_declaration_status='declared' before Verified");
        }
        console.log("iso19650 QP declaration missing (shadow):", e.record.id);
      }
    }
  } catch (err) {
    if (err && err.status === 400 && ISO_STEP3_ENFORCE) throw err;
    console.log("iso19650 FT/QP gate:", err && err.message);
  }
  return e.next();
});
```

**Notes:**

- POT (Pull-Off) and HST (Heat Soak) are handled by EN 14179-2 + 3-yr warranty per CONQUAS — their QP requirement lives in the project information standard, not here. For draft purposes they're not gated by this hook; the per-project info standard sets the rule.
- The "before Done" and "before Verified" gates are soft in shadow mode. In enforce mode they become hard blocks, so user testing on staging is essential to catch legitimate workflows that legitimately skip documentation (e.g. emergency site defects).

---

## 6. Hook 9 — `major_defect_flag` denormalised mirror (pre-create/pre-update on `defects`)

```javascript
onRecordBeforeCreateRequest((e) => {
  if (e.collection.name !== "defects") return e.next();
  e.record.set("major_defect_flag", e.record.get("evidence_role") === "MD");
  return e.next();
});

onRecordBeforeUpdateRequest((e) => {
  if (e.collection.name !== "defects") return e.next();
  e.record.set("major_defect_flag", e.record.get("evidence_role") === "MD");
  return e.next();
});
```

**Notes:**

- Trivial but necessary: the indexed `major_defect_flag` is what REVIEW filters use; it must never drift from `evidence_role`.
- For updates that don't touch `evidence_role`, PB's "only-write-changed" semantics mean this no-ops. For updates that do touch it, the mirror is recomputed.

---

## 7. Registration order (v1.0 → v1.1)

Append after the v1.0 block in [main.pb.js](../deploy/pocketbase/pb_hooks/main.pb.js):

1. Module-level (§1).
2. Hook 5 — `analysis_run` pre-create input manifest (§2).
3. Hook 6 — `analysis_run` after-create apply diffs (§3).
4. Hook 7 — `defects` pre-update locked_fields check (§4).
5. Hook 8 — `defects` pre-update FT/QP gate (§5).
6. Hook 9a — `defects` pre-create major_defect_flag mirror (§6).
7. Hook 9b — `defects` pre-update major_defect_flag mirror (§6).

PB fires multiple hooks on the same event in registration order. Hook 7, 8, and 9b all handle `defects` pre-update — they're independent and can coexist; each checks only its own concern.

---

## 8. Failure modes to test before enforcing

| Scenario | Expected (shadow) | Expected (enforce) |
|---|---|---|
| AI analyze with `applied_mode=proposal` | Run row saved; no `defects` changes | Same |
| AI analyze, no locked fields, `applied_mode=auto_applied_non_locked` | All returned fields written to defects; `analysis_version_no++`; `photo_meta.revision++` | Same |
| AI analyze with `severity` locked | `severity` NOT written; appears in `field_diffs_json` with `applied: "ignored_locked"`; other fields applied | Same |
| AI analyze with ALL fields locked | No writes; `field_diffs_json` shows all `ignored_locked`; `analysis_version_no` NOT incremented | Same |
| Client writes defect with `severity` change when `severity` is locked | Shadow: logged, allowed | Enforce: rejected with `BadRequestError` |
| FT defect (`role=WTT`) status → `Done` with no `functional_test_evidence` row | Shadow: logged, allowed | Enforce: rejected |
| FT defect status → `Verified` with `qp_declaration_status=required_pending` | Shadow: logged, allowed | Enforce: rejected |
| Update `evidence_role` from `EVD` to `MD` | `major_defect_flag` flips to `true` | Same |
| `analysis_run` created with unknown `model_provider` | Shadow: logged, allowed | Enforce: rejected |
| Hook 6 double-bump on `photo_meta.revision` | v1.0 hook 4 sees no diff on second fire, no-ops | Same |

---

## 9. Rollback

1. Set both `ISO_ENFORCE = false` (v1.0) and `ISO_STEP3_ENFORCE = false` to return to shadow-mode logging.
2. To fully remove Step 3 hooks: comment out hooks 5-9 in [main.pb.js](../deploy/pocketbase/pb_hooks/main.pb.js), restart PB. Step 2 hooks (1-4) continue to function.
3. To remove the collections, follow the rollback checklist in [iso19650-migration-v2.json](iso19650-migration-v2.json) `_rollback_checklist`.

---

## 10. Open uncertainties (staging verification required)

Inherits all three uncertainties from [iso19650-hook-outline.md §9](iso19650-hook-outline.md) and adds:

4. **`e.record.originalCopy()` availability on `onRecordBeforeUpdateRequest("defects")`** — hooks 7 and 8 need the previous state. If the PB version lacks `originalCopy()`, fall back to `findRecordById(id)` at the top of each hook (slower but reliable).
5. **Input manifest hash stability across JS runtimes** — the `JSON.stringify` output order is unspecified in ES5. If the manifest is computed client-side AND server-side with differing key orders, the hashes won't match. Mitigation: always sort keys before stringifying, both client and server. Document this requirement.
6. **Transaction semantics for hook 6** — writing to both the `analysis_run` row and the `defects` row from a single hook is not wrapped in a database transaction by PB's default handler model. If the defect write fails after the run row is saved, we end up with a run that claims to have applied fields that weren't actually written. Mitigation: check `defects.save()` return value and, on failure, write `field_diffs_json = {error: "defect_save_failed"}` back to the run row for forensics.

These must be resolved on staging before enforcing. The rest of the outline stands regardless.

---

## 11. References

- [conquas-evidence-spec.md](conquas-evidence-spec.md) — spec these hooks implement.
- [iso19650-photo-meta-spec.md](iso19650-photo-meta-spec.md) — Step 2 foundation.
- [iso19650-hook-outline.md](iso19650-hook-outline.md) — Step 2 hooks (v1.0) that these extend.
- [codification-standard.md](codification-standard.md) §7.2 — workflow-role codes (v2.0).
- [codification-standard.md](codification-standard.md) §13.2 — watched-fields list.
- [iso19650-migration-v2.json](iso19650-migration-v2.json) — schema changes these hooks rely on.
- BCA CONQUAS (Private Residential) 2025 circular — FT and QP declaration rules.
