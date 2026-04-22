/// <reference path="../pb_data/types.d.ts" />

// SiteShrimp — CONQUAS Functional Tests schema migration (Phase 3.6)
//
// Adds ten nullable columns to the projects collection so the CONQUAS
// Functional Tests NC rate (R1 §3.3) can be computed and reported. FT data
// is project-level (one row per project), so fields live on projects rather
// than a new collection.
//
// Three counted-NC tests (contribute to FT NC rate numerator/denominator):
//   ft_wtt_applicable   number   total WTT (Window Water-Tightness) samples
//   ft_wtt_fails        number   WTT failures
//   ft_wpt_applicable   number   total WPT (Wet-area Water-Tightness) samples
//   ft_wpt_fails        number   WPT failures
//   ft_wft_applicable   number   total WFT (Water Flow Test — common areas)
//                                samples. New in CONQUAS R1 (20 Apr 2026).
//   ft_wft_fails        number   WFT failures
//
// Four QP-declared status flags (do NOT contribute to NC rate; feed the
// "Status of the following functional tests" column in banding):
//   ft_pull_off_status       text  pass / fail / pending / na
//   ft_heat_soak_status      text  pass / fail / pending / na
//   ft_wtt_self_test_status  text  pass / fail / pending / na
//   ft_wpt_self_test_status  text  pass / fail / pending / na
//
// R1 §3.3 formula (applied in REPORT tab):
//   FT NC rate = (Σ WTT fails + WPT fails + WFT fails) /
//                (Σ WTT applicable + WPT applicable + WFT applicable) × 100%
//
// All fields nullable; existing projects remain valid. Idempotent.

migrate((app) => {
  const projects = app.findCollectionByNameOrId("projects");
  const fieldsToAdd = [
    { name: "ft_wtt_applicable", type: "number" },
    { name: "ft_wtt_fails", type: "number" },
    { name: "ft_wpt_applicable", type: "number" },
    { name: "ft_wpt_fails", type: "number" },
    { name: "ft_wft_applicable", type: "number" },
    { name: "ft_wft_fails", type: "number" },
    { name: "ft_pull_off_status", type: "text" },
    { name: "ft_heat_soak_status", type: "text" },
    { name: "ft_wtt_self_test_status", type: "text" },
    { name: "ft_wpt_self_test_status", type: "text" }
  ];
  fieldsToAdd.forEach(function (spec) {
    const has = projects.fields.find(function (x) { return x.name === spec.name; });
    if (!has) projects.fields.add(new Field(spec));
  });
  app.save(projects);
}, (app) => {
  // Rollback: preserve fields — losing recorded FT counts would undermine
  // any CONQUAS assessment logged between migrate and rollback.
});
