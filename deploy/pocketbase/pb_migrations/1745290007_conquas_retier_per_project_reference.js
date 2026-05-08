/// <reference path="../pb_data/types.d.ts" />

// SiteShrimp — CONQUAS retiering per project reference table (2026-05-08)
//
// Updates four checkpoint + defect_type tier values to match the project's
// authoritative CONQUAS Internal Finishes reference table:
//   - Floor levelness (chk_flr_5 / flr_2x_unevenness)        2X → 1X
//   - Wall plumbness  (chk_wal_6 / wal_2x_unevenness)        2X → 1X
//   - Wall squareness (chk_wal_7 / wal_2x_squareness)        2X → 1X
//   - Door alignment  (chk_dor_4 / dor_3x_misalignment)      3X → 2X
//
// The R1 §3.2 conceptual reading would tier these higher (measured-tolerance
// breaches and door-fit issues affect Functionality / Liveability), but the
// project's reference document tiers them as listed in the table above —
// product owner has confirmed this version is authoritative for SiteShrimp's
// banding projection.
//
// Existing observation / defect rows are left as-is — the tier value baked
// into each record reflects the rule that was in force at capture time. New
// observations created against these checkpoints from now on will use the
// updated tiers. (Treat historical data as frozen at capture-time tier.)
//
// Idempotent. Safe to re-run — no-op once the tiers match the target values.

migrate((app) => {
  const CHECKPOINT_RETIERS = [
    { itemId: "chk_flr_5", newTier: "1X", label: "Floor levelness" },
    { itemId: "chk_wal_6", newTier: "1X", label: "Wall plumbness" },
    { itemId: "chk_wal_7", newTier: "1X", label: "Wall squareness" },
    { itemId: "chk_dor_4", newTier: "2X", label: "Door alignment" },
  ];
  const DEFECT_TYPE_RETIERS = [
    { itemId: "flr_2x_unevenness", newTier: "1X", label: "Floor unevenness" },
    { itemId: "wal_2x_unevenness", newTier: "1X", label: "Wall unevenness" },
    { itemId: "wal_2x_squareness", newTier: "1X", label: "Wall squareness" },
    { itemId: "dor_3x_misalignment", newTier: "2X", label: "Door misalignment" },
  ];

  function retier(collectionName, list) {
    let coll;
    try { coll = app.findCollectionByNameOrId(collectionName); }
    catch (_) {
      console.log("retier: " + collectionName + " not found, skipping.");
      return 0;
    }
    let changed = 0;
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      let rec = null;
      try {
        rec = app.findFirstRecordByFilter(coll, "itemId = {:id}", { id: item.itemId });
      } catch (_) {
        rec = null;
      }
      if (!rec) {
        console.log("retier: " + collectionName + "/" + item.itemId + " not found, skipping.");
        continue;
      }
      const cur = rec.getString("tier");
      if (cur === item.newTier) {
        // Already retiered (re-run case) — no-op.
        continue;
      }
      rec.set("tier", item.newTier);
      app.save(rec);
      changed++;
      console.log("retier: " + collectionName + "/" + item.itemId + " (" + item.label + ") " + cur + " → " + item.newTier);
    }
    return changed;
  }

  const c1 = retier("ontology_checkpoints", CHECKPOINT_RETIERS);
  const c2 = retier("ontology_defect_types", DEFECT_TYPE_RETIERS);
  console.log("CONQUAS retier per project reference: " + c1 + " checkpoint(s), " + c2 + " defect-type(s) updated.");

}, (app) => {
  // Rollback restores the previous (R1 §3.2 conceptual) tier values. Only
  // useful if the project reference is later corrected back to the R1 reading.
  const CHECKPOINT_ROLLBACK = [
    { itemId: "chk_flr_5", tier: "2X" },
    { itemId: "chk_wal_6", tier: "2X" },
    { itemId: "chk_wal_7", tier: "2X" },
    { itemId: "chk_dor_4", tier: "3X" },
  ];
  const DEFECT_TYPE_ROLLBACK = [
    { itemId: "flr_2x_unevenness", tier: "2X" },
    { itemId: "wal_2x_unevenness", tier: "2X" },
    { itemId: "wal_2x_squareness", tier: "2X" },
    { itemId: "dor_3x_misalignment", tier: "3X" },
  ];
  function restore(collectionName, list) {
    let coll;
    try { coll = app.findCollectionByNameOrId(collectionName); } catch (_) { return; }
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      let rec = null;
      try { rec = app.findFirstRecordByFilter(coll, "itemId = {:id}", { id: item.itemId }); } catch (_) { continue; }
      if (!rec) continue;
      rec.set("tier", item.tier);
      app.save(rec);
    }
  }
  restore("ontology_checkpoints", CHECKPOINT_ROLLBACK);
  restore("ontology_defect_types", DEFECT_TYPE_ROLLBACK);
});
