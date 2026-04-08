// Enhanced Google Apps Script for SiteShrimp
// Deploy: Extensions > Apps Script > Deploy > Web app > Anyone > Deploy
//
// QUICK SETUP (run once in Apps Script editor):
//   1. Paste this code into Code.gs
//   2. Select "setup" from the function dropdown, click Run
//   3. Follow the prompts — it will ask for your Sheet URL and Gemini key
//   4. Deploy > New deployment > Web app > Execute as: Me > Access: Anyone
//   5. Copy the URL and share it with your team
//
// All config is stored in Script Properties (not in code).
// To reconfigure, run setup() again or edit Project Settings > Script Properties.

// ====== CONFIG (loaded from Script Properties at runtime) ======
var GEMINI_MODEL = "gemini-2.5-flash";

function getConfig(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || "";
}

function setConfig(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, value);
}

// ====== ONE-TIME SETUP — run this first ======

function setup() {
  var ui = SpreadsheetApp.getUi ? SpreadsheetApp.getUi() : null;

  // 1. Get Sheet URL or ID
  var sheetId = getConfig("SHEET_ID");
  var input = prompt_("Paste your Google Sheet URL (or press Enter to keep current):",
    sheetId ? "Current: " + sheetId : "e.g. https://docs.google.com/spreadsheets/d/abc123/edit");

  if (input && input.trim()) {
    sheetId = extractSheetId_(input.trim());
    setConfig("SHEET_ID", sheetId);
    Logger.log("Sheet ID set: " + sheetId);
  }

  // 2. Auto-create Drive folder or use existing
  var folderId = getConfig("DRIVE_FOLDER_ID");
  if (!folderId) {
    Logger.log("Creating 'SiteShrimp Photos' folder in Drive...");
    var folder = DriveApp.createFolder("SiteShrimp Photos");
    folderId = folder.getId();
    setConfig("DRIVE_FOLDER_ID", folderId);
    Logger.log("Drive folder created: " + folderId);
  } else {
    var overwrite = prompt_("Drive folder already set (" + folderId + "). Keep it? (yes/no):", "yes");
    if (overwrite && overwrite.toLowerCase() === "no") {
      var folderInput = prompt_("Paste Drive folder URL or ID:", "");
      if (folderInput && folderInput.trim()) {
        folderId = extractFolderId_(folderInput.trim());
        setConfig("DRIVE_FOLDER_ID", folderId);
        Logger.log("Drive folder updated: " + folderId);
      }
    }
  }

  // 3. Gemini API key
  var geminiKey = getConfig("GEMINI_API_KEY");
  var keyInput = prompt_("Paste your Gemini API key (or press Enter to skip):",
    geminiKey ? "Current: " + geminiKey.substring(0, 8) + "..." : "Get one free at aistudio.google.com/apikey");
  if (keyInput && keyInput.trim() && keyInput.indexOf("Current:") !== 0 && keyInput.indexOf("Get one") !== 0) {
    setConfig("GEMINI_API_KEY", keyInput.trim());
    Logger.log("Gemini key set.");
  }

  // 4. Verify everything
  Logger.log("\n=== SETUP COMPLETE ===");
  testSetup();
  Logger.log("\nNext: Deploy > New deployment > Web app > Execute as: Me > Access: Anyone");
}

// Quick setup — just pass the Sheet URL directly
// Usage: Run setupWithUrl() then check the logs, or call from the editor
function setupWithUrl(sheetUrl, geminiKey) {
  if (sheetUrl) {
    setConfig("SHEET_ID", extractSheetId_(sheetUrl));
    Logger.log("Sheet ID: " + getConfig("SHEET_ID"));
  }

  // Auto-create Drive folder if not set
  if (!getConfig("DRIVE_FOLDER_ID")) {
    var folder = DriveApp.createFolder("SiteShrimp Photos");
    setConfig("DRIVE_FOLDER_ID", folder.getId());
    Logger.log("Drive folder created: " + folder.getId());
  }

  if (geminiKey) {
    setConfig("GEMINI_API_KEY", geminiKey);
    Logger.log("Gemini key set.");
  }

  testSetup();
}

