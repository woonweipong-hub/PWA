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
   - **AI** — Gemini API key for photo analysis (free at aistudio.google.com/apikey)
   - **Telegram** — bot token + chat ID for team notifications
   - **Email** — EmailJS for HTML reports
3. Create projects, invite team members via invite link

---

## Features

| Feature | Description |
|---------|-------------|
| **Entry Types** | Observations, Defects, Updates, Instructions — not just defects |
| **Component + Issue Selection** | 93 building components, 517 predefined issues — tap to select, minimal typing |
| **AI Photo Analysis** | Snap a photo, Gemini auto-fills title, severity, description |
| **Multi-Photo** | Up to 5 photos per entry |
| **Voice Input** | Hold mic button, speak to fill any text field |
| **Location Hierarchy** | Level > Zone > Room/Area > Grid — predefined dropdowns |
| **5-Status Workflow** | Open > In Progress > Done > Verified > Closed |
| **Cost Tracking** | Impact (incl. TBC by QS), responsible party, supporting docs |
| **Time Tracking** | Target date, estimated duration |
| **Real-time Sync** | All team members see updates instantly via PocketBase SSE |
| **Multi-tenant** | Each company has isolated data |
| **Role-based Access** | Admin, Manager, Inspector, Viewer with granular permissions |
| **Multi-project** | Each company manages multiple projects |
| **Telegram Alerts** | New entries, status changes, comments sent to team group |
| **Email Reports** | Filtered HTML report sent to multiple recipients |
| **CSV Export** | Download filtered entries for Excel / Google Sheets |
| **Batch Logging** | Log multiple entries at same location — carries forward level, zone, component |
| **Comments** | Team discussion thread on each entry |
| **Installable** | Add to home screen, works like native app |
| **Offline Support** | App shell cached, works without internet |
| **Dashboard** | Status cards, severity chart, critical alerts, recent entries |

---

## Architecture

```
Phone (SiteShrimp)              Cloud Services (all free tier)
+------------------+            +---------------------------+
|  React 18 (JSX)  |            |  PocketBase               |
|  Babel (browser) |----------->|    Auth (email/password)  |
|  Service Worker  |            |    Database + File storage|
+------------------+            +---------------------------+
       |                        |  Google Gemini AI         |
       |  Photo + Voice ------->|    (photo analysis)       |
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
| Backend | PocketBase (self-hosted on GCP VM) | Free |
| Auth | PocketBase built-in (email/password) | Free |
| Database | PocketBase (SQLite) | Free |
| File Storage | PocketBase (photos, docs on VM disk) | Free |
| AI | Google Gemini 2.5 Flash | Free (1,500/day) |
| Voice | Web Speech API | Free (browser built-in) |
| Notifications | Telegram Bot API | Free |
| Email | EmailJS | Free (200/month) |
| Hosting | GitHub Pages | Free |
| **Total** | | **$0/month** |

---

## Integrations Setup

### Gemini AI (photo analysis)

1. Go to **https://aistudio.google.com/apikey**
2. Create API key
3. In the app: tap AI icon (header) > paste key > Save

### Telegram Notifications

1. Create a bot via **@BotFather** on Telegram
2. Get your group's Chat ID (add @userinfobot to group)
3. In the app: tap Telegram icon (header) > enter Bot Token + Chat ID > Save

### EmailJS (reports)

1. Sign up at **https://www.emailjs.com/**
2. Create a service + template (set body to `{{{html_content}}}`)
3. In the app: Profile > Email Report Settings > enter IDs > Save

---

## Data Model (PocketBase)

**12 collections:** defects, companies, members, projects, invites, settings, activity, location_presets, component_presets, drawings, pins, counters

### Entry fields

```
defects: {
  entryType, title, description, severity, status,
  component, locationLevel, locationZone, locationSubzone, locationGrid,
  photo (up to 5), assignee, dueDate, duration,
  costImpact, costResponsible, costAmount, costDoc, costRemarks,
  loggedBy, loggedByRole, projectId, projectName, companyId,
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

---

## File Structure

```
SiteShrimp/
  index.html              # App shell + CDN libs
  js/
    app.js                # React components + business logic
    constants.js          # Entry types, components, issues, locations, statuses
    db.js                 # PocketBase data layer
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
      pb_hooks/main.pb.js # Server-side hooks (auto-ID, Gemini analysis)
```

---

## Deployment

The app is deployed automatically via GitHub Pages (see `.github/workflows/deploy.yml`). Push to `main` and the site updates.

**Backend:** PocketBase runs on a GCP VM with Caddy for HTTPS.

---

## License

Free of Charge (FoC) for all users globally. Private source code.
