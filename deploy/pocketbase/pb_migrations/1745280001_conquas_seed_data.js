/// <reference path="../pb_data/types.d.ts" />

// SiteShrimp — CONQUAS ontology data seed migration (Phase 2.3)
//
// Populates the four ontology_* collections on fresh installs. Tracked by
// PB's _migrations table, so runs exactly once per deploy and is not
// vulnerable to the onBootstrap / modelQuery SIGSEGV that killed the
// earlier _ontology_seed.pb.js runtime hook.
//
// Idempotency safety net: even though PB tracks applied migrations, we also
// check if the collection already has rows before inserting (so retrying a
// failed migration or running on a VM where the data was manually seeded
// doesn't create duplicates).

migrate((app) => {
  // If the data is already there, skip — this protects against:
  //  - the VM where the prior `_ontology_seed.pb.js` already ran
  //  - manual re-runs of this migration
  try {
    const existing = app.db().newQuery("SELECT id FROM ontology_components LIMIT 1").one();
    if (existing) {
      console.log("Ontology seed migration: data already present, skipping.");
      return;
    }
  } catch (_) {
    // "no rows" → proceed with seed
  }

  // Resolve seed JSON directory — try several candidate paths.
  function readSeed(name) {
    const candidates = [
      "pb_hooks/ontology/" + name,
      "./pb_hooks/ontology/" + name,
      "/opt/sitesnag/pb_hooks/ontology/" + name,
      "/opt/siteshrimp/pb_hooks/ontology/" + name
    ];
    for (let i = 0; i < candidates.length; i++) {
      try {
        const bytes = $os.readFile(candidates[i]);
        if (!bytes || bytes.length === 0) continue;
        let text;
        if (typeof bytes === "string") text = bytes;
        else if (typeof $toString === "function") text = $toString(bytes);
        else text = String.fromCharCode.apply(null, bytes);
        return JSON.parse(text);
      } catch (_) { /* try next */ }
    }
    console.log("Ontology seed migration: could not read " + name);
    return null;
  }

  function insertRow(collectionName, fields) {
    try {
      const coll = app.findCollectionByNameOrId(collectionName);
      const rec = new Record(coll);
      for (const k in fields) {
        if (Object.prototype.hasOwnProperty.call(fields, k)) {
          rec.set(k, fields[k]);
        }
      }
      app.save(rec);
      return true;
    } catch (err) {
      console.log("Ontology seed migration: insert into " + collectionName + " failed: " + err);
      return false;
    }
  }

  const componentsData = readSeed("components.json");
  const defectTypesData = readSeed("defect_types.json");
  const checkpointsData = readSeed("checkpoints.json");
  const tradesData = readSeed("trades.json");

  if (!componentsData && !defectTypesData && !checkpointsData && !tradesData) {
    console.log("Ontology seed migration: no seed files found, skipping.");
    return;
  }

  let n1 = 0, n2 = 0, n3 = 0, n4 = 0;

  if (componentsData && Array.isArray(componentsData.items)) {
    componentsData.items.forEach((item) => {
      const ok = insertRow("ontology_components", {
        edition: componentsData.dataset.edition,
        version: componentsData.dataset.version,
        itemId: item.id,
        name: item.name || "",
        category: item.category || "",
        assessment_weight_pct: item.assessment_weight_pct || null,
        parent_id: item.parent_id || "",
        phase: item.phase || null,
        verbatim_source: item.verbatim_source || "",
        gip_references: item.gip_references || [],
        note: item.note || "",
        provenance_override: item.provenance_override || null,
        needs_review: !!item.needs_review
      });
      if (ok) n1++;
    });
  }

  if (defectTypesData && Array.isArray(defectTypesData.items)) {
    defectTypesData.items.forEach((item) => {
      const ok = insertRow("ontology_defect_types", {
        edition: defectTypesData.dataset.edition,
        version: defectTypesData.dataset.version,
        itemId: item.id,
        element: item.element || "",
        typical_component_ids: item.typical_component_ids || [],
        tier: item.tier || "",
        name: item.name || "",
        measurement_threshold: item.measurement_threshold || "",
        verbatim_source_row: item.verbatim_source_row || "",
        needs_review: !!item.needs_review
      });
      if (ok) n2++;
    });
  }

  if (checkpointsData && Array.isArray(checkpointsData.items)) {
    checkpointsData.items.forEach((item) => {
      const ok = insertRow("ontology_checkpoints", {
        edition: checkpointsData.dataset.edition,
        version: checkpointsData.dataset.version,
        itemId: item.id,
        component_id: item.component_id || "",
        tier: item.tier || "",
        description: item.description || "",
        pass_criteria: item.pass_criteria || "",
        related_defect_type_ids: item.related_defect_type_ids || []
      });
      if (ok) n3++;
    });
  }

  if (tradesData && Array.isArray(tradesData.items)) {
    tradesData.items.forEach((item) => {
      const ok = insertRow("ontology_trades", {
        edition: tradesData.dataset.edition,
        version: tradesData.dataset.version,
        itemId: item.id,
        name: item.name || "",
        gip_reference: item.gip_reference || "",
        edition_of_gip: item.edition_of_gip || "",
        typical_component_ids: item.typical_component_ids || [],
        description: item.description || ""
      });
      if (ok) n4++;
    });
  }

  console.log("Ontology seed migration: inserted " +
    n1 + " components, " + n2 + " defect types, " +
    n3 + " checkpoints, " + n4 + " trades.");

}, (app) => {
  // Rollback: truncate the ontology tables. Don't drop — schema migration handles that.
  ["ontology_components", "ontology_defect_types", "ontology_checkpoints", "ontology_trades"].forEach((name) => {
    try {
      app.db().newQuery("DELETE FROM " + name).execute();
    } catch (_) { /* table already empty or gone */ }
  });
});
