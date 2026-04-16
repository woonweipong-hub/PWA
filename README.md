# SiteShrimp

<p align="center">
  <img src="icons/icon-512.png" alt="SiteShrimp" width="120"/>
</p>

<p align="center">
  <strong>Construction site works, defects and items tracking and monitoring for teams that deliver.</strong>
</p>

<p align="center">
  <a href="https://siteshrimp.org">siteshrimp.org</a> · Free for all teams · No app store needed
</p>

---

## Quick Start

### For site workers (30 seconds)

1. Open **https://siteshrimp.org** on your phone
2. Tap **INSTALL APP** (or Add to Home Screen)
3. Sign up with email, join or create a company
4. Start logging

### For admins (5 minutes)

1. Sign up and create a company
2. Tap the **⚙ Settings** dropdown in the top bar — it shows a progress badge (e.g. `0/4`) so you know what's still to configure
3. Under **PROJECT**: create a project, invite team members
4. Under **ENHANCE** (all optional):
   - **AI Setup** — choose Gemini, Ollama, or OpenAI for photo analysis and natural-language search
   - **Telegram Alerts** — bot token + chat ID for team notifications
   - **Storage** — PocketBase (default), local path, or Google Drive
5. **Email reports** are configured from the **Report** tab (click EMAIL REPORT → Setup)

When every item shows a green ✓, the setup badge disappears.

---

## Navigation

**Top bar (3 controls):**

- **Project selector** — tap to switch active project
- **⚙ Settings** — all one-time setup in one dropdown (Projects, Team, AI, Telegram, Storage). Shows a setup-progress badge.
- **W Avatar** — Profile, Admin Analytics (admin only), Help, Feedback, Sign Out

**Bottom nav (5 tabs) — operational flow:**

`Dashboard → Log → 📐 Tag → Review → Report`

1. **Dashboard** — see project state at a glance
2. **Log** — capture a new entry (defect, observation, update, instruction)
3. **Tag** (Tag & Compare) — upload PDFs/images, tag pins, overlay photos, compare revisions
4. **Review** — triage, update status, verify, close. AI natural-language search lives here.
5. **Report** — filtered stats, charts, EXPORT and email report

