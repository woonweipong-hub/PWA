// Google Apps Script — Backend for SiteSnag PWA
// Deploy: Extensions > Apps Script > Deploy > New deployment > Web app > Anyone > Deploy
//
// This script handles:
//   1. Photo upload to Google Drive
//   2. Defect write/read/update on Google Sheets
//   3. AI photo analysis via Gemini Vision
//   4. Sequential defect ID generation
//   5. CORS for PWA cross-origin requests
//
// SETUP: Update these values before deploying:
var SHEET_ID = "YOUR_GOOGLE_SHEET_ID_HERE";
var DRIVE_FOLDER_ID = "YOUR_GOOGLE_DRIVE_FOLDER_ID_HERE";
var GEMINI_API_KEY = ""; // Optional: set here or pass from PWA per-request

// ====== HEADERS (column order in Sheet) ======
var HEADERS = [
  "defect_id","status","timestamp_utc","telegram_user",
  "project","unit","location","category","defect_type","severity",
  "description","trade","assigned_to","target_fix_date","resolved_date",
  "input_source","photo_url",
  "initiated_by","responsible_party","follow_up_by","remarks","cost","quality"
];

// ====== ROUTER ======

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var action = data.action || "photo";

    var result;
    if (action === "sheet")    result = handleSheetWrite(data.data);
    else if (action === "read")     result = handleSheetRead();
    else if (action === "update")   result = handleSheetUpdate(data.defect_id, data.field, data.value);
    else if (action === "analyze")  result = handleAnalyze(data);
    else if (action === "next_id")  result = handleNextId();
    else if (action === "photo")    result = handlePhotoUpload(data);
    else result = { success: false, error: "Unknown action: " + action };

    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(
      JSON.stringify({ success: false, error: err.toString() })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  // If ?action=read, return JSON (for PWA fetch)
  if (e && e.parameter && e.parameter.action === "read") {
    var result = handleSheetRead();
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  }
  // Otherwise serve dashboard HTML
  var template = HtmlService.createTemplateFromFile('Dashboard');
  template.scriptUrl = ScriptApp.getService().getUrl();
  return template.evaluate()
    .setTitle('SiteSnag Dashboard')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ====== SHEET OPERATIONS ======

function getSheet() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  return ss.getSheets()[0];
}

function handleSheetWrite(row) {
  var sheet = getSheet();

  // Create headers if sheet is empty
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  }

  var values = HEADERS.map(function(h) { return row[h] || ""; });
  sheet.appendRow(values);

  // Make photo_url clickable
  var lastRow = sheet.getLastRow();
  var photoUrlCol = HEADERS.indexOf("photo_url") + 1;
  if (photoUrlCol > 0) {
    var photoUrlValue = row["photo_url"] || "";
    if (photoUrlValue) {
      var urls = photoUrlValue.split(", ");
      var cell = sheet.getRange(lastRow, photoUrlCol);
      if (urls.length === 1) {
        cell.setFormula('=HYPERLINK("' + urls[0] + '","View Photo")');
      } else {
        cell.setFormula('=HYPERLINK("' + urls[0] + '","' + urls.length + ' photos")');
        cell.setNote(urls.join("\n"));
      }
    }
  }

  return { success: true };
}

function handleSheetRead() {
  var sheet = getSheet();
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return { success: true, rows: [] };

  var headers = data[0];
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var obj = {};
    for (var j = 0; j < headers.length; j++) {
      var val = data[i][j];
      obj[headers[j]] = (val !== undefined && val !== null) ? String(val) : "";
    }
    rows.push(obj);
  }
  return { success: true, rows: rows };
}

function handleSheetUpdate(defectId, field, value) {
  var sheet = getSheet();
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var colIdx = headers.indexOf(field);
  var idIdx = headers.indexOf("defect_id");

  if (colIdx === -1 || idIdx === -1) {
    return { success: false, error: "Field not found: " + field };
  }

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][idIdx]).toUpperCase() === String(defectId).toUpperCase()) {
      sheet.getRange(i + 1, colIdx + 1).setValue(value);
      return { success: true };
    }
  }
  return { success: false, error: "Defect not found: " + defectId };
}

