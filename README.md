# SiteSnag - Construction Defect Reporter

**Snap. Speak. Done.**

A zero-cost mobile app for construction defect tracking. Snap photos, speak descriptions, and AI classifies everything. Defects sync to your Google Sheet with photos in Google Drive.

No app store. No account. No cost. Open the link on your phone, add to home screen, done.

---

## How to Get the App (for site workers)

1. Open **https://woonweipong-hub.github.io/PWA/** on your phone
2. **Android**: Tap menu (3 dots) > **"Add to Home Screen"**
3. **iPhone**: Tap Share icon > **"Add to Home Screen"**
4. Open the app from your home screen
5. Enter your name and the **Apps Script URL** (your PM will give you this)
6. Start reporting defects

---

## How to Set Up the Backend (for PMs / admins)

Everything runs on free Google services. Follow these 5 steps once, then share the link with your whole team.

### Step 1: Create a Google Spreadsheet

1. Go to **https://sheets.google.com**
2. Click **+ Blank** to create a new spreadsheet
3. Name it anything (e.g. "SiteSnag Defects")
4. Keep this tab open — you'll need it next

### Step 2: Open Apps Script

1. In your new spreadsheet, click **Extensions** (top menu)
2. Click **Apps Script**
3. A new tab opens with a code editor

### Step 3: Paste the backend code

1. In the Apps Script editor, **select all** the existing code and **delete it**
2. Open this file: **[backend/google_apps_script.js](backend/google_apps_script.js)**
3. Click the **Raw** button (or select all the code)
4. **Copy** all the code
5. **Paste** it into the Apps Script editor
6. Click the **Save** icon (floppy disk) or press Ctrl+S

### Step 4: Run setup

1. In the Apps Script editor, find the **function dropdown** (it says "setup" or "myFunction")
2. Select **`setup`** from the dropdown
3. Click the **Run** button (play icon)
4. Google will ask you to **authorize** — click "Review Permissions" > choose your account > "Allow"
5. The setup wizard will prompt you:
   - **Sheet URL**: Just press OK (it auto-detects the current sheet)
   - **Drive folder**: It auto-creates a "SiteSnag Photos" folder for you
   - **Gemini API key**: Paste your key (see below), or press Cancel to skip

> **To get a free Gemini API key** (enables AI photo analysis):
> 1. Go to **https://aistudio.google.com/apikey**
> 2. Click **"Create API Key"**
> 3. Copy the key and paste it when setup asks

6. Check the **Execution Log** at the bottom — you should see:
```
=== SiteSnag Setup Test ===
Sheet OK: SiteSnag Defects / Sheet1 (0 rows)
Drive OK: SiteSnag Photos
Gemini key: SET (AIza...)
=== Test Complete ===
```

### Step 5: Deploy and get your URL

1. Click **Deploy** (top right) > **New deployment**
2. Click the gear icon next to "Select type" > choose **Web app**
3. Set:
   - Description: `SiteSnag v1` (or anything)
   - Execute as: **Me**
   - Who has access: **Anyone**
4. Click **Deploy**
5. Click **Copy** next to the Web App URL

Your URL looks like:
```
https://script.google.com/macros/s/AKfycbx.../exec
```

**This is your Apps Script URL. Save it — you'll share it with your team.**

### Step 6: Share with your team

Send your team this link (replace with your actual Apps Script URL):

```
https://woonweipong-hub.github.io/PWA/?api=https://script.google.com/macros/s/AKfycbx.../exec
```

Workers open the link, enter their name, tap "Add to Home Screen" — and they're ready to report defects. No setup, no config.

You can also **print a QR code** from this URL and stick it on the site notice board.

---

## How It Works

```
Your Phone                         Google (free)
+------------------+               +-----------------------------+
|                  |               |                             |
|  Tap camera      |----photo---->|  Google Apps Script          |
|  Hold mic button |----voice---->|    |                         |
|  Type notes      |----text----->|    +--> Gemini AI (analyze)  |
|                  |               |    +--> Google Sheets (log)  |
|  "DEF-0042       |<---result----|    +--> Google Drive (photo)  |
|   Crack, Bedroom |               |                             |
|   Severity: High"|               +-----------------------------+
|                  |
|  Tap Confirm     |
+------------------+
```

| What you do | What happens behind the scenes | Cost |
|---|---|---|
| Take photo | Saved to Google Drive, permanent link | Free (15 GB) |
| Hold mic & speak | Web Speech API transcribes to text | Free (browser built-in) |
| Tap "Analyze with AI" | Gemini 2.5 Flash classifies the defect | Free (15 req/min) |
| Tap "Submit" | Row added to your Google Sheet | Free |
| Open app offline | Cached locally, syncs when online | Free |

**Total cost: $0/month** for unlimited users.

---

## Features

| Feature | Description |
|---------|-------------|
| **Report Defect** | Photo + voice + AI analysis in one flow |
| **Site Walk** | Batch capture: walk through site snapping photos and speaking, process all at once |
| **History** | View all defects, filter by status/severity, search |
| **Dashboard** | Total, outstanding, resolved, today's count |
| **Offline** | Works without internet, syncs when back online |
| **AI Classification** | 35 categories, 200+ defect types, auto-assigns trade |
| **Voice Input** | Hold button to speak, real-time transcription |
| **Installable** | Add to home screen, works like a native app |
| **Viral Sharing** | Share a link or QR code, no account needed |

### Defect Categories

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
  index.html                # App (all screens in one file)
  manifest.json             # Makes it installable on phones
  sw.js                     # Offline support
  css/style.css             # Mobile-first styling
  js/app.js                 # All app logic (camera, voice, AI, sync)
  icons/icon-192.svg        # App icon
  icons/icon-512.svg        # App icon (large)
  backend/
    google_apps_script.js   # Backend code (paste into Google Sheet)
```

---

## Tech Stack

| Layer | Technology | Why this one |
|-------|-----------|-------------|
| App | Vanilla JS PWA | No build step, <50KB, instant load on 3G |
| Voice | Web Speech API | Free, runs in browser, no server needed |
| Camera | HTML5 capture | Native phone camera, no plugin |
| AI | Gemini 2.5 Flash | Best free vision AI (1M tokens/day) |
| Backend | Google Apps Script | Free serverless, no server to manage |
| Database | Google Sheets | Free, shareable, live data |
| Photos | Google Drive | Free 15GB, shareable links |
| Hosting | GitHub Pages | Free, global CDN, HTTPS |

---

## License

MIT