**Inline AI Query bar** — a one-tap query row shown under the header on Dashboard and Report, opening natural-language search across all entries (disabled with a hint when AI isn't configured).

---

## Features (130+)

### Entry Logging

| Feature | Description |
|---------|-------------|
| **7 Work Categories** | Building Defects (Landed), Building Defects (Highrise), Construction Site, Interior Works, Facilities Management, Infrastructure Works (Roads/Drainage/Linkway), Others — each filters the Component dropdown to just the relevant groups so users aren't flooded with irrelevant items. Last-used category is remembered per device. |
| **4 Default Entry Types** | Defect, Observation, Update, Instruction |
| **Custom Entry Types** | Create your own (Site Checks, Safety Audit, Snag List, etc.) — icon + color picker, shared across team |
| **Component + Issue Selector** | 158 building/infra components across 19 groups, 296 unique predefined issues — tap to select, minimal typing. Includes Roads, Drainage, Linkway, Site & Safety, and FM (Building Services, Common Areas, Amenities). All translated in 23 languages. |
| **Low-friction Submit** | A description **or** a photo is enough — title and location are auto-generated so field users can capture first and fill the rest later via Review comments |
| **AI Photo Analysis** | Snap a photo, AI auto-fills title, severity, description |
| **AI Trade + Assignee Suggestion** | Auto-assigns a trade and suggested assignee from the analyzed photo |
| **AI Safety Risk Scoring** | Auto-escalates entries to Critical when safety risk is detected |
| **3 AI Providers** | Google Gemini (free cloud), Ollama (local/private), OpenAI/GPT (or compatible) |
| **Duplicate Detection** | Similarity check on submit to catch near-duplicates |
| **Multi-Photo** | Up to 10 photos per entry, auto-compressed for fast upload |
| **Photo Markup Editor** | Draw arrows, circles, freehand, and text on photos — scaled correctly on save |
| **Voice Input** | Hold mic button, speak to fill any text field |
| **Location Hierarchy** | Level > Zone > Room/Area > Grid — predefined dropdowns |
| **Batch Logging** | Log multiple entries at same location — carries forward level, zone, component |
| **Cost Tracking** | Impact type, responsible party, amount, supporting docs |
| **Time Tracking** | Target date, estimated duration, actual completion |

### Entry Management

| Feature | Description |
|---------|-------------|
| **5-Status Workflow** | Open → In Progress → Done → Verified → Closed |
| **Full-text Search** | Search entries with keyword highlighting |
| **AI Natural Language Search** | Voice or text — "show me all critical plumbing open this week" |
| **Filters** | Status, severity, entry type (with clear button) |
| **Batch Update** | Select multiple entries after filtering and update Status, Severity, Assignee, Duration or Target Date in one go — blank fields are left untouched, Telegram sends a single batch alert |
| **Entry Type Badges** | Color-coded type badges on list and detail views |
| **Verification Photo** | Required photo when closing / verifying an entry |
| **Before / After Slider** | Compare the original photo with the verification photo |
| **Resolution Timeline** | Visual, color-coded history of every status change |
| **Comments** | Team discussion thread (text + voice + photos) |
| **Comment Photo Markup** | Tap to annotate photos right from the comment thread |
| **Inline Comment Editing** | Edit your own comments (with edited indicator) |
| **Quick Reactions** | Thumbs, check, warn, fix emoji reactions |
| **Telegram Alerts** | New entries, status changes, comments sent to team group |

### Tag & Compare (Drawings)

| Feature | Description |
|---------|-------------|
| **Upload Formats** | JPG, PNG, WEBP, TIFF, PDF (multi-page via PDF.js) |
| **Zoom / Pan / Pinch-to-Zoom** | Mobile and desktop friendly |
| **Defect Pins** | Ring-style markers with severity initial, tooltip with entry details |
| **Critical Pin Pulse** | Animated ring for open Critical pins |
| **Quick-Pin** | Create a new entry directly from a tap on the drawing |
| **Defect Heatmap** | Severity-weighted radial overlay across the drawing |
| **Drawing Markup** | Freehand, arrows, circles, and text notes per drawing |
| **Color Picker + Undo/Clear** | Full markup control |
| **Drawing Notes** | Pinned text notes with author + timestamp |
| **PDF Thumbnails** | Preview cards with pin counts and severity badges |
| **Photo Overlay (Compare)** | Capture or pick a site photo and overlay it on the PDF diff — drag to reposition, ± to resize, markup on top |

### PDF Diff & Batch Comparison

| Feature | Description |
|---------|-------------|
| **Single PDF Diff** | Compare two drawings revision-to-revision with added/removed line detection |
| **Diff Overlay** | Visual color overlay showing what changed between base and revision |
| **Compare Markup** | Draw on top of the diff — freehand, arrow, circle, text |
| **Select / Move / Delete** | Grab any stroke with the Select tool, drag to reposition, delete individually |
| **Text Size Presets** | Four sizes (S / M / L / XL) apply to new text or retarget the selected stroke |
| **9-Way Text Alignment** | Horizontal + vertical alignment via a single 3×3 grid menu (top-left … bottom-right) |
| **Color Retarget** | Color picker also recolors the selected stroke, not just new ones |
| **AI Diff Report** | Generate a written compliance/coordination summary of the changes |
| **Lock / Approve AI Report** | Audit trail of lock/unlock with reason + user |
| **Save Comparisons** | Comparisons persist per-project with overlay thumbnails (markup composited in) |
| **Batch Folder Comparison** | Diff two folders of PDFs (Tender vs As-Built, M&E vs Arch, etc.) |
| **Completeness Check** | Flags missing / extra files between sets |
| **Editable Set Labels** | Name each set (Tender, As-Built, M&E, Revision A, etc.) |
| **Diff Dropdown** | Single (PDFs Comparison) and Batch (Folders Comparison) in one menu |

### Dashboard & Analytics

| Feature | Description |
|---------|-------------|
| **Dashboard** | Status cards (5 stages), severity chart, critical alerts, recent entries |
| **Live Sync** | All team members see updates instantly via PocketBase SSE |
| **Offline Queue Badge** | Header and Dashboard show queued offline entries |
| **Admin Analytics** | Entries today/week/month, per-user rankings, photo stats, by entry type, by project, AI usage |

### Reports & Exports

| Feature | Description |
|---------|-------------|
| **Site Report** | Filtered statistics with severity/status charts |
| **Section-Aware Tally** | Stats panel shows separate tallies per selected section (defects, drawings, comparisons) with section-appropriate colors. Severity/status breakdowns only shown when defects are included. |
| **Filters** | Severity, status, assignee, and date range |
| **Email Reports** | HTML report via EmailJS with per-section opt-in (Defects / Drawings / Comparisons). All values translated to user's language. |
| **Email Preview** | See exactly what will go out before sending |
| **Contract Advisor** | AI-powered defect-to-clause mapping using PSSCOC/REDAS/SIA contract PDFs with risk notes and recommended next steps |
| **Google Sheets Export** | Push report data directly to a Google Spreadsheet (new tab per export) |
| **EXPORT (all-in-one CSV)** | Single tap from Report — combined CSV with defect entries, drawing annotations (notes + markup counts), and saved PDF comparisons |
| **Dn Menu — Markup CSV / PDF** | Export all drawing annotations |
| **Dn Menu — Compare CSV / PDF** | Export saved PDF comparisons |
| **Dn Menu — All CSV / PDF** | Combined drawings + comparisons export |
| **Dn Menu — All-in-One** | CSV and PDF in a single tap |
| **Annotated Drawings in PDF** | Markup, Compare, and All PDF exports embed rendered drawing pages with pins, notes and markup burned in (not just tables) |
| **Per-Drawing PDF** | Export a single drawing's annotated pages + annotation list from the viewer |

### Multi-Language (22 Languages)

| Feature | Description |
|---------|-------------|
| **22 Languages** | English, 简体中文, 繁體中文, Bahasa Melayu, Bahasa Indonesia, हिन्दी, தமிழ், ไทย, Tiếng Việt, বাংলা, 日本語, 한국어, Deutsch, Français, Español, Português, Italiano, Türkçe, Svenska, Norsk, Dansk, Suomi |
| **Full UI Translation** | 617 UI keys — every label, button, placeholder, status, nav item, error message |
| **Dropdown Translation** | 539 construction terms (components, issues, levels, zones, rooms, durations, costs, entry types) displayed in user's language while stored in English |
| **Language Selector** | Settings → Language with flag + native name |
| **Instant English** | English inlined for zero-delay render; other languages lazy-loaded |

### Storage Options

| Mode | Description |
|------|-------------|
| **PocketBase (default)** | Photos stored on your PocketBase server |
| **Local Path** | Store photos to a folder on your server/laptop/machine |
| **Google Drive** | OAuth2 — photos upload to your personal Drive |

### Team & Access

| Feature | Description |
|---------|-------------|
| **Multi-tenant** | Each company has isolated data |
| **Role-based Access** | Admin, Manager, Inspector, Viewer with granular permissions |
| **Multi-project** | Each company manages multiple projects, archive / restore |
| **Invite System** | Invite via link + code, assign role on join |
| **Team Management** | Admins can edit roles and remove members |

### Offline & Installation

| Feature | Description |
|---------|-------------|
| **Installable** | Add to home screen, works like native app |
| **Offline Shell** | App shell cached via service worker |
| **Offline Queue** | Save entries to IndexedDB when offline, auto-sync when back online |
| **Manual Sync** | Tap the queued badge to force sync |
| **Server URL Config** | Point at your own PocketBase instance |

### Account & Settings

| Feature | Description |
|---------|-------------|
| **Profile Editing** | Display name, job title, email, password |
| **Integration Settings** | Telegram, AI (multi-provider), Email, Storage — each with test button |
| **Daily AI Usage Limit** | Per-company cap to control cost |
| **Help Guide + Feature List** | In-app reference with live feature count |
| **Feedback Form** | Send suggestions, bugs, or praise from inside the app |

---

## Architecture

```
Phone (SiteShrimp)              Services
+------------------+            +---------------------------+
|  React 18 (JSX)  |            |  PocketBase               |
|  Babel (browser) |----------->|    Auth + DB + Files      |
|  Service Worker  |            +---------------------------+
|  PDF.js          |            |  AI (pick one)            |
+------------------+            |    Gemini / Ollama / GPT  |
       |                        +---------------------------+
       |  Photo + Voice ------->|  Storage (pick one)       |
       |                        |    PocketBase / Local /   |
       |                        |    Google Drive           |
       |                        +---------------------------+
       |                        |  Telegram Bot API         |
       |  Notifications ------->|    (team alerts)          |
       |                        +---------------------------+
       |                        |  EmailJS                  |
       +--- Email reports ----->|    (HTML reports)         |
                                +---------------------------+
```

---

## Tech Stack

| Layer | Technology | Cost |
|-------|-----------|------|
| Frontend | React 18 + Babel (in-browser JSX) | Free |
| PDF Rendering | PDF.js | Free |
| Backend | PocketBase (self-hosted) | Free |
| Auth | PocketBase built-in (email/password) | Free |
| Database | PocketBase (SQLite) | Free |
| File Storage | PocketBase / Local path / Google Drive | Free |
| AI | Gemini (free) / Ollama (free, local) / OpenAI (pay-per-use) | Free* |
| Voice | Web Speech API | Free (browser built-in) |
| Notifications | Telegram Bot API | Free |
| Email | EmailJS | Free (200/month) |
| Hosting | GitHub Pages | Free |
| **Total** | — | **$0/month** |

OpenAI requires a paid API key. Gemini and Ollama are free.

---

## Integrations Setup

### AI Photo Analysis (choose one)

All AI, Telegram, and Storage setup lives under the **⚙ Settings** dropdown in the top bar.

**Google Gemini (free, cloud)**
1. Go to **https://aistudio.google.com/apikey** → Create API key
2. In the app: ⚙ Settings → AI Setup → select Gemini → paste key → Save

**Ollama (free, local/private)**
1. Install Ollama from **https://ollama.com**
2. Pull a vision model: `ollama pull llava` (or `qwen2.5-vl`, `llama3.2-vision`)
3. In the app: ⚙ Settings → AI Setup → select Ollama → enter server URL → Save

**OpenAI / GPT (paid)**
1. Get API key from **https://platform.openai.com**
2. In the app: ⚙ Settings → AI Setup → select OpenAI → enter API key + model → Save
3. Also works with LM Studio, Azure OpenAI, Together AI, or any OpenAI-compatible endpoint

### Storage (choose one)

**PocketBase (default)** — no setup needed, photos stored on your server

**Local Path** — for self-hosted setups:

1. ⚙ Settings → Storage → select Local Path
2. Enter folder path (e.g. `/opt/siteshrimp/photos`)
3. Test path → Save

**Google Drive** — for mobile users:

1. Create OAuth Client ID at **https://console.cloud.google.com**
2. ⚙ Settings → Storage → select Google Drive → paste Client ID → Connect

### Telegram Notifications

1. Create a bot via **@BotFather** on Telegram
2. Get your group's Chat ID (add @userinfobot to group)
3. In the app: ⚙ Settings → Telegram Alerts → enter Bot Token + Chat ID → Save

### EmailJS (reports)

Email reports are configured from the **Report** tab (keeps sending and configuration in one place).

1. Sign up at **https://www.emailjs.com/**
2. Create a service + template (set body to `{{{html_content}}}`)
3. In the app: Report tab → EMAIL REPORT button → Setup → enter IDs → Save

---

## Data Model (PocketBase)

**12 collections:** `defects`, `companies`, `members`, `projects`, `invites`, `settings`, `activity`, `location_presets`, `component_presets`, `drawings`, `pins`, `counters`

Saved PDF comparisons and drawing markup/notes are stored client-side in `localStorage` per project and are included in exports.

### Entry fields

```
defects: {
  entryType, title, description, severity, status,
  component, locationLevel, locationZone, locationSubzone, locationGrid,
  photo (up to 10), photoOriginal, assignee, assigneeId, dueDate, duration, actualCompleted,
  costImpact, costResponsible, costAmount, costDoc, costRemarks,
  loggedBy, loggedByRole, projectId, projectName, companyId,
  storageMode, storagePath, gdrivePhotos, drawingPinId,
  comments, createdAt, updatedAt, closedAt, verifiedAt, verifiedBy
}
```

### Role Permissions

| Action | Admin | Manager | Inspector | Viewer |
|--------|-------|---------|-----------|--------|
| Create entries | Yes | Yes | Yes | No |
| Create instructions | Yes | Yes | No | No |
| Update entries | Yes | Yes (all) | Own only | No |
| Delete entries | Yes | No | No | No |
| Change status | All | Forward only | Forward only | No |
| Verify / Close | Yes | Verify only | No | No |
| Manage team | Yes | No | No | No |
| Manage projects | Yes | Yes | No | No |
| Place drawing pins | Yes | Yes | Yes | No |
| Export | Yes | Yes | No | No |
| Comment | Yes | Yes | Yes | No |
| View admin analytics | Yes | No | No | No |

---

## File Structure

```
SiteShrimp/
  index.html              # App shell + CDN libs (React, Babel, PDF.js, EmailJS)
  js/
    app.js                # React components + business logic (source JSX)
    app.compiled.js       # Babel-compiled output (served to browser)
    constants.js          # Entry types, components, issues, locations, statuses
    db.js                 # PocketBase data layer + Google Drive module
    lang.js               # i18n helper — t(), tOpt(), language loading
  lang/
    en.json ... fi.json   # 23 language packs (1,158 keys each)
  manifest.json           # Install config
  sw.js                   # Service worker (offline cache)
  icons/
    icon-192.png          # App icon (192x192)
    icon-512.png          # App icon (512x512)
  deploy/
    pocketbase/
      setup.sh            # VM setup script
      setup_https.sh      # HTTPS with Caddy + DuckDNS
      backup.sh           # Daily backup to Google Drive
      restore.sh          # Restore from backup
      pb_schema.json      # Full PocketBase schema (12 collections)
      pb_hooks/main.pb.js # Server hooks (auto-ID, AI analysis, local storage)
```

---

## Deployment

The app is deployed automatically via GitHub Pages (see `.github/workflows/deploy.yml`). Push to `main` and the site updates.

**Backend:** PocketBase runs on a GCP VM with Caddy for HTTPS.

### Server-side AI (PocketBase hooks)

The server hook supports all three AI providers via environment variables:

| Variable | Description |
|----------|-------------|
| `AI_PROVIDER` | `gemini` (default), `ollama`, or `openai` |
| `GEMINI_API_KEY` | Gemini API key |
| `OLLAMA_URL` | Ollama server URL (e.g. `http://localhost:11434`) |
| `OLLAMA_MODEL` | Ollama model name (default: `llava`) |
| `OPENAI_API_KEY` | OpenAI API key |
| `OPENAI_URL` | OpenAI-compatible base URL (default: `https://api.openai.com`) |
| `OPENAI_MODEL` | Model name (default: `gpt-4o-mini`) |

---

## Roadmap

### Ideas
- [ ] QR code scanning for location / asset tagging
- [ ] Integration with project management tools (Procore, Aconex)
- [ ] Handover checklist templates
- [ ] Automated follow-up reminders (overdue entries)
- [ ] Per-page markup tracking on multi-page drawings
- [ ] Push notifications (browser push for status changes and comments)
- [ ] Full audit trail view (who changed what and when) beyond comparison locks
- [ ] Dark mode
- [ ] Recurring inspection schedules
- [ ] Saved filter presets in Review

Most of the original roadmap (drawings/pins, photo annotation, PDF reports, offline queue, search, profile editing, location/component presets, multi-language, Google Sheets export) has already shipped — see the Features list above.

---

## License

Free of Charge (FoC) for all users globally. Private source code.
