/// <reference path="../pb_data/types.d.ts" />

// SiteShrimp — Ontology text encoding cleanup (Phase 3.7.x)
//
// The original CONQUAS seed migration (1745280001) decoded the JSON file
// bytes via String.fromCharCode.apply(null, bytes) as a fallback path,
// which interprets each byte as Latin-1. UTF-8 multibyte sequences (em
// dash —, en dash –, smart quotes ' " etc.) got split into their component
// bytes and stored as mojibake — most visibly the em dash "—" appearing as
// "â€" or similar in pass_criteria and description fields.
//
// This migration walks every row in the ontology_* tables and replaces the
// common mojibake patterns with their correct UTF-8 characters. Pure text
// patch — no structural changes, no data loss. Safe to re-run: patterns
// only match the corrupted form, so clean rows are left alone.
//
// Applies to: ontology_checkpoints.description, ontology_checkpoints.pass_criteria,
// ontology_defect_types.name, ontology_defect_types.measurement_threshold,
// ontology_components.name, ontology_components.note, ontology_components.category.

migrate((app) => {
  // Mojibake → real char. Order matters: longer patterns first so "â€"/"â€"
  // (em / en dash triple-byte) are matched before the 1-byte "Â" fallbacks.
  // Common UTF-8-as-Latin-1 artefacts encountered in BCA/HDB/CONQUAS text.
  const PATTERNS = [
    // 3-byte UTF-8 → Latin-1 → UTF-8 chains: "E2 80 XX" readings
    [/â€”/g, "—"],   // em dash —
    [/â€“/g, "–"],   // en dash –
    [/â€™/g, "’"],   // right single quote '
    [/â€˜/g, "‘"],   // left single quote '
    [/â€œ/g, "“"],   // left double quote "
    [/â€/g, "”"], // right double quote " (literal 0x9D)
    [/â€¦/g, "…"],   // ellipsis …
    [/â€¢/g, "•"],   // bullet •
    [/â€ /g, "†"],   // dagger †
    // Some environments strip the 0x80-0x9F control glyphs, leaving "â"" etc.
    [/â"/g, "—"],    // em-dash variant when the 0x80 was dropped
    [/â'/g, "’"],
    // 2-byte UTF-8 → Latin-1 → UTF-8 chains: "C3 XX" readings — accented chars
    [/Ã©/g, "é"], [/Ã¨/g, "è"], [/Ãª/g, "ê"], [/Ã«/g, "ë"],
    [/Ã /g, "à"], [/Ã¡/g, "á"], [/Ã¢/g, "â"], [/Ã£/g, "ã"], [/Ã¤/g, "ä"],
    [/Ã¬/g, "ì"], [/Ã­/g, "í"], [/Ã®/g, "î"], [/Ã¯/g, "ï"],
    [/Ã²/g, "ò"], [/Ã³/g, "ó"], [/Ã´/g, "ô"], [/Ã¶/g, "ö"],
    [/Ã¹/g, "ù"], [/Ãº/g, "ú"], [/Ã»/g, "û"], [/Ã¼/g, "ü"],
    [/Ã±/g, "ñ"], [/Ã§/g, "ç"],
    // Non-breaking space shows as "Â " in pre-cleaned text
    [/Â /g, " "]
  ];

  function demojibake(s) {
    if (!s || typeof s !== "string") return s;
    let out = s;
    for (let i = 0; i < PATTERNS.length; i++) {
      out = out.replace(PATTERNS[i][0], PATTERNS[i][1]);
    }
    return out;
  }

  function cleanRows(collectionName, fields) {
    let coll;
    try { coll = app.findCollectionByNameOrId(collectionName); }
    catch (_) {
      console.log("encoding cleanup: " + collectionName + " not found, skipping.");
      return 0;
    }
    let changed = 0;
    try {
      const rows = app.findAllRecords(coll);
      for (let i = 0; i < rows.length; i++) {
        const rec = rows[i];
        let dirty = false;
        for (let j = 0; j < fields.length; j++) {
          const f = fields[j];
          const cur = rec.getString(f);
          if (!cur) continue;
          const next = demojibake(cur);
          if (next !== cur) { rec.set(f, next); dirty = true; }
        }
        if (dirty) { app.save(rec); changed++; }
      }
    } catch (err) {
      console.log("encoding cleanup: " + collectionName + " walk failed: " + err);
    }
    return changed;
  }

  const c1 = cleanRows("ontology_checkpoints", ["description", "pass_criteria"]);
  const c2 = cleanRows("ontology_defect_types", ["name", "measurement_threshold"]);
  const c3 = cleanRows("ontology_components", ["name", "category", "note", "verbatim_source"]);

  console.log("Ontology encoding cleanup: normalised mojibake in " +
    c1 + " checkpoint(s), " + c2 + " defect-type(s), " + c3 + " component(s).");

}, (app) => {
  // No rollback — re-introducing mojibake would actively corrupt clean data.
});
