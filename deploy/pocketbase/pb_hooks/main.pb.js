/// <reference path="../pb_data/types.d.ts" />

// SiteShrimp PocketBase Hooks
// Runs server-side inside PocketBase (JavaScript ES5)
//
// Features:
//   - Auto-generate defect IDs (DEF-0001, DEF-0002, ...)
//   - AI photo analysis (Gemini, Ollama, OpenAI) on upload
//   - Local path storage (copy photos to user-specified folder)
//   - Auto-set timestamps

// ====== RATE LIMITER ======
// Simple in-memory rate limiter (per IP, resets on restart)
var _rateLimits = {};
function rateLimit(key, maxPerMinute) {
  var now = Date.now();
  if (!_rateLimits[key]) _rateLimits[key] = [];
  // Remove entries older than 60s
  _rateLimits[key] = _rateLimits[key].filter(function(t) { return now - t < 60000; });
  if (_rateLimits[key].length >= maxPerMinute) return false;
  _rateLimits[key].push(now);
  return true;
}

// ====== PER-COMPANY STORAGE CAP ======
// Hard cap on per-company file storage. Rejects uploads that would exceed.
// Bounds the worst-case per-company storage cost on the shared instance and
// prevents siteshrimp.org from accidentally becoming any team's permanent home.
// Tune COMPANY_STORAGE_CAP_BYTES per the operator's hosting budget.
var COMPANY_STORAGE_CAP_BYTES = 1024 * 1024 * 1024; // 1 GB

function getCompanyStorageBytes(companyId) {
  var sql = "SELECT COALESCE(SUM(json_extract(value, '$.size')), 0) AS total " +
            "FROM defects, json_each(json_array(photo, photoOriginal, costDoc)) " +
            "WHERE companyId = {:cid}";
  try {
    var row = $app.db().newQuery(sql).bind({"cid": companyId}).one();
    return row && row.total ? parseInt(row.total) : 0;
  } catch (e) {
    return 0;
  }
}

onRecordCreateRequest((e) => {
  if (e.collection.name !== "defects") return e.next();
  var record = e.record;
  var companyId = record.get("companyId");
  if (!companyId) return e.next();

  var incomingBytes = 0;
  ["photo", "photoOriginal", "costDoc"].forEach(function (field) {
    var files = record.get(field) || [];
    if (!Array.isArray(files)) files = [files];
    files.forEach(function (f) {
      if (f && f.size) incomingBytes += f.size;
    });
  });

  var currentBytes = getCompanyStorageBytes(companyId);
  if (currentBytes + incomingBytes > COMPANY_STORAGE_CAP_BYTES) {
    throw new BadRequestError(
      "Storage cap reached (1 GB). Please migrate to your own server " +
      "(Settings -> Storage & Hosting -> Path 2 or Path 3) or delete old defects."
    );
  }
  e.next();
}, "defects");

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
  var ip = e.request.remoteAddr || "unknown";
  if (!rateLimit("storage_test_" + ip, 10)) {
    return e.json(429, { error: "Too many requests. Try again in a minute." });
  }
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
  "You are a defect inspector for construction sites and facilities management. Analyze this photo.",
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
  // Rate limit AI analysis: max 30 per minute globally
  if (!rateLimit("ai_analysis", 30)) return;

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

// ====== SEND EMAIL REPORT (via PocketBase SMTP) ======
// Requires SMTP configured in PocketBase Admin → Settings → Mail settings
// Accepts: { recipients: ["a@b.com"], subject: "...", html: "..." }

