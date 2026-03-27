# SiteSnag - Construction Defect Reporter

**Snap. Speak. Done.**

A zero-cost Progressive Web App (PWA) for construction site defect tracking. Workers snap photos, speak descriptions, and AI classifies everything automatically. Defects sync to Google Sheets with photos stored in Google Drive.

No app store. No account. No Telegram. Just open the link and start reporting.

---

## Quick Start (2 minutes)

### 1. Install on your phone

Open this link on your mobile browser:

**https://woonweipong-hub.github.io/PWA/**

Then:
- **Android (Chrome)**: Tap the menu (3 dots) > "Add to Home Screen"
- **iPhone (Safari)**: Tap Share > "Add to Home Screen"

The app icon appears on your home screen. It works offline.

### 2. First-time setup

When you open the app for the first time:

| Field | What to enter |
|-------|---------------|
| **Your Name** | Your name (shown in defect reports) |
| **Default Project** | Your project name (e.g. "Riviera Bay Phase 2") |
| **Apps Script URL** | The backend URL (your PM will give you this) |
| **Gemini API Key** | Optional - enables AI photo analysis |

### 3. Report a defect

1. Tap **Report Defect**
2. Take a photo (tap the camera area)
3. Hold the mic button and describe the defect
4. Tap **Analyze with AI** - AI fills in category, severity, trade
5. Review and tap **Submit Defect**

### 4. Site Walk mode

For batch inspections:
1. Tap **Site Walk**
2. Set project and unit
3. Snap photos and speak as you walk
4. Tap **Process All Items** - AI analyzes everything at once
5. Review all defects and tap **Submit All**

---

## Viral Sharing

Share a pre-configured link so workers skip setup:

```
https://woonweipong-hub.github.io/PWA/?api=YOUR_APPS_SCRIPT_URL
```

Workers open the link, enter their name, and they're ready. No config needed.

Generate a QR code from this URL and print it on your site notice board.

---

## Architecture

```
Phone (PWA)                    Google Cloud (free)
+-----------+                  +---------------------------+
| Camera    |----> Photo ----->| Google Apps Script         |
| Mic       |----> Voice ----->|   +-> Gemini 2.0 Flash AI |
| Touch     |----> Text ------>|   +-> Google Sheets (log)  |
+-----------+                  |   +-> Google Drive (photos) |
      |                        +---------------------------+
      v
  IndexedDB
  (offline queue)
```

### How it works

| Step | What happens | Technology |
|------|-------------|------------|
| Photo capture | Native camera via browser | `<input capture="environment">` |
| Voice input | Real-time speech-to-text | Web Speech API (free, in-browser) |
| AI analysis | Photo + text analyzed | Gemini 2.0 Flash (free tier: 1M tokens/day) |
| Data storage | Defect log (spreadsheet) | Google Sheets via Apps Script |
| Photo storage | Permanent shareable links | Google Drive via Apps Script |
| Offline mode | Cached app shell + local queue | Service Worker + localStorage |
| Installation | "Add to Home Screen" | PWA manifest + Service Worker |

### Connected Tools & Services

| Service | What it does | Cost |
|---------|-------------|------|
| **Google Sheets** | Defect log (single source of truth) | Free |
| **Google Drive** | Photo storage with shareable URLs | Free (15 GB) |
| **Gemini 2.0 Flash** | AI vision - classifies defects from photos | Free (15 req/min) |
| **Web Speech API** | Voice-to-text in the browser | Free (built into Chrome/Safari) |
| **GitHub Pages** | Hosts the PWA | Free |
| **Google Apps Script** | Serverless backend (no VM needed) | Free |

**Total cost: $0/month** for unlimited users.

---

## Backend Setup (for PMs / admins)

### Step 1: Create Google Sheet

