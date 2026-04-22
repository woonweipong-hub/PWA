/// <reference path="../pb_data/types.d.ts" />

// SiteShrimp — CONQUAS observations collection (Phase 3.8B)
//
// Records every checkpoint evaluation the wizard produces — passes, fails,
// uncertains — with photo evidence. Until this phase only failed
// checkpoints were persisted (as defect rows). Passes were discarded, so
// the REPORT card had to rely on the *theoretical* weighted denominator
// stamped at save time (batch_weighted_applicable) rather than the
// actual walked count. Photos on passes were also lost.
//
// This collection captures the full audit trail so REPORT can show:
//   - Every checkpoint the inspector actually walked
//   - Pass/fail/uncertain verdict per checkpoint
//   - Photo evidence (main + extras, multi-photo support — Phase 3.8C)
//   - Link to the defect row for fail verdicts (1:1)
//
// Each observation row has observation_batch_id matching the defects'
// field from Phase 3.4, so REPORT can group by batch and show "Wall — 20
// walked, 18 passed, 2 failed" per AI photo run or manual walk session.
//
// Idempotent — skips creation if the collection already exists.

migrate((app) => {
  var exists = null;
  try { exists = app.findCollectionByNameOrId("conquas_observations"); } catch (_) {}
  if (exists) return;

  var coll = new Collection({
    name: "conquas_observations",
    type: "base",
    fields: [
      { name: "companyId", type: "text", required: true },
      { name: "projectId", type: "text", required: true },
      // Shared UUID across one wizard run. Same value appears on the
      // defects created in that run (Phase 3.4), so joins work both ways.
      { name: "observation_batch_id", type: "text", required: true },
      { name: "component_id", type: "text" },
      { name: "component_name", type: "text" },
      { name: "checkpoint_id", type: "text", required: true },
      { name: "checkpoint_description", type: "text", max: 2000 },
      { name: "nc_tier", type: "text" },
      // "pass" | "fail" | "uncertain"
      { name: "verdict", type: "text", required: true },
      { name: "note", type: "text", max: 5000 },
      // Main evidence photo (compressed data URL or file URL). Optional
      // for pass, typical for fail, typical for uncertain when AI asked
      // for input. Stored as text so the UI can accept both data URLs
      // (local) and uploaded file references.
      { name: "photo", type: "text", max: 2000000 },
      // Phase 3.8C — multi-photo per checkpoint. JSON array of data URLs
      // or file refs matching the LogDefect extraPhotos pattern.
      { name: "extra_photos", type: "json" },
      // Back-reference when verdict = fail → the defect row created by
      // the existing saveAll flow. Lets REPORT jump from an observation
      // to the corresponding defect (and vice-versa).
      { name: "defect_id", type: "text" },
      { name: "logged_by", type: "text" },
      { name: "logged_by_role", type: "text" },
      { name: "source", type: "text" }, // "manual" | "ai" | "ask-ai"
      { name: "createdAt", type: "autodate", onCreate: true }
    ],
    // Same tenancy pattern as defects: company members read, only the
    // authoring member creates (server-side logged_by is trusted via hook
    // if one exists; for now the rule allows any authenticated user).
    listRule: "@request.auth.id != ''",
    viewRule: "@request.auth.id != ''",
    createRule: "@request.auth.id != ''",
    updateRule: "@request.auth.id != ''",
    deleteRule: "@request.auth.id != ''",
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_obs_batch ON conquas_observations (observation_batch_id)",
      "CREATE INDEX IF NOT EXISTS idx_obs_project ON conquas_observations (projectId, companyId)"
    ]
  });
  app.save(coll);
}, (app) => {
  try {
    var c = app.findCollectionByNameOrId("conquas_observations");
    if (c) app.delete(c);
  } catch (_) { /* already gone */ }
});
