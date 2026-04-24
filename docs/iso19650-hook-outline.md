# PocketBase Hooks — ISO 19650 Photo Evidence

**Status:** Draft outline. No hook code applied yet.
**Target file:** [deploy/pocketbase/pb_hooks/main.pb.js](../deploy/pocketbase/pb_hooks/main.pb.js) — append, don't rewrite.
**Runtime:** PocketBase JSVM — **ES5**, not ES6+. Use `var`, `function`, plain arrow callbacks OK in handlers; no `const`/`let`/destructuring/template-literals at the file level (see existing hook code in [main.pb.js](../deploy/pocketbase/pb_hooks/main.pb.js) for the baseline style).
**Version:** v1.0 (2026-04-24). Matches [iso19650-photo-meta-spec.md](iso19650-photo-meta-spec.md) v1.1.

---

## 0. Context

This outline specifies four hooks for the `photo_meta` collection and one for `defects`. Every hook is written in **shadow mode** by default — a single module-level boolean flag `ISO_ENFORCE` gates whether hash mismatches reject saves or merely log. Flip to `true` per the rollout sequence in the main spec §9.

All hooks run inside PocketBase's single-node JSVM. They use:

- `$app.dao()` — DAO for record lookup / save.
- `$app.db()` — raw SQL access (already used in the existing rate limiter + storage cap hooks).
- `throw new BadRequestError(msg)` — rejects the request with HTTP 400.
- The existing `rateLimit(key, maxPerMinute)` helper at [main.pb.js:15-23](../deploy/pocketbase/pb_hooks/main.pb.js#L15) is unrelated but illustrates the ES5 style.

Per **per-photo auto-memory rule**: server-side exceptions must be caught and converted to explicit `BadRequestError` — generic uncaught throws produce the dreaded empty-`data:{}` 400 that took hours to diagnose before (see feedback memory "PB generic 400 = hook throw").

---

## 1. Module-level additions

Prepend this block after the existing `COMPANY_STORAGE_CAP_BYTES` block:

```javascript
// ===== ISO 19650 EVIDENCE HOOKS =====
// See docs/iso19650-photo-meta-spec.md for data model, docs/codification-standard.md
// for field vocabulary, docs/iso19650-hook-outline.md for rationale.

var ISO_ENFORCE = false;  // shadow mode. Flip to true per rollout §9 step 5.

// Compute SHA-256 of a byte array. PB JSVM exposes `toString(bytes, "hex")`
// after passing through a crypto call. Verify the actual API shape against
// the PB version in production before enforcing.
function iso19650Sha256(bytes) {
  try {
    return $security.sha256(bytes).toLowerCase();
  } catch (e) {
    return "";
  }
}

// Compute short hash8 prefix for filename tails. Returns lowercase hex or "".
function iso19650Hash8(fullHex) {
  if (!fullHex || fullHex.length < 8) return "";
  return fullHex.substring(0, 8).toLowerCase();
}

// Load photos_meta_pending from the incoming request body. Always returns
// an array (empty if absent). Ordering matches photo_index 0..N.
function iso19650PendingMeta(e) {
  try {
    var raw = e.requestInfo().data["photos_meta_pending"];
    if (!raw) return [];
    if (typeof raw === "string") raw = JSON.parse(raw);
    return Array.isArray(raw) ? raw : [];
  } catch (err) {
    return [];
  }
}

// Watched fields for revision bump per codification-standard.md §13.2.
// Changes to any of these on `defects` trigger a pending bump on the
// next photo_meta touch.
var ISO_WATCHED_DEFECT_FIELDS = [
  "title", "description", "severity", "trade",
  "component_id", "checkpoint_id"
];

var ISO_WATCHED_META_FIELDS = [
  "derived_sha256", "original_sha256", "iso_filename", "quality"
];
```

---

## 2. Hook 1 — Server-side hash verification on `defects` create/update

```javascript
onRecordCreateRequest((e) => {
  if (e.collection.name !== "defects") return e.next();
  try { iso19650VerifyPhotoHashes(e); } catch (err) {
    // Only BadRequestError propagates; any other error is a bug and must
    // not block legitimate saves.
    if (err && err.status === 400 && ISO_ENFORCE) throw err;
    console.log("iso19650 verify (shadow/create):", err && err.message);
  }
  return e.next();
});

onRecordUpdateRequest((e) => {
  if (e.collection.name !== "defects") return e.next();
  try { iso19650VerifyPhotoHashes(e); } catch (err) {
    if (err && err.status === 400 && ISO_ENFORCE) throw err;
    console.log("iso19650 verify (shadow/update):", err && err.message);
  }
  return e.next();
});

function iso19650VerifyPhotoHashes(e) {
  var record = e.record;
  var pending = iso19650PendingMeta(e);
  if (!pending.length) return;  // no client-supplied meta; hook 2 fills defaults

  var photos = record.get("photo") || [];
  for (var i = 0; i < photos.length; i++) {
    var claim = pending[i] && pending[i].derived_sha256;
    if (!claim) continue;  // client omitted; server will fill via hook 2

    var bytes = $filesystem.fileFromRecord(record, "photo", i);
    if (!bytes) continue;
    var computed = iso19650Sha256(bytes);
    if (computed && claim !== computed) {
      throw new BadRequestError(
        "media_hash_mismatch on photo[" + i + "]: client=" +
        claim.substring(0, 12) + "... server=" + computed.substring(0, 12) + "..."
      );
    }
  }
}
```

**Notes:**

- The actual PB file-bytes API (`$filesystem.fileFromRecord` above) is a placeholder. Verify against the PB version's JSVM docs before implementation — PB 0.22+ exposes a filesystem helper; earlier versions require reading from the underlying store. If the helper isn't available, compute hashes client-side only and skip server verification (accept the trust cost; document the gap).
- In **shadow mode** (`ISO_ENFORCE = false`), every mismatch is logged but not rejected. This lets the team audit the real mismatch rate for 24h before going strict — any mismatch in shadow mode is probably a client bug to fix, not a malicious attack.
- The hook **does not** write `photo_meta` rows itself — that's hook 2's job, running on the after-success event so PB's transaction semantics handle rollback for us.

---

## 3. Hook 2 — Write / update `photo_meta` rows after defect save

```javascript
onRecordAfterCreateSuccess((e) => {
  if (e.collection.name !== "defects") return e.next();
  try { iso19650SyncPhotoMeta(e.record, iso19650PendingMeta(e)); } catch (err) {
    console.log("iso19650 sync (after-create):", err && err.message);
  }
  return e.next();
});

onRecordAfterUpdateSuccess((e) => {
  if (e.collection.name !== "defects") return e.next();
  try { iso19650SyncPhotoMeta(e.record, iso19650PendingMeta(e)); } catch (err) {
    console.log("iso19650 sync (after-update):", err && err.message);
  }
  return e.next();
});

function iso19650SyncPhotoMeta(defect, pending) {
  var photos = defect.get("photo") || [];
  var originals = defect.get("photoOriginal") || [];
  var watchedDiff = false;  // set if any watched defect field changed vs old

  for (var i = 0; i < Math.max(photos.length, originals.length, pending.length); i++) {
    var claim = pending[i] || {};
    var filters = [
      $dbx.hashExp({
        "defect_id": defect.id,
        "photo_index": i
      })
    ];
    var existing = null;
    try {
      existing = $app.dao().findFirstRecordByFilter(
        "photo_meta",
        "defect_id = {:d} && photo_index = {:i}",
        { d: defect.id, i: i }
      );
    } catch (_err) { existing = null; }

    var collection = $app.dao().findCollectionByNameOrId("photo_meta");
    var meta = existing || new Record(collection);

    meta.set("defect_id", defect.id);
    meta.set("photo_index", i);
    meta.set("is_primary", i === 0);  // invariant per spec §10.2

    if (claim.derived_sha256) meta.set("derived_sha256", claim.derived_sha256);
    if (claim.original_sha256) meta.set("original_sha256", claim.original_sha256);
    if (claim.iso_filename) meta.set("iso_filename", claim.iso_filename);
    if (claim.capture_offset_minutes !== undefined) {
      meta.set("capture_offset_minutes", claim.capture_offset_minutes);
    }
    if (claim.quality) meta.set("quality", claim.quality);

    // Revision bump: only on actual diff, per Decision 10.4.
    if (existing) {
      var shouldBump = false;
      for (var f = 0; f < ISO_WATCHED_META_FIELDS.length; f++) {
        var key = ISO_WATCHED_META_FIELDS[f];
        if (claim[key] !== undefined && claim[key] !== existing.get(key)) {
          shouldBump = true; break;
        }
      }
      if (!shouldBump && watchedDiff) shouldBump = true;
      if (shouldBump) {
        meta.set("revision", (existing.get("revision") || 1) + 1);
      }
    } else {
      meta.set("revision", 1);
    }

    $app.dao().saveRecord(meta);

    // Mirror to defect for index 0 (Option A back-compat per spec §4.2).
    if (i === 0) {
      defect.set("media_hash", meta.get("derived_sha256") || meta.get("original_sha256"));
      defect.set("iso_filename", meta.get("iso_filename"));
      $app.dao().saveRecord(defect);
    }
  }
}
```

**Notes:**

- `watchedDiff` detection for the parent `defects` record requires comparing pre/post state. PocketBase `onRecordAfterUpdateSuccess` does not directly expose the original record; retrieve it via `e.record.originalCopy()` if available, or skip defect-field-diff detection and rely solely on meta-field diff. Document the compromise in the hook's inline comment.
- The `is_primary` invariant is enforced **here** by forcing the value to `i === 0`. Even if the client claims otherwise, the server overrides. Combined with the unique index on `(defect_id, photo_index)` from the migration, this guarantees at most one primary per defect.
- Failures inside this hook log but do not reject — the defect save has already succeeded at this point, and failing it retroactively would leave the user confused. A failed `photo_meta` sync is repairable by the backfill script (§6 of the main spec).

---

## 4. Hook 3 — Enforce `is_primary` invariant on direct `photo_meta` writes

```javascript
onRecordBeforeCreateRequest((e) => {
  if (e.collection.name !== "photo_meta") return e.next();
  e.record.set("is_primary", e.record.get("photo_index") === 0);
  return e.next();
});

onRecordBeforeUpdateRequest((e) => {
  if (e.collection.name !== "photo_meta") return e.next();
  e.record.set("is_primary", e.record.get("photo_index") === 0);
  return e.next();
});
```

**Notes:**

- These exist for direct edits via PB Admin or a rogue client. Hook 2 already enforces the invariant during the defect-save path; this is a belt-and-braces defence.
- Overriding silently (no exception) is deliberate — administrators editing in Admin shouldn't get a confusing error; the server just corrects the value.

---

## 5. Hook 4 — Revision bump on direct `photo_meta` update

```javascript
onRecordBeforeUpdateRequest((e) => {
  if (e.collection.name !== "photo_meta") return e.next();
  try {
    var before = $app.dao().findRecordById("photo_meta", e.record.id);
    if (!before) return e.next();
    var bumped = false;
    for (var f = 0; f < ISO_WATCHED_META_FIELDS.length; f++) {
      var key = ISO_WATCHED_META_FIELDS[f];
      if (e.record.get(key) !== before.get(key)) { bumped = true; break; }
    }
    if (bumped) {
      e.record.set("revision", (before.get("revision") || 1) + 1);
    }
  } catch (err) {
    // Non-fatal — missing prior state just means we don't bump
    console.log("iso19650 revision bump check failed:", err && err.message);
  }
  return e.next();
});
```

**Notes:**

- This overlaps with hook 2's logic. The reason both exist: hook 2 handles the common defect-save path; hook 4 handles direct `photo_meta` updates via PB Admin or API (e.g. manual correction of `quality.warnings`).
- Both hooks can coexist safely because PB processes them in registration order and each performs an idempotent bump decision — if hook 2 already bumped, hook 4's `before.get("revision")` will read the bumped value, and the `bumped` diff check will see no further change.

---

## 6. Registration order

Append the hooks in this order to [main.pb.js](../deploy/pocketbase/pb_hooks/main.pb.js):

1. Module-level additions (§1).
2. `onRecordCreateRequest` for `defects` (§2).
3. `onRecordUpdateRequest` for `defects` (§2).
4. `onRecordAfterCreateSuccess` for `defects` (§3).
5. `onRecordAfterUpdateSuccess` for `defects` (§3).
6. `onRecordBeforeCreateRequest` for `photo_meta` (§4).
7. `onRecordBeforeUpdateRequest` for `photo_meta` — invariant enforcement (§4).
8. `onRecordBeforeUpdateRequest` for `photo_meta` — revision bump (§5).

PB fires hooks in registration order for the same event, so hook 7 runs before hook 8 on a `photo_meta` update. Hook 7's `is_primary` override therefore doesn't count as a "watched field change" in hook 8's diff (neither `is_primary` nor `photo_index` is in `ISO_WATCHED_META_FIELDS`).

---

## 7. Failure modes to test before going strict

Before flipping `ISO_ENFORCE = true`, verify:

| Scenario | Expected behaviour |
|---|---|
| Client omits `photos_meta_pending` entirely | Hook 1 no-ops; hook 2 creates rows with `revision=1`, `quality.warnings=["legacy_client"]`. Save succeeds. |
| Client claims wrong hash for photo[0] | **Shadow mode:** log only, save succeeds. **Enforce mode:** `BadRequestError`, save rejected. |
| Client claims hash for photo[2] that doesn't exist | Hook 1 iterates up to `photos.length`; extra claims are ignored. No error. |
| Defect saved offline and replayed via queue | Client supplies `photos_meta_pending`; hook 1 verifies; hook 2 writes. Same path as online. |
| Defect saved by an old client that's never updated | No `photos_meta_pending`; hook 2 writes defaults. Save succeeds. |
| File-bytes API unavailable in this PB version | `iso19650Sha256` returns empty; hook 1 skips comparison and logs. Save succeeds. |
| `photo_meta` write fails (e.g. table missing) | Hook 2 catches and logs; defect save already succeeded; backfill later repairs. |
| Admin manually bumps `revision` via PB Admin | Hook 5 sees no watched-field diff; no additional bump. Admin's value wins. |
| Admin changes `is_primary` directly | Hook 4 overrides back to `(photo_index === 0)`. No error to the admin. |
| Two concurrent saves race for the same slot | Unique index on `(defect_id, photo_index)` causes one to fail at the DB level; PB returns error to that client. |

---

## 8. Rollback

To disable all four hooks in an emergency:

1. Edit [main.pb.js](../deploy/pocketbase/pb_hooks/main.pb.js): set `ISO_ENFORCE = false` at the top of the block. No rejections occur.
2. Or: comment out the four `onRecord…` blocks entirely. Defects save without any `photo_meta` writes; mirror fields on `defects` stop updating but existing values remain intact.
3. Restart PocketBase: `systemctl restart pocketbase` on the GCP VM. Hooks reload from disk.

Rolling back the hooks does **not** require rolling back the schema — the `photo_meta` collection can stay empty until the hooks are re-enabled. See [iso19650-migration-v1.json](iso19650-migration-v1.json) `_rollback_checklist` for collection-level rollback.

---

## 9. Open uncertainty (requires PB-version testing)

- The exact JSVM API for hashing file bytes (`$security.sha256`, `$filesystem.fileFromRecord`) is unverified against our production PB version. **Action before implementing:** write a 10-line test hook on staging that computes a hash of a known byte string and compares to an expected value. If the API is different, adapt `iso19650Sha256` accordingly — the rest of the outline stands.
- `e.record.originalCopy()` availability in `onRecordAfterUpdateSuccess` is likewise version-dependent. If unavailable, the "defect watched-field diff → revision bump" path in hook 2 degrades to "only bump on `photo_meta`-local diffs." Document this degradation in a code comment if it bites; it doesn't break the spec — per Decision 10.4, the revision bump only needs to fire on *any* watched-field change, and `photo_meta` mutations alone still satisfy that for most practical re-analyze paths (which write `iso_filename` + `quality`).
- `requestInfo().data["photos_meta_pending"]` assumes the client packs the metadata as a top-level request-body key. If the client instead nests it inside a JSON string field, adjust `iso19650PendingMeta`.

These three uncertainties are the reason the hook code stays as an outline, not a merge-ready patch. Resolve them on staging before applying to production.

---

## 10. References

- [iso19650-photo-meta-spec.md](iso19650-photo-meta-spec.md) — data-model spec; cross-references into §4.1 (schema), §5.x (hook semantics), §10 (adopted decisions).
- [codification-standard.md](codification-standard.md) §13.2 — watched-fields list (source of truth for `ISO_WATCHED_DEFECT_FIELDS` / `ISO_WATCHED_META_FIELDS`).
- [iso19650-migration-v1.json](iso19650-migration-v1.json) — schema that these hooks depend on.
- [deploy/pocketbase/pb_hooks/main.pb.js](../deploy/pocketbase/pb_hooks/main.pb.js) — target file; append, don't rewrite.
- SiteShrimp feedback memory *"PB generic 400 = hook throw"* — the reason every exception path in this outline is defensively caught.