routerAdd("POST", "/api/send-email", (e) => {
  // Require authenticated user
  var auth = e.auth;
  if (!auth) {
    return e.json(401, { error: "Authentication required." });
  }

  var ip = e.request.remoteAddr || "unknown";
  if (!rateLimit("send_email_" + ip, 5)) {
    return e.json(429, { error: "Too many email requests. Try again in a minute." });
  }

  var body = e.request.body;
  var data;
  try {
    data = JSON.parse($toString(body));
  } catch {
    return e.json(400, { error: "Invalid JSON body." });
  }

  var recipients = data.recipients || [];
  var subject = data.subject || "";
  var html = data.html || "";

  if (!recipients.length) {
    return e.json(400, { error: "No recipients provided." });
  }
  if (!subject || !html) {
    return e.json(400, { error: "Subject and HTML content are required." });
  }

  // Basic email validation
  var emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  for (var i = 0; i < recipients.length; i++) {
    if (!emailRegex.test(recipients[i])) {
      return e.json(400, { error: "Invalid email: " + recipients[i] });
    }
  }

  var errors = [];
  for (var i = 0; i < recipients.length; i++) {
    try {
      var msg = new MailerMessage();
      msg.from = { address: $app.settings().meta.senderAddress, name: $app.settings().meta.senderName || "SiteShrimp" };
      msg.to = [{ address: recipients[i] }];
      msg.subject = subject;
      msg.html = html;
      $app.newMailClient().send(msg);
    } catch (err) {
      console.log("Email send failed for " + recipients[i] + ":", err);
      errors.push(recipients[i]);
    }
  }

  if (errors.length === recipients.length) {
    return e.json(500, { error: "Failed to send all emails. Check SMTP settings in PocketBase admin." });
  }
  if (errors.length > 0) {
    return e.json(207, { ok: true, partial: true, failed: errors });
  }
  return e.json(200, { ok: true });
});

// ====== CONFIGURE SMTP (admin-only, from in-app settings) ======
// Lets the owner set SMTP directly from SiteShrimp without opening PB admin
routerAdd("POST", "/api/configure-smtp", (e) => {
  var auth = e.auth;
  if (!auth) {
    return e.json(401, { error: "Authentication required." });
  }

  // Check if user is admin role in their company
  var member;
  try {
    member = $app.findFirstRecordByFilter("members", 'userId="' + auth.id + '"');
  } catch(_) {}
  if (!member || member.getString("role") !== "admin") {
    return e.json(403, { error: "Only admins can configure SMTP." });
  }

  var body;
  try {
    body = JSON.parse($toString(e.request.body));
  } catch(_) {
    return e.json(400, { error: "Invalid JSON body." });
  }

  var host = body.host || "";
  var port = parseInt(body.port) || 587;
  var username = body.username || "";
  var password = body.password || "";
  var fromEmail = body.fromEmail || username;
  var fromName = body.fromName || "SiteShrimp";

  if (!host || !username || !password) {
    return e.json(400, { error: "Host, username, and password are required." });
  }

  try {
    var settings = $app.settings();
    settings.smtp.enabled = true;
    settings.smtp.host = host;
    settings.smtp.port = port;
    settings.smtp.tls = true;
    settings.smtp.username = username;
    settings.smtp.password = password;
    settings.meta.senderAddress = fromEmail;
    settings.meta.senderName = fromName;
    $app.save(settings);
    return e.json(200, { ok: true });
  } catch (err) {
    console.log("SMTP configure failed:", err);
    return e.json(500, { error: "Failed to save SMTP settings: " + err });
  }
});

// ====== TEST SMTP (send a test email to verify config) ======
routerAdd("POST", "/api/test-smtp", (e) => {
  var auth = e.auth;
  if (!auth) {
    return e.json(401, { error: "Authentication required." });
  }

  var body;
  try {
    body = JSON.parse($toString(e.request.body));
  } catch(_) {
    return e.json(400, { error: "Invalid JSON body." });
  }

  var to = body.to || auth.getString("email");
  if (!to) {
    return e.json(400, { error: "No email address to test." });
  }

  try {
    var msg = new MailerMessage();
    msg.from = { address: $app.settings().meta.senderAddress, name: $app.settings().meta.senderName || "SiteShrimp" };
    msg.to = [{ address: to }];
    msg.subject = "SiteShrimp — Test Email";
    msg.html = "<h2>It works!</h2><p>Your email is configured correctly. You can now send reports from SiteShrimp.</p>";
    $app.newMailClient().send(msg);
    return e.json(200, { ok: true });
  } catch (err) {
    console.log("Test email failed:", err);
    return e.json(500, { error: "Test email failed: " + err });
  }
});
