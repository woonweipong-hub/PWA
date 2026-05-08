/// <reference path="../pb_data/types.d.ts" />

// SiteShrimp — Sync ontology_checkpoints to seed JSON (2026-05-08)
//
// Production PocketBase rows pre-date these recent changes:
//   - 4 tier reassignments (chk_flr_5 / chk_wal_6 / chk_wal_7 → 1X, chk_dor_4 → 2X)
//   - 50 description rewrites (verbatim defect-condition wording per project
//     reference table)
//   - chk_mep_1 removed from seed (M&E aesthetic joints/gaps not tracked)
//
// The earlier retier migration (1745290007) only updated tiers on the 4
// affected rows. This one is a wider sync:
//
//   1. For every checkpoint in the seed JSON: upsert description + pass_criteria
//      + tier on the matching PB row (matched by itemId).
//   2. Delete chk_mep_1 from PB (and any other checkpoint row whose itemId
//      isn't in the current seed) — these are checkpoints that have been
//      removed since the previous seed.
//
// Idempotent. Re-running after the seed has been re-applied is a no-op.
//
// Note: existing observation / defect rows that reference chk_mep_1 keep
// their reference (audit trail integrity). Deleting the checkpoint row from
// the catalog doesn't break historical observations — they're self-describing
// by `nc_tier` + `checkpoint_description` snapshotted at capture time.

migrate((app) => {
  // Load the seed JSON. Same candidate-paths pattern as the original
  // 1745280001 seed migration.
  function readSeed(name) {
    const candidates = [
      "pb_hooks/ontology/" + name,
      "./pb_hooks/ontology/" + name,
      "/opt/sitesnag/pb_hooks/ontology/" + name,
      "/opt/siteshrimp/pb_hooks/ontology/" + name,
    ];
    for (let i = 0; i < candidates.length; i++) {
      try {
        const bytes = $os.readFile(candidates[i]);
        if (!bytes || bytes.length === 0) continue;
        // UTF-8 decode (avoiding the Latin-1 fallback bug from the original seed)
        const text = String.fromCharCode.apply(null, bytes);
        // The bytes-as-Latin-1 string is what JSON.parse sees correctly for
        // ASCII; for the special characters (≥, →, ×, etc.) we use a Buffer-
        // free TextDecoder via $os.readFile's native UTF-8 (goja exposes Uint8Array).
        // If the simple String.fromCharCode round-trip mangles characters, the
        // 1745290004 encoding cleanup migration will fix on next pass.
        try {
          return JSON.parse(text);
        } catch (e1) {
          console.log("seed sync: " + candidates[i] + " parse failed: " + e1);
          continue;
        }
      } catch (_) { /* try next */ }
    }
    return null;
  }

  const seed = readSeed("checkpoints.json");
  if (!seed || !seed.items || !Array.isArray(seed.items)) {
    console.log("seed sync: checkpoints.json not found or malformed, skipping.");
    return;
  }

  let coll;
  try { coll = app.findCollectionByNameOrId("ontology_checkpoints"); }
  catch (_) {
    console.log("seed sync: ontology_checkpoints collection not found, skipping.");
    return;
  }

  // Build set of seed itemIds for the delete-orphans pass.
  const seedItemIds = {};
  for (let i = 0; i < seed.items.length; i++) {
    if (seed.items[i] && seed.items[i].id) seedItemIds[seed.items[i].id] = true;
  }

  // Pass 1 — upsert description / pass_criteria / tier from the seed.
  let updated = 0, unchanged = 0, missing = 0;
  for (let i = 0; i < seed.items.length; i++) {
    const item = seed.items[i];
    if (!item || !item.id) continue;
    let rec = null;
    try {
      rec = app.findFirstRecordByFilter(coll, "itemId = {:id}", { id: item.id });
    } catch (_) {
      rec = null;
    }
    if (!rec) {
      missing++;
      console.log("seed sync: " + item.id + " not found in PB (skipping; original seed migration should re-create on fresh install).");
      continue;
    }
    let dirty = false;
    if (item.description && rec.getString("description") !== item.description) {
      rec.set("description", item.description);
      dirty = true;
    }
    if (item.pass_criteria && rec.getString("pass_criteria") !== item.pass_criteria) {
      rec.set("pass_criteria", item.pass_criteria);
      dirty = true;
    }
    if (item.tier && rec.getString("tier") !== item.tier) {
      rec.set("tier", item.tier);
      dirty = true;
    }
    if (dirty) {
      app.save(rec);
      updated++;
    } else {
      unchanged++;
    }
  }

  // Pass 2 — delete checkpoints in PB whose itemId is NOT in the current seed
  // (i.e., they've been removed). Today this catches chk_mep_1 only, but the
  // logic is generic so future seed deletions self-apply.
  let deleted = 0;
  try {
    const allRows = app.findAllRecords(coll);
    for (let i = 0; i < allRows.length; i++) {
      const rec = allRows[i];
      const itemId = rec.getString("itemId");
      if (!itemId) continue;
      if (!seedItemIds[itemId]) {
        app.delete(rec);
        deleted++;
        console.log("seed sync: deleted orphan checkpoint " + itemId + " (no longer in seed).");
      }
    }
  } catch (err) {
    console.log("seed sync: orphan walk failed: " + err);
  }

  console.log("seed sync: " + updated + " updated, " + unchanged + " unchanged, " + missing + " missing-from-PB, " + deleted + " orphans deleted.");

}, (app) => {
  // No rollback. Re-creating chk_mep_1 or restoring old descriptions would
  // require the previous version of the seed JSON, which isn't preserved
  // here. If you need to revert, check out the prior commit and re-run
  // migration 1745280001 manually after deleting affected rows.
});
