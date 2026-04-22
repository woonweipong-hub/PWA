/// <reference path="../pb_data/types.d.ts" />

// SiteShrimp — CONQUAS observation-batch schema migration (Phase 3.4)
//
// Adds three nullable columns to the defects collection so that the LOG
// wizard (AI-assisted or manual) can group all fails from one photo/run
// into a single "observation batch" and so the REPORT tab can compute
// the BCA-weighted IF NC rate per R1 §3.3:
//
//   IF NC rate = (Total weighted X) / (Total weighted applicable NCs) * 100%
//
//   where 1X/2X/3X are the weight multipliers ("NC weightages" per R1 §3.2(a),
//   confirmed by the banding table column header "Project weighted NC rate").
//
// New fields on defects:
//   observation_batch_id       text    UUID shared by all fails from one
//                                      wizard run. Lets the drawing viewer
//                                      cluster pins (one pin per batch) and
//                                      lets REPORT group by run.
//
//   batch_total_checks         number  Count of checkpoints attempted in this
//                                      batch (informational denominator: "7
//                                      checkpoints assessed" in UI).
//
//   batch_weighted_applicable  number  Sum of tier-weights of checkpoints
//                                      attempted. Drives the BCA weighted
//                                      NC-rate denominator when aggregated
//                                      across distinct batch IDs.
//
// All fields are nullable so existing defects remain valid. Idempotent —
// re-running the migration skips fields that already exist. Rollback is a
// no-op: columns are preserved to protect any data logged under CONQUAS
// between apply and rollback (same pattern as Phase 2.1).

migrate((app) => {
  var defects = app.findCollectionByNameOrId("defects");
  var fieldsToAdd = [
    { name: "observation_batch_id", type: "text" },
    { name: "batch_total_checks", type: "number" },
    { name: "batch_weighted_applicable", type: "number" }
  ];
  fieldsToAdd.forEach(function (spec) {
    var has = defects.fields.find(function (x) { return x.name === spec.name; });
    if (!has) defects.fields.add(new Field(spec));
  });
  app.save(defects);
}, (app) => {
  // Rollback: preserve columns. Dropping them would lose any CONQUAS
  // batching / weighted-rate data logged between migrate and rollback.
  // Null columns on unused fields are safe.
});
