/// <reference path="../pb_data/types.d.ts" />

// SiteSnag PocketBase Hooks
// Runs server-side inside PocketBase (JavaScript ES5)
//
// Features:
//   - Auto-generate defect IDs (DEF-0001, DEF-0002, ...)
//   - Gemini AI photo analysis on upload
//   - Auto-set timestamps

// ====== AUTO DEFECT ID ======

onRecordCreate((e) => {
  const record = e.record;

  // Generate next defect ID atomically
  if (!record.get("defect_id")) {
    let counter = 0;
    try {
      const counterRecord = $app.findFirstRecordByFilter("counters", "key = 'defect_counter'");
      counter = counterRecord.getInt("value") + 1;
      counterRecord.set("value", counter);
      $app.save(counterRecord);
    } catch {
      // Counter doesn't exist yet — create it
      counter = 1;
      const collection = $app.findCollectionByNameOrId("counters");
      const newCounter = new Record(collection);
      newCounter.set("key", "defect_counter");
      newCounter.set("value", 1);
      $app.save(newCounter);
    }
    const id = "DEF-" + String(counter).padStart(4, "0");
    record.set("defect_id", id);
  }

  // Auto-set timestamp if not provided
  if (!record.get("timestamp_utc")) {
    record.set("timestamp_utc", new Date().toISOString());
  }

  // Default status
  if (!record.get("status")) {
    record.set("status", "Outstanding");
  }

  // Default input source
  if (!record.get("input_source")) {
    record.set("input_source", "pwa");
  }

  return e.next();
}, "defects");

// ====== GEMINI AI ANALYSIS (on photo upload) ======

onRecordAfterCreateSuccess((e) => {
  const record = e.record;
  const photo = record.get("photo");
  const geminiKey = $os.getenv("GEMINI_API_KEY");

  // Only analyze if photo exists, Gemini key is set, and no category yet
  if (!photo || !geminiKey || record.get("category")) return;

  try {
    // Read photo file
    const fileKey = record.baseFilesPath() + "/" + photo;

    // Build Gemini request
    const prompt = [
      "You are a construction site defect inspector. Analyze this photo.",
      "Return ONLY a JSON object with: category, defect_type, severity, location, description, trade.",
      "Categories: Column, Beam, Slab, Door, Window, Wall, Floor, Ceiling, Roof,",
      "Plumbing, Electrical, Aircon, Painting, Tiling, Waterproofing, Cabinet, General.",
      "Severity: Critical, High, Medium, Low.",
      "User context: " + (record.get("description") || ""),
    ].join(" ");

    const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + geminiKey;

    const res = $http.send({
      method: "POST",
      url: url,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
      timeout: 30,
    });

    if (res.statusCode === 200) {
      const data = JSON.parse(res.raw);
      const text = data.candidates[0].content.parts[0].text.trim();

      // Strip markdown fences
      let json = text;
      if (json.indexOf("```") === 0) {
        json = json.split("\n").slice(1).join("\n").replace(/```\s*$/, "").trim();
      }

      const fields = JSON.parse(json);

      // Update record with AI results (only fill empty fields)
      if (fields.category && !record.get("category")) record.set("category", fields.category);
      if (fields.defect_type && !record.get("defect_type")) record.set("defect_type", fields.defect_type);
      if (fields.severity && !record.get("severity")) record.set("severity", fields.severity);
      if (fields.location && !record.get("location")) record.set("location", fields.location);
      if (fields.description && !record.get("description")) record.set("description", fields.description);
      if (fields.trade && !record.get("trade")) record.set("trade", fields.trade);

      $app.save(record);
    }
  } catch (err) {
    console.log("Gemini analysis failed:", err);
    // Non-fatal — defect is still saved without AI analysis
  }
}, "defects");
