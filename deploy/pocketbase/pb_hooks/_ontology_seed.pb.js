/// <reference path="../pb_data/types.d.ts" />

// SiteShrimp — CONQUAS Ontology Seed Loader (Phase 2)
//
// Populates the four ontology_* collections from JSON seed files shipped in
// pb_hooks/ontology/ when the collections are empty.
//
// PB JSVM quirks handled:
//   1. Hook callbacks run in isolated VM pools — helpers MUST be defined
//      inside the callback body (no top-level function declarations).
//   2. DURING onBootstrap, the global `$app` is NOT safe — calling
//      `$app.findCollectionByNameOrId(...)` SIGSEGVs PB. Use `e.app`
//      (the event-scoped app handle) for every DB operation.
//   3. `$app.db().newQuery(sql).one()` throws `sql: no rows` on empty
//      result — always wrap in try/catch or use `.all()` + length check.
//
// Safety:
//   - Idempotent: exits early if ontology_components already has rows.
//   - All work inside try/catch; a seed failure logs and continues.
//   - Schema creation lives in pb_migrations/1745280000_conquas_ontology.js
//     (separate concern from data seeding).

onBootstrap((e) => {
  // CRITICAL: call e.next() FIRST so PB finishes bootstrap BEFORE we query.
  // Doing DB work before e.next() hits a partially-initialised app and
  // SIGSEGVs inside `core.(*BaseApp).modelQuery` (nil model lookup).
  e.next();

  try {
    const ONTOLOGY_EDITION = "bca-conquas-pr-2025";
    const HOOKS_DIR = (typeof __hooks === "string" && __hooks) ? __hooks : "pb_hooks";
    const app = e.app;

    // Confirm the collection exists before querying. If migration hasn't
    // run yet (or failed), bail cleanly without touching anything.
    try {
      app.findCollectionByNameOrId("ontology_components");
    } catch (_) {
      console.log("Ontology seed: ontology_components missing (migration not applied?), skipping.");
      return;
    }

    // Idempotency: SELECT with LIMIT 1 via .one() — catches "no rows" cleanly.
    let alreadySeeded = false;
    try {
      const row = app.db().newQuery("SELECT id FROM ontology_components LIMIT 1").one();
      alreadySeeded = !!row;
    } catch (_) {
      // "sql: no rows in result set" → empty table → proceed with seed.
      alreadySeeded = false;
    }
    if (alreadySeeded) {
      console.log("Ontology seed: ontology_components already populated, skipping.");
      return;
    }

    function readSeed(name) {
      const candidates = [
        HOOKS_DIR + "/ontology/" + name,
        "pb_hooks/ontology/" + name,
        "./pb_hooks/ontology/" + name,
        "/opt/sitesnag/pb_hooks/ontology/" + name,
      ];
      for (let i = 0; i < candidates.length; i++) {
        let bytes;
        try {
          bytes = $os.readFile(candidates[i]);
        } catch (readErr) {
          continue;
        }
        if (!bytes || bytes.length === 0) continue;
        try {
          // Some PB versions return []byte which needs explicit string conversion.
          let text;
          if (typeof bytes === "string") text = bytes;
          else if (typeof $toString === "function") text = $toString(bytes);
          else text = String.fromCharCode.apply(null, bytes);
          return JSON.parse(text);
        } catch (parseErr) {
          console.log("Ontology seed: parse error for " + candidates[i] + ": " + parseErr);
        }
      }
      console.log("Ontology seed: could not read " + name + " from any candidate path.");
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
        console.log("Ontology seed: insert into " + collectionName + " failed: " + err);
        return false;
      }
    }

    const componentsData = readSeed("components.json");
    const defectTypesData = readSeed("defect_types.json");
    const checkpointsData = readSeed("checkpoints.json");
    const tradesData = readSeed("trades.json");

    if (!componentsData && !defectTypesData && !checkpointsData && !tradesData) {
      console.log("Ontology seed: no seed files found in pb_hooks/ontology/, skipping.");
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
          needs_review: !!item.needs_review,
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
          needs_review: !!item.needs_review,
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
          related_defect_type_ids: item.related_defect_type_ids || [],
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
          description: item.description || "",
        });
        if (ok) n4++;
      });
    }

    // Dataset metadata → settings collection.
    try {
      const settingsColl = app.findCollectionByNameOrId("settings");
      const key = "ontology_edition:" + ONTOLOGY_EDITION;
      let existing = null;
      try {
        const matches = app.findRecordsByFilter(
          "settings",
          "key = {:k} && companyId = '_system'",
          "", 1, 0,
          { k: key }
        );
        if (matches && matches.length > 0) existing = matches[0];
      } catch (_) {}
      const metaRec = existing || new Record(settingsColl);
      metaRec.set("companyId", "_system");
      metaRec.set("key", key);
      metaRec.set("value", {
        edition: ONTOLOGY_EDITION,
        seeded_at: new Date().toISOString(),
        components_dataset: componentsData ? componentsData.dataset : null,
        defect_types_dataset: defectTypesData ? defectTypesData.dataset : null,
        checkpoints_dataset: checkpointsData ? checkpointsData.dataset : null,
        trades_dataset: tradesData ? tradesData.dataset : null,
      });
      app.save(metaRec);
    } catch (err) {
      console.log("Ontology seed: dataset metadata save failed: " + err);
    }

    console.log(
      "Ontology seed: inserted " +
      n1 + " components, " + n2 + " defect types, " +
      n3 + " checkpoints, " + n4 + " trades (edition=" + ONTOLOGY_EDITION + ")."
    );
  } catch (err) {
    console.log("Ontology seed: runtime error (ignored): " + err);
  }
});
