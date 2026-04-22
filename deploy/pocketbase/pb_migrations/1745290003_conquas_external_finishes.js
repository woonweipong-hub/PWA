/// <reference path="../pb_data/types.d.ts" />

// SiteShrimp — CONQUAS External Finishes schema migration (Phase 3.7)
//
// Adds six nullable columns to the projects collection so the CONQUAS
// External Finishes NC rate (R1 §3.3 c) can be computed and reported.
//
//   ef_roof_applicable      number   total Roof assessment items
//   ef_roof_fails           number   Roof non-compliances
//   ef_wall_applicable      number   total External Wall assessment items
//   ef_wall_fails           number   External Wall non-compliances
//   ef_works_applicable     number   total External Works assessment items
//   ef_works_fails          number   External Works non-compliances
//
// R1 §3.3 formula (applied in REPORT tab):
//   EF NC rate = (Σ Roof fails + Wall fails + Works fails) /
//                (Σ Roof applicable + Wall applicable + Works applicable) × 100%
//
// Unlike Internal Finishes (tier-weighted per 1X/2X/3X), EF uses a direct
// count per R1 §3.3(c). Same pattern as Functional Tests (Phase 3.6).
//
// Full Project NC rate = IF × 0.4 + FT × 0.4 + EF × 0.2 (R1 §3.3).
// With all three captured, REPORT shows the full Project Band 1–6.
//
// All fields nullable. Idempotent.

migrate((app) => {
  const projects = app.findCollectionByNameOrId("projects");
  const fieldsToAdd = [
    { name: "ef_roof_applicable", type: "number" },
    { name: "ef_roof_fails", type: "number" },
    { name: "ef_wall_applicable", type: "number" },
    { name: "ef_wall_fails", type: "number" },
    { name: "ef_works_applicable", type: "number" },
    { name: "ef_works_fails", type: "number" }
  ];
  fieldsToAdd.forEach(function (spec) {
    const has = projects.fields.find(function (x) { return x.name === spec.name; });
    if (!has) projects.fields.add(new Field(spec));
  });
  app.save(projects);
}, (app) => {
  // Rollback: preserve fields.
});
