/// <reference path="../pb_data/types.d.ts" />

// SiteShrimp — CONQUAS Ontology Seed Loader (Phase 2)
//
// Populates the four ontology_* collections from JSON seed files shipped in
// pb_hooks/ontology/ when the collections are empty. Also stores dataset
// metadata in the `settings` collection (keyed by ontology_edition:<id>).
//
// Safety contract:
//   - All work wrapped in defensive try/catch. A seed failure MUST NOT crash
//     PocketBase or block the other hooks in this directory from loading.
//   - Idempotent: exits early if ontology_components already has any row.
//   - Schema (collections + columns) is NOT created by this hook. The
//     operator must import pb_schema.json via PB Admin before restart.

var ONTOLOGY_EDITION = "bca-conquas-pr-2025";
var ONTOLOGY_HOOKS_SUBDIR = "ontology";

function seedResolveSeedPath(name) {
  var candidates = [];
  if (typeof __hooks === "string" && __hooks) {
    candidates.push(__hooks + "/" + ONTOLOGY_HOOKS_SUBDIR + "/" + name);
  }
  candidates.push("pb_hooks/" + ONTOLOGY_HOOKS_SUBDIR + "/" + name);
  candidates.push("./pb_hooks/" + ONTOLOGY_HOOKS_SUBDIR + "/" + name);
  return candidates;
}

function seedReadFile(name) {
  var paths = seedResolveSeedPath(name);
  for (var i = 0; i < paths.length; i++) {
    try {
      var bytes = $os.readFile(paths[i]);
      if (bytes) return JSON.parse($toString(bytes));
    } catch (_) { /* try next candidate */ }
  }
  console.log("Ontology seed: could not read " + name + " from any candidate path.");
  return null;
}

function seedCollectionIsEmpty(collectionName) {
  try {
    var rec = $app.findFirstRecordByFilter(collectionName, "");
    return !rec;
  } catch (_) {
    return true;
  }
}

function seedInsertRow(collectionName, fields) {
  try {
    var coll = $app.findCollectionByNameOrId(collectionName);
    var rec = new Record(coll);
    for (var k in fields) {
      if (Object.prototype.hasOwnProperty.call(fields, k)) {
        rec.set(k, fields[k]);
      }
    }
    $app.save(rec);
    return true;
  } catch (err) {
    console.log("Ontology seed: insert into " + collectionName + " failed:", err);
    return false;
  }
}

function seedComponents(data) {
  if (!data || !Array.isArray(data.items)) return 0;
  var count = 0;
  data.items.forEach(function (item) {
    var ok = seedInsertRow("ontology_components", {
      edition: data.dataset.edition,
      version: data.dataset.version,
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
    if (ok) count++;
  });
  return count;
}

function seedDefectTypes(data) {
  if (!data || !Array.isArray(data.items)) return 0;
  var count = 0;
  data.items.forEach(function (item) {
    var ok = seedInsertRow("ontology_defect_types", {
      edition: data.dataset.edition,
      version: data.dataset.version,
      itemId: item.id,
      element: item.element || "",
      typical_component_ids: item.typical_component_ids || [],
      tier: item.tier || "",
      name: item.name || "",
      measurement_threshold: item.measurement_threshold || "",
      verbatim_source_row: item.verbatim_source_row || "",
      needs_review: !!item.needs_review
    });
    if (ok) count++;
  });
  return count;
}

function seedCheckpoints(data) {
  if (!data || !Array.isArray(data.items)) return 0;
  var count = 0;
  data.items.forEach(function (item) {
    var ok = seedInsertRow("ontology_checkpoints", {
      edition: data.dataset.edition,
      version: data.dataset.version,
      itemId: item.id,
      component_id: item.component_id || "",
      tier: item.tier || "",
      description: item.description || "",
      pass_criteria: item.pass_criteria || "",
      related_defect_type_ids: item.related_defect_type_ids || []
    });
    if (ok) count++;
  });
  return count;
}

function seedTrades(data) {
  if (!data || !Array.isArray(data.items)) return 0;
  var count = 0;
  data.items.forEach(function (item) {
    var ok = seedInsertRow("ontology_trades", {
      edition: data.dataset.edition,
      version: data.dataset.version,
      itemId: item.id,
      name: item.name || "",
      gip_reference: item.gip_reference || "",
      edition_of_gip: item.edition_of_gip || "",
      typical_component_ids: item.typical_component_ids || [],
      description: item.description || ""
    });
    if (ok) count++;
  });
  return count;
}

function seedDatasetMetadata(datasets) {
  try {
    var coll = $app.findCollectionByNameOrId("settings");
    var key = "ontology_edition:" + ONTOLOGY_EDITION;
    var existing = null;
    try {
      existing = $app.findFirstRecordByFilter(
        "settings",
        "companyId = '_system' && key = {:key}",
        { key: key }
      );
    } catch (_) {}
    var rec = existing || new Record(coll);
    rec.set("companyId", "_system");
    rec.set("key", key);
    rec.set("value", {
      edition: ONTOLOGY_EDITION,
      seeded_at: new Date().toISOString(),
      components_dataset: datasets.components ? datasets.components.dataset : null,
      defect_types_dataset: datasets.defect_types ? datasets.defect_types.dataset : null,
      checkpoints_dataset: datasets.checkpoints ? datasets.checkpoints.dataset : null,
      trades_dataset: datasets.trades ? datasets.trades.dataset : null
    });
    $app.save(rec);
  } catch (err) {
    console.log("Ontology seed: dataset metadata save failed:", err);
  }
}

function runOntologySeedOnce() {
  if (!seedCollectionIsEmpty("ontology_components")) {
    console.log("Ontology seed: ontology_components already populated, skipping.");
    return;
  }

  var componentsData = seedReadFile("components.json");
  var defectTypesData = seedReadFile("defect_types.json");
  var checkpointsData = seedReadFile("checkpoints.json");
  var tradesData = seedReadFile("trades.json");

  if (!componentsData && !defectTypesData && !checkpointsData && !tradesData) {
    console.log("Ontology seed: no seed files found in pb_hooks/ontology/, skipping.");
    return;
  }

  var n1 = seedComponents(componentsData);
  var n2 = seedDefectTypes(defectTypesData);
  var n3 = seedCheckpoints(checkpointsData);
  var n4 = seedTrades(tradesData);

  seedDatasetMetadata({
    components: componentsData,
    defect_types: defectTypesData,
    checkpoints: checkpointsData,
    trades: tradesData
  });

  console.log("Ontology seed: inserted " +
    n1 + " components, " + n2 + " defect types, " +
    n3 + " checkpoints, " + n4 + " trades (edition=" + ONTOLOGY_EDITION + ").");
}

(function registerOntologySeed() {
  try {
    if (typeof onBootstrap === "function") {
      onBootstrap(function (e) {
        try {
          runOntologySeedOnce();
        } catch (err) {
          console.log("Ontology seed: runtime error (ignored):", err);
        }
        return e.next();
      });
      return;
    }
    console.log("Ontology seed: onBootstrap not available in this PocketBase version.");
  } catch (regErr) {
    console.log("Ontology seed: registration failed (ignored):", regErr);
  }
})();