1. Go to [sheets.google.com](https://sheets.google.com) and create a new spreadsheet
2. Name it "SiteSnag Defects" (or anything)
3. Copy the Sheet ID from the URL: `docs.google.com/spreadsheets/d/<SHEET_ID>/edit`

### Step 2: Create Drive folder

1. Go to [drive.google.com](https://drive.google.com) and create a new folder
2. Name it "SiteSnag Photos"
3. Copy the Folder ID from the URL: `drive.google.com/drive/folders/<FOLDER_ID>`

### Step 3: Deploy Apps Script

1. Open your Google Sheet
2. Go to **Extensions > Apps Script**
3. Delete any existing code in `Code.gs`
4. Copy the contents of [`backend/google_apps_script.js`](backend/google_apps_script.js) and paste it
5. Update line 11: `var SHEET_ID = "your_sheet_id";`
6. Update line 12: `var DRIVE_FOLDER_ID = "your_folder_id";`
7. (Optional) Update line 13: `var GEMINI_API_KEY = "your_key";`
8. Click **Deploy > New deployment**
9. Type: **Web app**
10. Execute as: **Me**
11. Who has access: **Anyone**
12. Click **Deploy**
13. Copy the Web App URL

### Step 4: Get Gemini API Key (optional but recommended)

1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
2. Click "Create API Key"
3. Copy the key
4. Either paste it in the Apps Script (line 13) or enter it in the PWA Settings

### Step 5: Share with your team

Send this link to workers:
```
https://woonweipong-hub.github.io/PWA/?api=YOUR_APPS_SCRIPT_URL
```

Or print a QR code pointing to it.

---

## Features

### Defect Reporting
- Take photos with phone camera
- Voice input with real-time transcription
- AI auto-classifies: category, severity, defect type, trade
- Manual text input as fallback
- 35 categories, 200+ defect types

### Site Walk Mode
- Batch capture: photos + voice notes as you walk
- AI processes all items at once
- Review and submit all defects in one go

### Defect History
- View all reported defects
- Filter by status (Outstanding / Completed)
- Search by keyword

### Dashboard
- Total / Outstanding / Resolved counts
- Today's submissions

### Offline Support
- App loads without internet (cached shell)
- Defects saved locally when offline
- Auto-syncs when connectivity returns

### Category System

| Group | Categories |
|-------|-----------|
| Structural | Column, Beam, Slab, Foundation, Retaining Wall |
| Architectural | Door, Window, Wall, Floor, Ceiling, Roof, Staircase, Fence/Railing, Balcony, Corridor |
| Carpentry | Cabinet, Wardrobe, Countertop, Skirting, Shelf |
| M&E | Plumbing, Electrical, Aircon, Lighting, Sanitary, Fire Safety |
| Finishes | Painting, Tiling, Waterproofing, Plastering |
| External | Driveway, Walkway, Garden, Drain/Gutter, Car Park, Swimming Pool, Playground |
| General | General |

Each category auto-assigns a responsible trade (Plumber, Electrician, Carpenter, etc.)

---

## File Structure

```
PWA/
  index.html              # App shell - all 8 views
  manifest.json           # PWA manifest (installable)
  sw.js                   # Service Worker (offline + caching)
  css/
    style.css             # Mobile-first responsive CSS
  js/
    app.js                # Main app (824 lines) - camera, voice, AI, sync
  icons/
    icon-192.svg          # App icon 192x192
    icon-512.svg          # App icon 512x512
  backend/
    google_apps_script.js # Apps Script backend (paste into Google Sheet)
  .github/
    workflows/
      deploy.yml          # Auto-deploy to GitHub Pages on push
```

---

## Tech Stack

| Component | Technology | Why |
|-----------|-----------|-----|
| Frontend | Vanilla JS (no framework) | Zero build step, <50KB total, instant load |
| Styling | CSS (custom) | Mobile-first, safe-area aware, dark-mode ready |
| Voice | Web Speech API | Free, zero-download, works in Chrome/Safari |
| Camera | HTML5 MediaCapture | Native camera access, no plugin |
| AI Vision | Gemini 2.0 Flash | Best free vision AI (1M tokens/day) |
| Backend | Google Apps Script | Serverless, free, handles Sheets + Drive + Gemini |
| Database | Google Sheets | Free, shareable, live dashboard |
| Storage | Google Drive | Free 15GB, shareable photo URLs |
| Hosting | GitHub Pages | Free, global CDN, auto-HTTPS |
| Offline | Service Worker + localStorage | Cache-first, works without internet |

---

## Contributing

1. Fork this repo
2. Make changes
3. Push to your fork - GitHub Actions auto-deploys to Pages
4. Test at `https://YOUR_USERNAME.github.io/PWA/`

---

## License

MIT