function prompt_(message, defaultVal) {
  // Try UI prompt first (works when run from Sheet), fall back to Logger
  try {
    var ui = SpreadsheetApp.getUi();
    var result = ui.prompt("SiteShrimp Setup", message, ui.ButtonSet.OK_CANCEL);
    if (result.getSelectedButton() === ui.Button.OK) {
      return result.getResponseText();
    }
    return defaultVal || "";
  } catch (e) {
    // Running from script editor without a Sheet open — use Logger
    Logger.log("PROMPT: " + message);
    Logger.log("(Set values via Script Properties or use setupWithUrl())");
    return defaultVal || "";
  }
}

function extractSheetId_(input) {
  // Accept full URL or just the ID
  var match = input.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : input;
}

function extractFolderId_(input) {
  // Accept full URL or just the ID
  var match = input.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : input;
}

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var action = data.action || "photo";

    switch (action) {
      case "configure": return handleConfigure(data);
      case "sheet":     return handleSheetWrite(data.data);
      case "read":      return handleSheetRead();
      case "update":    return handleSheetUpdate(data.defect_id, data.field, data.value);
      case "analyze":   return handleAnalyzePhoto(data);
      case "next_id":   return handleNextDefectId();
      case "photo":     return handlePhotoUpload(data);
      default:          return handlePhotoUpload(data);
    }
  } catch (err) {
    return jsonResponse({ success: false, error: err.toString() });
  }
}

function doGet(e) {
  // Dashboard or health check
  var action = (e && e.parameter && e.parameter.action) || "dashboard";
  if (action === "health") {
    return jsonResponse({ success: true, status: "ok", version: "2.0-pwa" });
  }
  var template = HtmlService.createTemplateFromFile('Dashboard');
  template.scriptUrl = ScriptApp.getService().getUrl();
  return template.evaluate()
    .setTitle('SiteShrimp Dashboard')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ====== HELPERS ======

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getSheet() {
  var id = getConfig("SHEET_ID");
  if (!id) throw new Error("SHEET_ID not configured. Run setup() first.");
  return SpreadsheetApp.openById(id).getSheets()[0];
}

function getGeminiKey(data) {
  // Prefer Script Property (secure), fallback to client-provided key
  var key = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  if (!key && data && data.geminiKey) key = data.geminiKey;
  return key || "";
}

// ====== REMOTE CONFIGURE (called from SiteShrimp setup) ======

function handleConfigure(data) {
  var changes = [];

  // Set Sheet ID from URL or raw ID
  if (data.sheetUrl) {
    var sheetId = extractSheetId_(data.sheetUrl);
    setConfig("SHEET_ID", sheetId);
    changes.push("SHEET_ID=" + sheetId);

    // Verify sheet access
    try {
      var sheet = SpreadsheetApp.openById(sheetId).getSheets()[0];
      changes.push("sheet_ok:" + sheet.getParent().getName());
    } catch (e) {
      return jsonResponse({ success: false, error: "Cannot access that spreadsheet. Make sure it's shared with the Apps Script owner." });
    }
  }

  // Set Gemini key
  if (data.geminiKey) {
    setConfig("GEMINI_API_KEY", data.geminiKey);
    changes.push("gemini_key=set");
  }

  // Auto-create Drive folder if not set
  if (!getConfig("DRIVE_FOLDER_ID")) {
    var folder = DriveApp.createFolder("SiteShrimp Photos");
    setConfig("DRIVE_FOLDER_ID", folder.getId());
    changes.push("drive_folder=" + folder.getId());
  }

  return jsonResponse({ success: true, configured: changes });
}

// ====== ATOMIC DEFECT ID COUNTER ======

function handleNextDefectId() {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000); // wait up to 10s
  try {
    var props = PropertiesService.getScriptProperties();
    var count = parseInt(props.getProperty("defect_counter") || "0", 10) + 1;
    props.setProperty("defect_counter", count.toString());
    lock.releaseLock();
    var id = "DEF-" + ("0000" + count).slice(-4);
    return jsonResponse({ success: true, defect_id: id, count: count });
  } catch (err) {
    lock.releaseLock();
    return jsonResponse({ success: false, error: err.toString() });
  }
}

// ====== GEMINI PHOTO ANALYSIS ======

