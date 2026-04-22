/// <reference path="../pb_data/types.d.ts" />

// SiteShrimp — ISO 19650 metadata + evidence-integrity fields (Phase 3.9)
//
// Adds the fields needed to auto-generate ISO 19650-style filenames on
// export and to give every media record a tamper-detection anchor. All
// nullable; existing rows stay valid.
//
// defects (5 new):
//   media_hash       text    SHA-256 of the captured photo, set once at
//                            capture time. Evidence integrity + duplicate
//                            detection. Do NOT change after create.
//   source_type      text    How the record was created:
//                            photo | voice | markup | ai_suggested |
//                            batch_import | telegram | conquas_wizard
//   work_stage       text    Construction phase:
//                            pre_pour | rebar | formwork | pre_cover_up |
//                            installation | testing | commissioning |
//                            handover | dlp | post_occupancy
//   timezone         text    IANA zone (e.g. Asia/Singapore) at capture
//   iso_filename     text    Cached ISO 19650 filename derived at export.
//                            Lets the audit trail record show the name the
//                            user saw when they downloaded / emailed it.
//
// projects (1 new):
//   code             text    Short project code for ISO filenames (e.g.
//                            "PROJA"). Backfills from name if left empty
//                            (client-side derive on demand).
//
// companies (1 new):
//   code             text    Originator code for ISO filenames (e.g.
//                            "CCA"). Same backfill pattern.
//
// Idempotent — re-running is safe.

migrate((app) => {
  function addNullableFields(collName, specs) {
    const coll = app.findCollectionByNameOrId(collName);
    specs.forEach(function (spec) {
      const has = coll.fields.find(function (x) { return x.name === spec.name; });
      if (!has) coll.fields.add(new Field(spec));
    });
    app.save(coll);
  }
  addNullableFields("defects", [
    { name: "media_hash", type: "text" },
    { name: "source_type", type: "text" },
    { name: "work_stage", type: "text" },
    { name: "timezone", type: "text" },
    { name: "iso_filename", type: "text" }
  ]);
  addNullableFields("projects", [
    { name: "code", type: "text" }
  ]);
  addNullableFields("companies", [
    { name: "code", type: "text" }
  ]);
  // Also add media_hash + source_type + work_stage to conquas_observations so
  // observation records carry the same integrity + classification info.
  try {
    const obs = app.findCollectionByNameOrId("conquas_observations");
    [
      { name: "media_hash", type: "text" },
      { name: "work_stage", type: "text" },
      { name: "timezone", type: "text" }
    ].forEach(function (spec) {
      const has = obs.fields.find(function (x) { return x.name === spec.name; });
      if (!has) obs.fields.add(new Field(spec));
    });
    app.save(obs);
  } catch (_) { /* conquas_observations may not exist on older PB instances */ }
}, (app) => {
  // Rollback: preserve columns so evidence trails aren't lost.
});
