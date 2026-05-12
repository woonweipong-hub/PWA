/// <reference path="../pb_data/types.d.ts" />

// SiteShrimp — brochure-kind drawings (CONQUAS Officer Phase 3)
//
// Adds two fields to the drawings collection so a record can carry both
// "this is a brochure / floor plan" intent and the AI-extracted layout
// metadata that powers downstream features (drawing-context display,
// future pin-suggestion).
//
// drawings (2 new):
//   kind            text   "drawing" (default / implicit when empty) or
//                          "brochure". Drawings stay rendered as today;
//                          brochures get an extra badge + an editable
//                          location-context card in the drawing tile.
//   brochureMeta    json   AI extraction result: { block, level, rooms[],
//                          grid_refs[], notes, extracted_at }. Always JSON
//                          string-safe; nullable for non-brochure records
//                          and for brochures where AI extraction failed /
//                          was edited manually.
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
  addNullableFields("drawings", [
    { name: "kind", type: "text" },
    { name: "brochureMeta", type: "json" }
  ]);
}, (app) => {
  // Rollback: preserve columns so any uploaded brochure metadata is not
  // lost on migration roll-back.
});
