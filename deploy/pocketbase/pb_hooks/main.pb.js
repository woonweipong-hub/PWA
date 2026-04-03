/// <reference path="../pb_data/types.d.ts" />

// SiteShrimp PocketBase Hooks
// Runs server-side inside PocketBase (JavaScript ES5)
//
// Features:
//   - Auto-generate defect IDs (DEF-0001, DEF-0002, ...)
//   - AI photo analysis (Gemini, Ollama, OpenAI) on upload
//   - Local path storage (copy photos to user-specified folder)
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
    record.set("status", "Open");
  }

  // Default input source
  if (!record.get("input_source")) {
    record.set("input_source", "pwa");
  }

  return e.next();
}, "defects");

// ====== LOCAL PATH STORAGE (copy photos to user-specified folder) ======

onRecordAfterCreateSuccess((e) => {
  const record = e.record;
  const storageMode = record.get("storageMode");
  const storagePath = record.get("storagePath");
  const photo = record.get("photo");

  if (storageMode !== "local" || !storagePath || !photo) return;

  try {
    // Ensure target directory exists
    $os.mkdirAll(storagePath, 0o755);

    // Read photo from PocketBase storage and copy to local path
    const fsys = $app.newFilesystem();
    const photos = Array.isArray(photo) ? photo : [photo];

    for (var i = 0; i < photos.length; i++) {
      var fileName = photos[i];
      var fileKey = record.baseFilesPath() + "/" + fileName;
      try {
        var reader = fsys.getFile(fileKey);
        var photoBytes = reader.readAll();
        reader.close();

        // Build destination: storagePath/defectId/filename
        var destDir = storagePath + "/" + record.getId();
        $os.mkdirAll(destDir, 0o755);
        $os.writeFile(destDir + "/" + fileName, photoBytes, 0o644);
      } catch (copyErr) {
        console.log("Local storage copy failed for " + fileName + ":", copyErr);
      }
    }
    fsys.close();
  } catch (err) {
    console.log("Local path storage failed:", err);
  }
}, "defects");

// ====== STORAGE TEST ENDPOINT ======
// Lets users test if a local path is writable

routerAdd("POST", "/api/storage/test", (e) => {
  var body = e.request.body;
  var path = "";
  try {
    var data = JSON.parse($toString(body));
    path = data.path || "";
  } catch {}

  if (!path) {
    return e.json(400, { error: "No path provided" });
  }

  try {
    $os.mkdirAll(path, 0o755);
    // Write a test file and clean up
    var testFile = path + "/.siteshrimp_test";
    $os.writeFile(testFile, "test", 0o644);
    $os.remove(testFile);
    return e.json(200, { ok: true, path: path });
  } catch (err) {
    return e.json(400, { error: "Path not writable: " + err });
  }
});

// ====== AI ANALYSIS (multi-provider: Gemini, Ollama, OpenAI) ======

var AI_SERVER_PROMPT = [
  "You are a construction site defect inspector. Analyze this photo.",
  "Return ONLY a JSON object with: category, defect_type, severity, location, description, trade.",
  "Categories: Column, Beam, Slab, Door, Window, Wall, Floor, Ceiling, Roof,",
  "Plumbing, Electrical, Aircon, Painting, Tiling, Waterproofing, Cabinet, General.",
  "Severity: Critical, High, Medium, Low.",
].join(" ");

function analyzeWithGeminiServer(b64Photo, geminiKey, description) {
  var prompt = AI_SERVER_PROMPT + " User context: " + (description || "");
  var url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + geminiKey;
  var res = $http.send({
    method: "POST",
    url: url,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [
        { text: prompt },
        { inline_data: { mime_type: "image/jpeg", data: b64Photo } }
      ]}],
    }),
    timeout: 60,
  });
  if (res.statusCode === 200) {
    var data = JSON.parse(res.raw);
    return data.candidates[0].content.parts[0].text.trim();
  }
  return null;
}

function analyzeWithOllamaServer(b64Photo, ollamaUrl, ollamaModel, description) {
  var prompt = AI_SERVER_PROMPT + " User context: " + (description || "");
  var url = ollamaUrl.replace(/\/+$/, "") + "/api/generate";
  var res = $http.send({
    method: "POST",
    url: url,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ollamaModel || "llava",
      prompt: prompt,
      images: [b64Photo],
      stream: false,
    }),
    timeout: 120,
  });
  if (res.statusCode === 200) {
    var data = JSON.parse(res.raw);
    return data.response || null;
  }
  return null;
}

