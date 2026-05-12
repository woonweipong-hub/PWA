/// <reference path="../pb_data/types.d.ts" />

// SiteShrimp — projectRef field on projects collection
//
// Adds a single text field `projectRef` to the projects collection. Stores
// an external project identifier (typically a 7-digit numeric reference)
// that an assessor uses to tag their project. Distinct from the existing
// `code` field, which is the short slug used for ISO 19650 filename
// generation.
//
// Validation lives client-side (the schema accepts any string so existing
// projects without a projectRef remain valid). Required only when the
// active workCategory is "CONQUAS Officer" — enforced in js/app.js.
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
  addNullableFields("projects", [
    { name: "projectRef", type: "text" }
  ]);
}, (app) => {
  // Rollback: preserve column so existing assessor data is not lost.
});
