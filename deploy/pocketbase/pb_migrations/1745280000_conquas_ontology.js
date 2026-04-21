/// <reference path="../pb_data/types.d.ts" />

// SiteShrimp — CONQUAS ontology schema migration (Phase 2)
//
// Creates the four ontology_* collections and adds five nullable columns
// (defects: component_id, defect_type_id, checkpoint_id, nc_tier;
//  projects: ontology_edition) so that existing rows remain valid.
//
// Designed to be idempotent — re-running is safe. Uses try/findCollectionByNameOrId/
// catch to check existence before create, and findFieldByName before adding fields.
//
// Matches pb_schema.json (the declarative reference) — keep in sync if either
// changes. The _ontology_seed.pb.js hook runs after this migration on the
// same bootstrap, populating the collections with data from
// pb_hooks/ontology/*.json if they are empty.

migrate((app) => {
  // ── 4 new ontology_* collections ────────────────────────────────
  var collectionsToCreate = [
    {
      name: "ontology_components",
      fields: [
        { name: "edition", type: "text", required: true },
        { name: "version", type: "text", required: true },
        { name: "itemId", type: "text", required: true },
        { name: "name", type: "text", required: true },
        { name: "category", type: "text" },
        { name: "assessment_weight_pct", type: "number" },
        { name: "parent_id", type: "text" },
        { name: "phase", type: "number" },
        { name: "verbatim_source", type: "text" },
        { name: "gip_references", type: "json" },
        { name: "note", type: "text" },
        { name: "provenance_override", type: "json" },
        { name: "needs_review", type: "bool" }
      ]
    },
    {
      name: "ontology_defect_types",
      fields: [
        { name: "edition", type: "text", required: true },
        { name: "version", type: "text", required: true },
        { name: "itemId", type: "text", required: true },
        { name: "element", type: "text" },
        { name: "typical_component_ids", type: "json" },
        { name: "tier", type: "text" },
        { name: "name", type: "text", required: true },
        { name: "measurement_threshold", type: "text" },
        { name: "verbatim_source_row", type: "text" },
        { name: "needs_review", type: "bool" }
      ]
    },
    {
      name: "ontology_checkpoints",
      fields: [
        { name: "edition", type: "text", required: true },
        { name: "version", type: "text", required: true },
        { name: "itemId", type: "text", required: true },
        { name: "component_id", type: "text" },
        { name: "tier", type: "text" },
        { name: "description", type: "text", required: true },
        { name: "pass_criteria", type: "text", max: 2000 },
        { name: "related_defect_type_ids", type: "json" }
      ]
    },
    {
      name: "ontology_trades",
      fields: [
        { name: "edition", type: "text", required: true },
        { name: "version", type: "text", required: true },
        { name: "itemId", type: "text", required: true },
        { name: "name", type: "text", required: true },
        { name: "gip_reference", type: "text" },
        { name: "edition_of_gip", type: "text" },
        { name: "typical_component_ids", type: "json" },
        { name: "description", type: "text", max: 2000 }
      ]
    }
  ];

  collectionsToCreate.forEach(function (spec) {
    var exists = null;
    try { exists = app.findCollectionByNameOrId(spec.name); } catch (_) {}
    if (exists) {
      // Already created in a previous run — leave as-is.
      return;
    }
    var coll = new Collection({
      name: spec.name,
      type: "base",
      fields: spec.fields,
      // Reference data: authenticated users may read; only admins may mutate.
      listRule: "@request.auth.id != ''",
      viewRule: "@request.auth.id != ''",
      createRule: null,
      updateRule: null,
      deleteRule: null
    });
    app.save(coll);
  });

  // ── defects: 4 nullable FK columns ─────────────────────────────
  var defects = app.findCollectionByNameOrId("defects");
  ["component_id", "defect_type_id", "checkpoint_id", "nc_tier"].forEach(function (f) {
    var has = defects.fields.find(function (x) { return x.name === f; });
    if (!has) defects.fields.add(new Field({ name: f, type: "text" }));
  });
  app.save(defects);

  // ── projects: 1 nullable column (per-project ontology edition pin) ─
  var projects = app.findCollectionByNameOrId("projects");
  var hasEdition = projects.fields.find(function (x) { return x.name === "ontology_edition"; });
  if (!hasEdition) projects.fields.add(new Field({ name: "ontology_edition", type: "text" }));
  app.save(projects);

}, (app) => {
  // ── Rollback ───────────────────────────────────────────────────
  // Drop the 4 ontology_* collections. Leave the nullable columns on
  // defects/projects intact — dropping them loses any data the user
  // may have logged under CONQUAS between migrate and rollback.
  ["ontology_components", "ontology_defect_types", "ontology_checkpoints", "ontology_trades"].forEach(function (name) {
    try {
      var c = app.findCollectionByNameOrId(name);
      if (c) app.delete(c);
    } catch (_) { /* already gone */ }
  });
});