function handleAnalyzePhoto(data) {
  var apiKey = getGeminiKey(data);
  if (!apiKey) {
    return jsonResponse({ success: false, error: "GEMINI_API_KEY not configured. Set it in Script Properties." });
  }

  var b64 = data.base64 || "";
  var context = data.context || "";

  if (!b64) {
    return jsonResponse({ success: false, error: "No photo data provided" });
  }

  var prompt =
    "You are a defect inspector for construction sites and facilities management. Analyze this photo and " +
    "any accompanying text to extract a defect report. " +
    "Return ONLY a JSON object (no markdown, no backticks) with these string fields: " +
    "location, category, defect_type, severity, description, trade, target_fix_date. " +
    "For category, pick the closest match from: Column, Beam, Slab, Foundation, Retaining Wall, " +
    "Door, Window, Wall, Floor, Ceiling, Roof, Staircase, Fence/Railing, Balcony, Corridor, " +
    "Cabinet, Wardrobe, Countertop, Skirting, Shelf, " +
    "Plumbing, Electrical, Aircon, Lighting, Sanitary, Fire Safety, " +
    "Painting, Tiling, Waterproofing, Plastering, " +
    "Driveway, Walkway, Garden/Planting, Drain/Gutter, Car Park, Swimming Pool, Playground, General. " +
    "defect_type is the specific type (e.g. Crack, Leak, Peeling). " +
    "For severity use: Critical, High, Medium, or Low. " +
    "target_fix_date must be YYYY-MM-DD or empty string. " +
    "If a field cannot be determined, use empty string. " +
    "description should detail what defect is visible.";

  if (context) {
    prompt += "\n\nUser context: " + context;
  }

  var url = "https://generativelanguage.googleapis.com/v1beta/models/" +
    GEMINI_MODEL + ":generateContent?key=" + apiKey;

  var payload = {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: "image/jpeg", data: b64 } }
      ]
    }]
  };

  try {
    var response = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    var result = JSON.parse(response.getContentText());
    var content = "";
    try {
      content = result.candidates[0].content.parts[0].text.trim();
    } catch (e) {
      return jsonResponse({ success: false, error: "Gemini returned unexpected structure" });
    }

    // Strip markdown code fences
    if (content.indexOf("```") === 0) {
      content = content.split("\n").slice(1).join("\n");
      content = content.replace(/```\s*$/, "").trim();
    }

    var parsed = JSON.parse(content);
    return jsonResponse({ success: true, fields: parsed });
  } catch (err) {
    return jsonResponse({ success: false, error: "Gemini analysis failed: " + err.toString() });
  }
}

// ====== SHEET OPERATIONS ======

function handleSheetWrite(row) {
  var sheet = getSheet();
  var headers = [
    "defect_id","status","timestamp_utc","telegram_user",
    "project","unit","location","category","defect_type","severity",
    "description","trade","assigned_to","target_fix_date","resolved_date",
    "input_source","photo_url",
    "initiated_by","responsible_party","follow_up_by","remarks","cost","quality"
  ];

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  }

  var values = headers.map(function(h) { return row[h] || ""; });
  sheet.appendRow(values);

  // Make photo_url clickable
  var lastRow = sheet.getLastRow();
  var photoUrlCol = headers.indexOf("photo_url") + 1;
  if (photoUrlCol > 0) {
    var photoUrlValue = row["photo_url"] || "";
    if (photoUrlValue) {
      var urls = photoUrlValue.split(", ");
      var cell = sheet.getRange(lastRow, photoUrlCol);
      if (urls.length === 1) {
        cell.setFormula('=HYPERLINK("' + urls[0] + '","View Photo")');
      } else {
        cell.setFormula('=HYPERLINK("' + urls[0] + '",' + urls.length + ' + " photos")');
        cell.setNote(urls.join("\n"));
      }
    }
  }

  return jsonResponse({ success: true });
}

function handleSheetRead() {
  var sheet = getSheet();
  var data = sheet.getDataRange().getValues();
  if (data.length === 0) return jsonResponse({ success: true, rows: [] });

  var headers = data[0];
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var obj = {};
    for (var j = 0; j < headers.length; j++) {
      obj[headers[j]] = data[i][j] !== undefined && data[i][j] !== null ? String(data[i][j]) : "";
    }
    rows.push(obj);
  }
  return jsonResponse({ success: true, rows: rows });
}

function handleSheetUpdate(defectId, field, value) {
  var sheet = getSheet();
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var colIdx = headers.indexOf(field);
  var idIdx = headers.indexOf("defect_id");

  if (colIdx === -1 || idIdx === -1) {
    return jsonResponse({ success: false, error: "Field not found" });
  }

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][idIdx]).toUpperCase() === String(defectId).toUpperCase()) {
      sheet.getRange(i + 1, colIdx + 1).setValue(value);
      return jsonResponse({ success: true });
    }
  }
  return jsonResponse({ success: false, error: "Defect not found" });
}

// ====== PHOTO UPLOAD TO DRIVE ======

function handlePhotoUpload(data) {
  var folderId = getConfig("DRIVE_FOLDER_ID");
  if (!folderId) throw new Error("DRIVE_FOLDER_ID not configured. Run setup() first.");
  var fileName = data.fileName || "photo.jpg";
  var base64Data = data.base64;
  var mimeType = data.mimeType || "image/jpeg";

  var metadata = { name: fileName, parents: [folderId] };
  var boundary = "-------boundary123";
  var requestBody =
    "--" + boundary + "\r\n" +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    JSON.stringify(metadata) + "\r\n" +
    "--" + boundary + "\r\n" +
    "Content-Type: " + mimeType + "\r\n" +
    "Content-Transfer-Encoding: base64\r\n\r\n" +
    base64Data + "\r\n" +
    "--" + boundary + "--";

  var response = UrlFetchApp.fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
    {
      method: "post",
      contentType: "multipart/related; boundary=" + boundary,
      payload: requestBody,
      headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    }
  );

  var fileData = JSON.parse(response.getContentText());
  var fileId = fileData.id;

  // Make file publicly readable
  UrlFetchApp.fetch(
    "https://www.googleapis.com/drive/v3/files/" + fileId + "/permissions",
    {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({ role: "reader", type: "anyone" }),
      headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    }
  );

  return jsonResponse({
    success: true,
    fileId: fileId,
    url: "https://drive.google.com/file/d/" + fileId + "/view"
  });
}

// ====== TEST / SETUP HELPERS ======

function testSetup() {
  // Run this manually to verify configuration
  Logger.log("=== SiteShrimp Setup Test ===");

  var sheetId = getConfig("SHEET_ID");
  Logger.log("SHEET_ID: " + (sheetId || "NOT SET"));

  var folderId = getConfig("DRIVE_FOLDER_ID");
  Logger.log("DRIVE_FOLDER_ID: " + (folderId || "NOT SET"));

  // Test sheet access
  if (sheetId) {
    try {
      var sheet = SpreadsheetApp.openById(sheetId).getSheets()[0];
      Logger.log("Sheet OK: " + sheet.getParent().getName() + " / " + sheet.getName() + " (" + sheet.getLastRow() + " rows)");
    } catch (e) {
      Logger.log("Sheet ERROR: " + e);
    }
  }

  // Test Drive access
  if (folderId) {
    try {
      var folder = DriveApp.getFolderById(folderId);
      Logger.log("Drive OK: " + folder.getName());
    } catch (e) {
      Logger.log("Drive ERROR: " + e);
    }
  }

  // Test Gemini key
  var geminiKey = getConfig("GEMINI_API_KEY");
  Logger.log("Gemini key: " + (geminiKey ? "SET (" + geminiKey.substring(0, 8) + "...)" : "NOT SET (AI analysis disabled)"));

  // Test counter
  var counter = getConfig("defect_counter");
  Logger.log("Defect counter: " + (counter || "0") + " (next: DEF-" + ("0000" + (parseInt(counter || "0") + 1)).slice(-4) + ")");

  Logger.log("=== Test Complete ===");
}

function resetDefectCounter(newValue) {
  // Run manually to reset or sync the counter.
  // Usage: resetDefectCounter(42) — sets next ID to DEF-0043
  var val = newValue !== undefined ? newValue : 0;
  PropertiesService.getScriptProperties().setProperty("defect_counter", val.toString());
  Logger.log("Counter reset to " + val + ". Next ID will be DEF-" + ("0000" + (val + 1)).slice(-4));
}