// ====== DEFECT ID GENERATION ======

function handleNextId() {
  var sheet = getSheet();
  var data = sheet.getDataRange().getValues();

  // Find highest existing DEF-XXXX
  var maxNum = 0;
  var idIdx = 0; // defect_id is first column
  for (var i = 1; i < data.length; i++) {
    var id = String(data[i][idIdx]);
    var match = id.match(/DEF-(\d+)/i);
    if (match) {
      var num = parseInt(match[1], 10);
      if (num > maxNum) maxNum = num;
    }
  }

  var nextNum = maxNum + 1;
  var defectId = "DEF-" + ("0000" + nextNum).slice(-4);
  return { success: true, defect_id: defectId };
}

// ====== PHOTO UPLOAD ======

function handlePhotoUpload(data) {
  var fileName = data.fileName || "photo.jpg";
  var base64Data = data.base64;
  var mimeType = data.mimeType || "image/jpeg";

  var metadata = { name: fileName, parents: [DRIVE_FOLDER_ID] };
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

  // Make publicly readable
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

  return {
    success: true,
    fileId: fileId,
    url: "https://drive.google.com/file/d/" + fileId + "/view"
  };
}

// ====== GEMINI VISION ANALYSIS ======

function handleAnalyze(data) {
  var base64 = data.base64 || "";
  var context = data.context || "";
  var apiKey = data.geminiKey || GEMINI_API_KEY;

  if (!apiKey) {
    return { success: false, error: "No Gemini API key configured" };
  }

  var prompt = buildAnalysisPrompt(context);
  var parts = [];

  // Add text prompt
  parts.push({ text: prompt });

  // Add image if present
  if (base64) {
    parts.push({
      inline_data: {
        mime_type: "image/jpeg",
        data: base64
      }
    });
  }

  var url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" + apiKey;

  try {
    var response = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({
        contents: [{ parts: parts }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 1024,
        }
      }),
      muteHttpExceptions: true
    });

    var result = JSON.parse(response.getContentText());
    var text = result.candidates[0].content.parts[0].text;

    // Extract JSON from response
    var jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      var fields = JSON.parse(jsonMatch[0]);
      return { success: true, fields: fields };
    } else {
      return { success: false, error: "Could not parse AI response", raw: text };
    }
  } catch (err) {
    return { success: false, error: "Gemini API error: " + err.toString() };
  }
}

function buildAnalysisPrompt(context) {
  return [
    "You are a construction defect inspector analyzing a site photo and/or description.",
    "Extract structured defect information and return ONLY a JSON object (no markdown, no explanation).",
    "",
    "Categories (pick one): Structural, Door, Window, Wall, Floor, Ceiling, Plumbing, Electrical,",
    "Aircon, Painting, Tiling, Waterproofing, Cabinet, Roof, Staircase, Lighting, Sanitary, General",
    "",
    "Severity: Critical (safety hazard), High (major function failure), Medium (visible quality defect), Low (minor cosmetic)",
    "",
    "Return this exact JSON structure:",
    '{',
    '  "category": "...",',
    '  "defect_type": "...",',
    '  "severity": "High|Medium|Low|Critical",',
    '  "location": "room/area name",',
    '  "description": "1-2 sentence description of the defect",',
    '  "trade": "responsible trade"',
    '}',
    "",
    context ? "Context from user: " + context : "",
    "",
    "Analyze the image/text and respond with ONLY the JSON object."
  ].join("\n");
}

// ====== TEST FUNCTIONS ======

function testDriveAccess() {
  var folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
  Logger.log("Folder: " + folder.getName());
  var ss = SpreadsheetApp.openById(SHEET_ID);
  Logger.log("Sheet: " + ss.getName());
}

function testGeminiAccess() {
  if (!GEMINI_API_KEY) { Logger.log("No Gemini API key set"); return; }
  var result = handleAnalyze({
    base64: "",
    context: "ceiling crack near aircon unit, bedroom, unit 12-05",
    geminiKey: GEMINI_API_KEY
  });
  Logger.log(JSON.stringify(result));
}

function testNextId() {
  var result = handleNextId();
  Logger.log(JSON.stringify(result));
}