function analyzeWithOpenAIServer(b64Photo, oaiUrl, oaiKey, oaiModel, description) {
  var prompt = AI_SERVER_PROMPT + " User context: " + (description || "");
  var url = oaiUrl.replace(/\/+$/, "") + "/v1/chat/completions";
  var res = $http.send({
    method: "POST",
    url: url,
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + oaiKey },
    body: JSON.stringify({
      model: oaiModel || "gpt-4o-mini",
      max_tokens: 500,
      messages: [{ role: "user", content: [
        { type: "image_url", image_url: { url: "data:image/jpeg;base64," + b64Photo, detail: "low" } },
        { type: "text", text: prompt }
      ]}],
    }),
    timeout: 60,
  });
  if (res.statusCode === 200) {
    var data = JSON.parse(res.raw);
    return (data.choices && data.choices[0] && data.choices[0].message) ? data.choices[0].message.content : null;
  }
  return null;
}

function parseAiResponse(text) {
  if (!text) return null;
  var json = text;
  if (json.indexOf("```") === 0) {
    json = json.split("\n").slice(1).join("\n").replace(/```\s*$/, "").trim();
  }
  json = json.replace(/```json|```/g, "").trim();
  return JSON.parse(json);
}

onRecordAfterCreateSuccess((e) => {
  const record = e.record;
  const photo = record.get("photo");

  // Skip if no photo or already analyzed
  if (!photo || record.get("category")) return;
  // Skip Google Drive records (photos not on PocketBase storage)
  if (record.get("storageMode") === "gdrive") return;

  // Determine which AI provider to use (env vars)
  var geminiKey = $os.getenv("GEMINI_API_KEY");
  var ollamaUrl = $os.getenv("OLLAMA_URL");
  var ollamaModel = $os.getenv("OLLAMA_MODEL") || "llava";
  var oaiKey = $os.getenv("OPENAI_API_KEY");
  var oaiUrl = $os.getenv("OPENAI_URL") || "https://api.openai.com";
  var oaiModel = $os.getenv("OPENAI_MODEL") || "gpt-4o-mini";
  var aiProvider = $os.getenv("AI_PROVIDER") || "gemini";

  // Must have at least one provider configured
  if (!geminiKey && !ollamaUrl && !oaiKey) return;

  try {
    // Read photo file from PocketBase storage
    var fsys = $app.newFilesystem();
    var photoName = Array.isArray(photo) ? photo[0] : photo;
    var fileKey = record.baseFilesPath() + "/" + photoName;
    var reader = fsys.getFile(fileKey);
    var photoBytes = reader.readAll();
    reader.close();
    fsys.close();

    var b64Photo = $security.base64Encode(photoBytes);
    var description = record.get("description") || "";
    var responseText = null;

    // Call the configured provider
    if (aiProvider === "ollama" && ollamaUrl) {
      responseText = analyzeWithOllamaServer(b64Photo, ollamaUrl, ollamaModel, description);
    } else if (aiProvider === "openai" && oaiKey) {
      responseText = analyzeWithOpenAIServer(b64Photo, oaiUrl, oaiKey, oaiModel, description);
    } else if (geminiKey) {
      responseText = analyzeWithGeminiServer(b64Photo, geminiKey, description);
    }

    if (responseText) {
      var fields = parseAiResponse(responseText);
      if (fields) {
        if (fields.category && !record.get("category")) record.set("category", fields.category);
        if (fields.defect_type && !record.get("defect_type")) record.set("defect_type", fields.defect_type);
        if (fields.severity && !record.get("severity")) record.set("severity", fields.severity);
        if (fields.location && !record.get("location")) record.set("location", fields.location);
        if (fields.description && !record.get("description")) record.set("description", fields.description);
        if (fields.trade && !record.get("trade")) record.set("trade", fields.trade);
        $app.save(record);
      }
    }
  } catch (err) {
    console.log("AI analysis failed:", err);
    // Non-fatal — defect is still saved without AI analysis
  }
}, "defects");
