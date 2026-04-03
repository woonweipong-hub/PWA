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
2. Set up integrations (header icons):
   - **AI** (robot icon) — choose Gemini, Ollama, or OpenAI for photo analysis
   - **Telegram** (plane icon) — bot token + chat ID for team notifications
   - **Storage** (server icon) — PocketBase (default), local path, or Google Drive
   - **Email** — EmailJS for HTML reports (Profile > Email Report Settings)
3. Create projects, invite team members via invite link

---

## Features (65+)

### Entry Logging

| Feature | Description |
|---------|-------------|
| **4 Default Entry Types** | Defect, Observation, Update, Instruction |
| **Custom Entry Types** | Create your own (Site Checks, Safety Audit, Snag List, etc.) — shared across team |
| **Component + Issue Selector** | 93 building components, 517 predefined issues — tap to select, minimal typing |
| **AI Photo Analysis** | Snap a photo, AI auto-fills title, severity, description |
| **3 AI Providers** | Google Gemini (free cloud), Ollama (local/private), OpenAI/GPT (or compatible) |
| **Multi-Photo** | Up to 10 photos per entry, compressed for fast upload |
| **Voice Input** | Hold mic button, speak to fill any text field |
| **Location Hierarchy** | Level > Zone > Room/Area > Grid — predefined dropdowns |
| **Batch Logging** | Log multiple entries at same location — carries forward level, zone, component |
| **Cost Tracking** | Impact type, responsible party, amount, supporting docs |
| **Time Tracking** | Target date, estimated duration |

### Entry Management

| Feature | Description |
|---------|-------------|
| **5-Status Workflow** | Open > In Progress > Done > Verified > Closed |
| **Filters** | Filter by status, severity, and entry type |
| **Entry Type Badges** | Color-coded type badges on list and detail views |
| **Comments** | Team discussion thread on each entry (text + voice) |
| **Telegram Alerts** | New entries, status changes, comments sent to team group |

### Dashboard & Analytics

| Feature | Description |
|---------|-------------|
| **Dashboard** | Status cards, severity chart, critical alerts, recent entries |
| **Admin Analytics** | Entries by day/week/month, per-user rankings, photos stats, by project, AI usage |
| **Live Sync** | All team members see updates instantly via PocketBase SSE |

### Reports

| Feature | Description |
|---------|-------------|
| **Site Report** | Filtered statistics with severity/status charts |
| **CSV Export** | Download filtered entries for Excel / Google Sheets |
| **Email Reports** | Filtered HTML report sent to multiple recipients via EmailJS |

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
| **Multi-project** | Each company manages multiple projects |
| **Invite System** | Invite via link + code, assign role on join |

### Installation & Offline

| Feature | Description |
|---------|-------------|
| **Installable** | Add to home screen, works like native app |
| **Offline Shell** | App shell cached via service worker, works without internet |
| **Server URL Config** | Point at your own PocketBase instance |

---

## Architecture

```
Phone (SiteShrimp)              Services
+------------------+            +---------------------------+
|  React 18 (JSX)  |            |  PocketBase               |
|  Babel (browser) |----------->|    Auth + DB + Files       |
|  Service Worker  |            +---------------------------+
+------------------+            |  AI (pick one)            |
       |                        |    Gemini / Ollama / GPT  |
       |  Photo + Voice ------->|                           |
       |                        +---------------------------+
       |                        |  Storage (pick one)       |
       |  Photos -------------->|    PocketBase / Local /   |
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
| Backend | PocketBase (self-hosted) | Free |
| Auth | PocketBase built-in (email/password) | Free |
| Database | PocketBase (SQLite) | Free |
| File Storage | PocketBase / Local path / Google Drive | Free |
| AI | Gemini (free) / Ollama (free, local) / OpenAI (pay-per-use) | Free* |
| Voice | Web Speech API | Free (browser built-in) |
| Notifications | Telegram Bot API | Free |
| Email | EmailJS | Free (200/month) |
| Hosting | GitHub Pages | Free |
| **Total** |  | **$0/month** |

OpenAI requires a paid API key. Gemini and Ollama are free.

---

## Integrations Setup

### AI Photo Analysis (choose one)

**Google Gemini (free, cloud)**
1. Go to **https://aistudio.google.com/apikey** → Create API key
2. In the app: tap AI icon (header) → select Gemini → paste key → Save

**Ollama (free, local/private)**
1. Install Ollama from **https://ollama.com**
2. Pull a vision model: `ollama pull llava` (or `qwen2.5-vl`, `llama3.2-vision`)
3. In the app: tap AI icon → select Ollama → enter server URL → Save

**OpenAI / GPT (paid)**
1. Get API key from **https://platform.openai.com**
2. In the app: tap AI icon → select OpenAI → enter API key + model → Save
3. Also works with LM Studio, Azure OpenAI, Together AI, or any OpenAI-compatible endpoint

### Storage (choose one)

**PocketBase (default)** — no setup needed, photos stored on your server

**Local Path** — for self-hosted setups:
1. Tap storage icon (header) → select Local Path
2. Enter folder path (e.g. `/opt/siteshrimp/photos`)
3. Test path → Save

**Google Drive** — for mobile users:
1. Create OAuth Client ID at **https://console.cloud.google.com**
2. Tap storage icon → select Google Drive → paste Client ID → Connect

### Telegram Notifications

1. Create a bot via **@BotFather** on Telegram
2. Get your group's Chat ID (add @userinfobot to group)
3. In the app: tap Telegram icon (header) → enter Bot Token + Chat ID → Save

### EmailJS (reports)

1. Sign up at **https://www.emailjs.com/**
2. Create a service + template (set body to `{{{html_content}}}`)
3. In the app: Profile → Email Report Settings → enter IDs → Save

---

## Data Model (PocketBase)

**12 collections:** defects, companies, members, projects, invites, settings, activity, location_presets, component_presets, drawings, pins, counters

### Entry fields

```
defects: {
  entryType, title, description, severity, status,
  component, locationLevel, locationZone, locationSubzone, locationGrid,
  photo (up to 10), assignee, dueDate, duration,
  costImpact, costResponsible, costAmount, costDoc, costRemarks,
  loggedBy, loggedByRole, projectId, projectName, companyId,
  storageMode, storagePath, gdrivePhotos,
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
| Export | Yes | Yes | No | No |
| Comment | Yes | Yes | Yes | No |
| View admin analytics | Yes | No | No | No |

---

## File Structure

```
SiteShrimp/
  index.html              # App shell + CDN libs
  js/
    app.js                # React components + business logic
    constants.js          # Entry types, components, issues, locations, statuses
    db.js                 # PocketBase data layer + Google Drive module
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

### Coming Soon
- [ ] Drawings / floor plan pins — tap on a drawing to place defect pins
- [ ] Profile editing — update name, job title, avatar
- [ ] Search across entries — full-text search with filters
- [ ] Offline submission queue — log entries offline, auto-sync when back online
- [ ] Push notifications — browser push for status changes and comments
- [ ] Location presets per project — save and reuse custom location hierarchies
- [ ] Component presets per project — save and reuse custom component lists
- [ ] Photo annotation — draw on photos to highlight defects
- [ ] PDF report generation — downloadable formatted reports
- [ ] Audit trail — full history of who changed what and when

### Ideas
- [ ] QR code scanning for location/asset tagging
- [ ] Integration with project management tools (Procore, Aconex)
- [ ] Multi-language support (Mandarin, Malay, Tamil, Thai)
- [ ] Handover checklist templates
- [ ] Automated follow-up reminders (overdue entries)

---

## License

Free of Charge (FoC) for all users globally. Private source code.
