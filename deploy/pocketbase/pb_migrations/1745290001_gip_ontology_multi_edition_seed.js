/// <reference path="../pb_data/types.d.ts" />

// SiteShrimp — Multi-edition ontology seed loader (Phase 3.5)
//
// The original seed migration (1745280001) hard-coded four files and skipped
// if any ontology_components row existed. That prevented adding new ontology
// editions (BCA Good Industry Practice per trade, HDB, LTA, Greenmark, etc.)
// after the initial CONQUAS seed.
//
// This migration scans the pb_hooks/ontology/ directory for all dataset JSONs
// matching these naming conventions:
//
//   gip-{trade}-components.json      → ontology_components
//   gip-{trade}-defect-types.json    → ontology_defect_types
//   gip-{trade}-checkpoints.json     → ontology_checkpoints
//   gip-{trade}-trades.json          → ontology_trades
//
// Each dataset declares its own edition in dataset.edition. Idempotency is
// per-edition: if rows with that edition already exist in the target
// collection, the dataset is skipped. This lets you add new GIP trade seeds
// incrementally and run the migration safely without disturbing existing data.
//
// Every row inserted carries needs_review=true by default (per dataset
// provenance). Validate against source GIP PDFs before using in live
// inspection flows.

migrate((app) => {
  // Candidate directories — mirrors the pattern from the CONQUAS seed migration.
  const DIR_CANDIDATES = [
    "pb_hooks/ontology",
    "./pb_hooks/ontology",
    "/opt/sitesnag/pb_hooks/ontology",
    "/opt/siteshrimp/pb_hooks/ontology"
  ];

  function findSeedDir() {
    for (let i = 0; i < DIR_CANDIDATES.length; i++) {
      try {
        const entries = $os.readDir(DIR_CANDIDATES[i]);
        if (entries && entries.length) return { dir: DIR_CANDIDATES[i], entries: entries };
      } catch (_) { /* try next */ }
    }
    return null;
  }

  function readJson(dir, name) {
    try {
      const bytes = $os.readFile(dir + "/" + name);
      if (!bytes || bytes.length === 0) return null;
      let text;
      if (typeof bytes === "string") text = bytes;
      else if (typeof $toString === "function") text = $toString(bytes);
      else text = String.fromCharCode.apply(null, bytes);
      return JSON.parse(text);
    } catch (err) {
      console.log("Multi-edition seed: failed to read " + name + " — " + err);
      return null;
    }
  }

  function editionHasRows(collectionName, edition) {
    try {
      const row = app.db().newQuery("SELECT id FROM " + collectionName + " WHERE edition = {:e} LIMIT 1").bind({ e: edition }).one();
      return !!row;
    } catch (_) {
      return false;
    }
  }

  function insertRow(collectionName, fields) {
    try {
      const coll = app.findCollectionByNameOrId(collectionName);
      const rec = new Record(coll);
      for (const k in fields) {
        if (Object.prototype.hasOwnProperty.call(fields, k)) rec.set(k, fields[k]);
      }
      app.save(rec);
      return true;
    } catch (err) {
      console.log("Multi-edition seed: insert into " + collectionName + " failed: " + err);
      return false;
    }
  }

  function seedComponents(data) {
    if (!data || !Array.isArray(data.items)) return 0;
    const ed = data.dataset && data.dataset.edition;
    if (!ed) { console.log("Multi-edition seed: components dataset missing edition"); return 0; }
    if (editionHasRows("ontology_components", ed)) {
      console.log("Multi-edition seed: ontology_components edition '" + ed + "' already present, skipping.");
      return 0;
    }
    let n = 0;
    data.items.forEach(function (item) {
      const ok = insertRow("ontology_components", {
        edition: ed,
        version: data.dataset.version || "0.1.0",
        itemId: item.id,
        name: item.name || "",
        category: item.category || "",
        assessment_weight_pct: item.assessment_weight_pct || null,
        parent_id: item.parent_id || "",
        phase: item.phase || null,
        verbatim_source: item.verbatim_source || "",
        gip_references: item.gip_references || [],
        note: item.note || item.typical_location || "",
        provenance_override: item.provenance_override || null,
        needs_review: item.needs_review !== false
      });
      if (ok) n++;
    });
    return n;
  }

  function seedDefectTypes(data) {
    if (!data || !Array.isArray(data.items)) return 0;
    const ed = data.dataset && data.dataset.edition;
    if (!ed) return 0;
    if (editionHasRows("ontology_defect_types", ed)) {
      console.log("Multi-edition seed: ontology_defect_types edition '" + ed + "' already present, skipping.");
      return 0;
    }
    let n = 0;
    data.items.forEach(function (item) {
      const ok = insertRow("ontology_defect_types", {
        edition: ed,
        version: data.dataset.version || "0.1.0",
        itemId: item.id,
        element: item.element || "",
        typical_component_ids: item.typical_component_ids || [],
        tier: item.tier || "",
        name: item.name || "",
        measurement_threshold: item.measurement_threshold || "",
        verbatim_source_row: item.verbatim_source_row || "",
        needs_review: item.needs_review !== false
      });
      if (ok) n++;
    });
    return n;
  }

  function seedCheckpoints(data) {
    if (!data || !Array.isArray(data.items)) return 0;
    const ed = data.dataset && data.dataset.edition;
    if (!ed) return 0;
    if (editionHasRows("ontology_checkpoints", ed)) {
      console.log("Multi-edition seed: ontology_checkpoints edition '" + ed + "' already present, skipping.");
      return 0;
    }
    let n = 0;
    data.items.forEach(function (item) {
      const ok = insertRow("ontology_checkpoints", {
        edition: ed,
        version: data.dataset.version || "0.1.0",
        itemId: item.id,
        component_id: item.component_id || "",
        tier: item.tier || "",
        description: item.description || "",
        pass_criteria: item.pass_criteria || "",
        related_defect_type_ids: item.related_defect_type_ids || []
      });
      if (ok) n++;
    });
    return n;
  }

  function seedTrades(data) {
    if (!data || !Array.isArray(data.items)) return 0;
    const ed = data.dataset && data.dataset.edition;
    if (!ed) return 0;
    if (editionHasRows("ontology_trades", ed)) {
      console.log("Multi-edition seed: ontology_trades edition '" + ed + "' already present, skipping.");
      return 0;
    }
    let n = 0;
    data.items.forEach(function (item) {
      const ok = insertRow("ontology_trades", {
        edition: ed,
        version: data.dataset.version || "0.1.0",
        itemId: item.id,
        name: item.name || "",
        gip_reference: item.gip_reference || "",
        edition_of_gip: item.edition_of_gip || "",
        typical_component_ids: item.typical_component_ids || [],
        description: item.description || ""
      });
      if (ok) n++;
    });
    return n;
  }

  const found = findSeedDir();
  if (!found) {
    console.log("Multi-edition seed: ontology/ directory not found, skipping.");
    return;
  }
  const dir = found.dir;
  const entries = found.entries;

  // Group entries by trade id (or any non-CONQUAS prefix). "gip-painting-components.json" → trade "painting".
  // Pattern: {prefix}-{kind}.json  where prefix is like "gip-painting" and kind is "components"|"defect-types"|"checkpoints"|"trades".
  const datasets = {}; // prefix → { components, defectTypes, checkpoints, trades }
  entries.forEach(function (name) {
    // Skip legacy CONQUAS files (handled by 1745280001). Only discover new prefixed datasets.
    if (name === "components.json" || name === "defect_types.json" || name === "checkpoints.json" || name === "trades.json") return;
    if (!name.endsWith(".json")) return;
    const base = name.slice(0, -5); // strip .json
    let kind, prefix;
    if (base.endsWith("-components"))         { kind = "components";   prefix = base.slice(0, -11); }
    else if (base.endsWith("-defect-types"))  { kind = "defectTypes";  prefix = base.slice(0, -13); }
    else if (base.endsWith("-checkpoints"))   { kind = "checkpoints";  prefix = base.slice(0, -12); }
    else if (base.endsWith("-trades"))        { kind = "trades";       prefix = base.slice(0, -7); }
    else return;
    if (!datasets[prefix]) datasets[prefix] = {};
    datasets[prefix][kind] = readJson(dir, name);
  });

  let totals = { components: 0, defectTypes: 0, checkpoints: 0, trades: 0, prefixes: 0 };
  const keys = Object.keys(datasets).sort();
  keys.forEach(function (prefix) {
    const d = datasets[prefix];
    const nC = seedComponents(d.components);
    const nD = seedDefectTypes(d.defectTypes);
    const nCh = seedCheckpoints(d.checkpoints);
    const nT = seedTrades(d.trades);
    totals.components += nC; totals.defectTypes += nD; totals.checkpoints += nCh; totals.trades += nT;
    if (nC + nD + nCh + nT > 0) totals.prefixes++;
    console.log("Multi-edition seed: " + prefix + " → " + nC + " components, " + nD + " defect types, " + nCh + " checkpoints, " + nT + " trades.");
  });

  console.log("Multi-edition seed: inserted across " + totals.prefixes + " new edition(s): " +
    totals.components + " components, " + totals.defectTypes + " defect types, " +
    totals.checkpoints + " checkpoints, " + totals.trades + " trades.");

}, (app) => {
  // Rollback: don't auto-delete — user may have edited seeded rows. Leave rows intact.
});
