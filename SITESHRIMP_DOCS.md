# SiteShrimp v2 — Full Documentation

**Version:** 2.0  
**Stack:** PocketBase · React 18 · Babel · Gemini AI · Telegram · EmailJS  
**Live URL:** https://siteshrimp.org  
**PocketBase URL:** https://api.siteshrimp.org  
**GitHub:** Private repository  

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [File Structure](#3-file-structure)
4. [PocketBase Setup](#4-pocketbase-setup)
5. [User Flows](#5-user-flows)
6. [Role & Permission System](#6-role--permission-system)
7. [Multi-Tenant Data Model](#7-multi-tenant-data-model)
8. [PocketBase API Rules](#8-pocketbase-api-rules)
9. [Features Reference](#9-features-reference)
10. [Integrations Setup](#10-integrations-setup)
11. [App Installation](#11-app-installation)
12. [Deployment](#12-deployment)
13. [Known Limitations & Notes](#13-known-limitations--notes)
14. [Future Roadmap](#14-future-roadmap)

---

## 1. Overview

SiteShrimp is a mobile-first Progressive Web App for construction site defect tracking. It supports multiple companies, each with their own isolated data, users, projects, and access control. No native app store installation required — users add it to their home screen directly from the browser.

### Key Capabilities
- **Real-time sync** — All team members see defect updates instantly via PocketBase SSE (Server-Sent Events)
- **Multi-tenant** — Each company has completely isolated data; companies cannot see each other
- **Role-based access** — Admin, Manager, Inspector, Viewer with different permissions
- **Multi-project** — Each company manages multiple construction projects
- **AI photo analysis** — Google Gemini auto-fills defect title, severity, description from photos (client-side + server-side hooks)
- **Voice input** — Speak to fill any text field
- **Telegram notifications** — New defects and status changes sent to team group with photo
- **Email reports** — Filtered HTML report sent to multiple recipients via EmailJS
- **CSV export** — Download filtered defects for Google Sheets / Excel
- **Batch logging** — Quickly log multiple defects at same location in one session
- **Offline support** — App shell cached; works without internet connection

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    USER'S PHONE (SiteShrimp)                │
│                                                             │
│  index.html (shell)                                         │
│    └── js/app.js (all React components via Babel)          │
│    └── js/db.js (PocketBase data layer)                    │
│    └── js/constants.js (config, roles, localStorage keys)  │
│    └── sw.js (service worker — offline cache)              │
│    └── manifest.json (installable app config)              │
└──────────────────────┬──────────────────────────────────────┘
                       │
          ┌────────────┼──────────────────┐
          │            │                  │
   ┌──────▼──────┐  ┌──▼─────────┐  ┌───▼──────────────┐
   │ PocketBase  │  │  Telegram  │  │  Google Gemini   │
   │  Auth +     │  │  Bot API   │  │  Vision AI API   │
   │  Database   │  │            │  │  (photo analysis)│
   │  + SSE      │  │            │  │                  │
   └─────────────┘  └────────────┘  └──────────────────┘
          │
   ┌──────▼──────┐
   │   EmailJS   │
   │  (reports)  │
   └─────────────┘
```

### Design Decisions
- **Single HTML file + JS files** — No build step, deployable anywhere, easy to update
- **Babel standalone** — JSX compiled in-browser; acceptable for this scale
- **PocketBase** — Self-hosted backend on a VM (DuckDNS domain), handles auth + database + file storage + real-time SSE
- **db.js abstraction layer** — All UI code calls `DB.*` methods; PocketBase REST API details are encapsulated
- **Each company = own set of records filtered by companyId** — Full data isolation via collection-level filters
- **localStorage** for user session persistence — company, project, settings survive page refresh

---

## 3. File Structure

```
SiteShrimp/
├── index.html          ← HTML shell: loads React, Babel, EmailJS, inits PocketBase via DB.init()
├── js/
│   ├── app.js          ← All React components, business logic (1900+ lines)
│   ├── db.js           ← PocketBase data layer: auth, CRUD, SSE subscriptions (380 lines)
│   └── constants.js    ← Config, roles, severity levels, localStorage keys (320 lines)
├── manifest.json       ← App install config (name, icons, theme colour)
├── sw.js               ← Service worker: caches app shell, enables offline
├── icons/
│   ├── icon-192.png    ← App icon (home screen, splash)
│   └── icon-512.png    ← App icon (large)
├── deploy/
│   └── pocketbase/
│       └── pb_hooks/
│           └── main.pb.js  ← Server-side hooks (defect ID generation, Gemini AI analysis)
└── css/                ← Legacy (styles now inline in app.js)
```

### index.html responsibilities
- Loads all CDN scripts in correct order (React, Babel, EmailJS)
- Sets `PB_URL` from localStorage or defaults to `https://api.siteshrimp.org`
- Registers service worker
- Provides `<div id="root">` mount point
- Loads `js/app.js` as `type="text/babel"`

### db.js — PocketBase Data Layer
- Encapsulates all PocketBase REST API calls
- Provides `DB.auth.*` methods (login, register, resetPassword, signOut, onAuthStateChanged)
- Provides `DB.{collection}.*` CRUD methods (list, get, getFirst, create, update, delete, subscribe)
- SSE real-time subscriptions with automatic reconnect and polling fallback
- Token management via localStorage (`pb_auth`)
- 12-second API timeout with clear error messages

### app.js structure (in order)
```
Constants & Config (imported from constants.js)
Utility Functions (compress, AI, CSV, Telegram, email HTML)
UI Helpers (useVoice, MicBtn, chips, Spinner, VoiceField)
AuthScreen
CompanySetupScreen
UserManagement
ProjectManagement
TelegramSettings
GeminiSettings
EmailSettings
generateEmailHTML
Dashboard
LogDefect
DefectsList
DefectDetail
Report
App (root component with all state + PocketBase listeners)
ReactDOM.createRoot().render(<App/>)
```

---

## 4. PocketBase Setup

### Overview
SiteShrimp uses a self-hosted PocketBase instance as its backend. PocketBase provides:
- **Authentication** — Email/password login for all users
- **Database** — Collections for companies, members, projects, defects, invites, etc.
- **File storage** — Defect photos stored as file uploads
- **Real-time** — SSE (Server-Sent Events) for live data sync
- **Server hooks** — JavaScript hooks for auto-generating defect IDs and AI analysis

### Step 1 — Install PocketBase
1. Download PocketBase from [pocketbase.io](https://pocketbase.io)
2. Run on a VM (e.g., Oracle Cloud free tier)
3. Set up DuckDNS domain pointing to your VM
4. Configure HTTPS (e.g., Caddy reverse proxy)

### Step 2 — Collections Required
PocketBase needs these collections:

| Collection | Purpose |
|---|---|
| `users` | Built-in PocketBase auth collection |
| `companies` | Company records (name, adminId, adminEmail) |
| `members` | Company membership (companyId, userId, role, jobTitle) |
| `projects` | Projects per company (companyId, name, archived) |
| `defects` | Defect records with photo file field |
| `invites` | Invite codes for team joining |
| `counters` | Auto-increment counter for defect IDs |
| `settings` | Per-company settings |
| `activity` | Activity log |
| `location_presets` | Saved location templates |
| `component_presets` | Saved component templates |
| `drawings` | Drawing/plan uploads |
| `pins` | Pins on drawings |

### Step 3 — Deploy Server Hooks
Copy `deploy/pocketbase/pb_hooks/main.pb.js` to your PocketBase `pb_hooks/` directory. This enables:
- **Auto defect ID** — Sequential `DEF-0001`, `DEF-0002`, etc. via the `counters` collection
- **Gemini AI analysis** — Server-side photo analysis on defect creation (requires `GEMINI_API_KEY` env var)
- **Auto timestamps** — Sets `timestamp_utc` if not provided
- **Default status** — Sets status to "Open" for new defects

### Step 4 — Configure Client
In `index.html`, the PocketBase URL is set via:
```javascript
const PB_URL = localStorage.getItem('pb_url') || 'https://api.siteshrimp.org';
```
Users can override by setting `pb_url` in localStorage.

---

## 5. User Flows

### 5.1 First-Time Setup (Company Admin)

```
Open app URL
    ↓
Register with email + password
    ↓
"Create Company" → enter company name
    → Creates: company record, member record (as Admin), "Default Project"
    ↓
Main App — Dashboard
    ↓
Setup AI (optional) → paste Gemini API key → Test → Save
Telegram icon → setup Bot Token + Chat ID → Test → Save
    ↓
Team Management → generate invite links → share with team
```

### 5.2 Team Member Joins via Invite

```
Admin: Team Management → set role + job title → Generate Invite Link
    ↓
Admin shares link (copy or native share)
Link format: https://[url]/?invite=[companyId]:[code]
    ↓
Member opens link → Register or Login
    ↓
"Join" tab auto-filled with invite code → JOIN COMPANY →
    → Validates invite (exists, not used, not expired)
    → Adds member with assigned role
    → Invite marked as used (one-time only)
    ↓
Member enters main app — sees company data
```

### 5.3 Logging a Defect (Inspector/Manager/Admin)

```
Tap LOG tab
    ↓
Add photo (camera opens)
    ↓
Optional: ANALYZE WITH AI → auto-fills title, severity, description
    ↓
Edit/confirm: Title · Location · Severity · Assign To · Description
    ↓
SUBMIT DEFECT
    → Saved to PocketBase (photo uploaded as file)
    → Server hook assigns DEF-XXXX ID + optional Gemini AI analysis
    → Telegram: photo + details sent to group (client-side)
    ↓
"Log another at same location?" → YES (same location pre-filled) or DONE
```

### 5.4 Returning User (Page Refresh)

```
Open app URL → Loading spinner
    ↓
PocketBase auth token restored from localStorage (pb_auth)
Token validated via auth-refresh API call
Company + project loaded from localStorage
Member data loaded from PocketBase
    ↓
Main app shown — no re-login required
```

---

## 6. Role & Permission System

### Roles

| Role | Description |
|---|---|
| **Admin** | Full access. Manages users, can delete defects, all features |
| **Manager** | Log + update defects, manage projects, email reports |
| **Inspector** | Log defects, add comments, view all |
| **Viewer** | Read-only — view defects only |

### Permission Matrix

| Action | Admin | Manager | Inspector | Viewer |
|---|---|---|---|---|
| View dashboard / defects / report | Yes | Yes | Yes | Yes |
| Log new defect | Yes | Yes | Yes | No |
| Update defect status | Yes | Yes | Yes | No |
| Add comments | Yes | Yes | Yes | No |
| Delete defect | Yes | No | No | No |
| Manage projects (add/archive) | Yes | Yes | No | No |
| Invite users | Yes | No | No | No |
| Change user roles / remove users | Yes | No | No | No |
| Email reports / CSV export | Yes | Yes | Yes | Yes |

### UI Enforcement
- Log tab **hidden from Viewer** in bottom nav
- Delete button **only shown to Admin** in Defect Detail
- Team icon **only shown to Admin** in header
- Comment input **hidden from Viewer** (shows "Viewer access — comments disabled")
- Role badge shown alongside commenter name in comments

---

## 7. Multi-Tenant Data Model

### PocketBase Collection Structure

All collections are flat (not subcollections). Multi-tenancy is enforced by `companyId` field on every record:

```
companies
  id, name, adminId, adminEmail, createdAt

members
  id, companyId, userId, name, email, role, jobTitle, joinedAt

invites
  id, companyId, code, role, jobTitle, createdBy, createdAt, expiresAt, usedBy, usedAt

projects
  id, companyId, name, createdAt, createdBy, archived

defects
  id, companyId, projectId, projectName, defect_id (DEF-XXXX)
  title, location, severity, status, assignee
  description, photo (file field, supports multiple)
  loggedBy, loggedByRole
  category, defect_type, trade (AI-filled)
  createdAt, updatedAt
  comments: [{text, by, role, at}]

counters
  id, key ("defect_counter"), value (integer)
```

### Isolation Guarantee
- Every PocketBase query includes `companyId` in the filter
- API rules should enforce that users can only access records matching their company membership
- localStorage only stores `companyId` + `projectId` references — no actual defect data

---

## 8. PocketBase API Rules

Access control is enforced via PocketBase collection API rules (configured in PocketBase Admin UI):

**Key principles:**
1. Authentication required for all access — all rules require `@request.auth.id != ""`
2. Company membership enforced — list/view rules filter by `companyId` matching the user's membership
3. Role-based permissions (Admin/Manager/Inspector/Viewer) enforced in app JavaScript (client-side)
4. Invite records allow any authenticated user to read/update (required for joining)

Configure these rules in the PocketBase Admin dashboard at `https://api.siteshrimp.org/_/`.

---

## 9. Features Reference

### Dashboard
- Open / In Progress / Closed counts
- Critical unresolved alert
- Severity breakdown bar chart (visual)
- 6 most recent defects
- Live sync indicator + AI/TG badges

### Log Defect
- Voice input on all text fields (tap mic icon)
- Direct camera access
- AI photo analysis (Gemini) — auto-fills title, severity, description
- Severity selector: Critical / Major / Minor / Observation
- Assignee dropdown from company members
- Batch mode: log multiple defects at same location quickly
- Session counter

### Defects List
- Filter by Status + Severity
- Colour-coded by severity
- Tap to open full detail

### Defect Detail
- All defect fields + project name
- Photo (full width, supports multiple)
- Status update (Inspector+)
- Comments with role badge and voice input
- Delete (Admin only, with confirm dialog)
- Telegram notification on status change + comments

### Report
- 5 filter types: Severity, Status, Assignee, Date From, Date To
- Active filter count badge
- Summary stats + severity chart + status tiles + assignee table
- EMAIL REPORT (filtered, HTML format)
- CSV EXPORT (filtered, spreadsheet-ready)

### Profile Dropdown
- Name, email, role, job title
- Email settings shortcut
- Sign out

### Header
- Company name + project switcher
- Open count
- AI + Telegram setup buttons
- Team management (Admin)
- Profile avatar

---

## 10. Integrations Setup

### Telegram

#### Step 1: Create a Bot (get Bot Token)
1. Open Telegram, search for **@BotFather**
2. Send `/newbot`
3. Give it a name (e.g. "SiteShrimp Alerts")
4. Give it a username (e.g. `siteshrimp_alerts_bot`)
5. BotFather replies with your **Bot Token** — looks like `7123456789:AAH...` — copy it

#### Step 2: Create a Group and Add the Bot
1. Create a new Telegram group (e.g. "SiteShrimp - Yarwood Project")
2. Add your bot to the group (search its username)
3. Go to group settings > **Administrators** > add the bot as admin (needed to send messages)

#### Step 3: Get the Chat ID
**Method A — easiest:**
1. Add **@RawDataBot** to your group
2. It instantly sends a message showing the group info
3. Look for `"chat": { "id": -100xxxxxxxxxx }` — that negative number is your **Chat ID**
4. Copy it (including the minus sign, e.g. `-1001234567890`)
5. Remove @RawDataBot from the group (no longer needed)

**Method B — alternative:**
1. Send any message in the group
2. Open this URL in your browser (replace YOUR_BOT_TOKEN):
   `https://api.telegram.org/botYOUR_BOT_TOKEN/getUpdates`
3. Find `"chat": { "id": -100xxxxxxxxxx }` in the JSON
4. That negative number is your **Chat ID**

#### Step 4: Configure in SiteShrimp
1. Open SiteShrimp app
2. Tap the Telegram icon (settings)
3. Paste your **Bot Token**
4. Paste your **Chat ID** (with the minus sign)
5. Tap **TEST** — you should receive a test message in your group
6. Tap **SAVE**

**What's sent:**
- New defect: photo (if any) + title, location, severity, assignee, logged by, company, project
- Status update: title, new status, changed by
- New comment: title, commenter, comment text

### Gemini AI

1. Go to [aistudio.google.com](https://aistudio.google.com) — sign in
2. Get API Key — Create API Key — copy
3. In SiteShrimp: AI icon — paste key — TEST — SAVE

**Free:** 1,500 requests/day, no credit card.  
**Per-device setting** — stored in browser localStorage.

**Server-side AI:** If `GEMINI_API_KEY` environment variable is set on the PocketBase VM, defect photos are also analysed server-side via hooks (auto-fills category, defect_type, severity, trade).

### Email Reports (EmailJS)

1. [emailjs.com](https://emailjs.com) — sign up free
2. Add Email Service (Gmail/Outlook) — copy **Service ID**
3. Create Template — Subject: `{{subject}}` · HTML body: `{{{html_content}}}` · To: `{{to_email}}` — copy **Template ID**
4. Account — API Keys — copy **Public Key**
5. In SiteShrimp: Profile — Email Settings — paste all 3 keys + recipient emails — SAVE

**Free:** 200 emails/month.  
**Note:** Photos excluded from email (base64 too large for free tier — shows "Photo available in app" note instead).

---

## 11. App Installation

### Android (Chrome)
1. Open app URL in Chrome
2. Tap menu — **Add to Home screen** — Confirm

### iPhone (Safari)
1. Open app URL in Safari
2. Tap Share icon — **Add to Home Screen** — Confirm

App launches full-screen with no browser chrome, like a native app.

---

## 12. Deployment

### Cloudflare Pages (primary — frontend)
Auto-deploys from `main` branch. Push to GitHub — live in ~1 minute.

**Files to update per release:**

| File | When |
|---|---|
| `js/app.js` | Every feature update |
| `js/db.js` | PocketBase API changes |
| `js/constants.js` | Config, role, or key changes |
| `index.html` | New CDN libs or PB_URL change |
| `manifest.json` | App name / icon / theme changes |
| `sw.js` | Cache strategy changes — bump version string |

### PocketBase VM (backend)
- Hosted on a VM (e.g., Oracle Cloud free tier)
- Domain: `api.siteshrimp.org`
- Server hooks in `pb_hooks/main.pb.js`
- Admin dashboard at `https://api.siteshrimp.org/_/`

---

## 13. Known Limitations & Notes

| Issue | Detail | Workaround |
|---|---|---|
| Email photos excluded | Base64 exceeds EmailJS 50KB free limit | Email shows "Photo in app" note |
| Gemini key per-device | Stored in localStorage, not shared | Each user enters own free key |
| Voice: Firefox | Web Speech API not supported | Mic button auto-hidden |
| Offline submissions | Cannot save defects without internet | Planned: offline queue |
| Telegram caption limit | 1024 chars max | Long names auto-truncated by Telegram |
| PocketBase VM uptime | VM may sleep/restart | Check VM status if app shows timeout errors |
| API timeout | 12-second timeout on all PocketBase calls | Increase in db.js if VM is slow |

---

## 14. Future Roadmap

### Near Term
- Push notifications — alerts when app is closed
- Offline submission queue (IndexedDB)
- PDF report export
- Multiple photos per defect (partially implemented — PB supports it)

### Medium Term
- Custom defect categories per company
- Target completion dates
- QR codes per location for quick logging
- Admin web dashboard (not just mobile)

### Long Term
- Google Sheets auto-sync
- WhatsApp notifications (alternative to Telegram)
- Multi-language (BM, Chinese, Tamil)
- API for BIM software integration

---

## Appendix A — Component Reference

| Component | Props | Description |
|---|---|---|
| `AuthScreen` | `onAuth(user, name, inviteCode)` | Login / Register |
| `CompanySetup` | `user, inviteCode, onDone(cd, proj), onSignOut` | Create or join company |
| `UserManagement` | `onClose, company, member, members` | Admin: invite + manage roles |
| `ProjectManagement` | `onClose, company, member, projects, currentProject, onSelect(proj)` | Switch / add projects |
| `TelegramSettings` | `onClose` | Bot Token + Chat ID setup |
| `GeminiSettings` | `onClose` | Gemini API key setup |
| `EmailSettings` | `onClose` | EmailJS keys + recipients |
| `Dashboard` | `defects, onView, tgEnabled, aiEnabled, syncing, company, currentProject, member` | Home screen |
| `LogDefect` | `member, company, currentProject, members, onSave(data)` | Log new defect |
| `DefectsList` | `defects, onView(defect)` | Filtered defects list |
| `DefectDetail` | `defect, onClose, onUpdate(updated), member, company` | Full defect view |
| `Report` | `defects, onEmailSetup, currentProject, company` | Stats + email + CSV |

---

## Appendix B — localStorage Keys

| Key | Value | Notes |
|---|---|---|
| `pb_auth` | `{token, user}` | PocketBase auth token + user record |
| `pb_url` | `"https://..."` | PocketBase server URL override |
| `sdt-co-v1` | `{companyId, companyName}` | Active company (persists session) |
| `sdt-proj-v1` | `{id, name}` | Active project |
| `sdt-tg-v2` | `{token, chatId}` | Telegram config (per device) |
| `sdt-email-v1` | `{publicKey, serviceId, templateId, recipients[]}` | EmailJS config (per device) |
| `sdt-gemini-v1` | `"AIzaSy..."` | Gemini API key (per device) |
| `sdt-ai-usage` | `{date, count}` | Daily AI usage counter |

---

## Appendix C — Sharing With Another Company

Multiple companies can use the same PocketBase instance — they are fully isolated from each other via `companyId` filtering on all data.

For a fully independent setup:
1. Deploy their own PocketBase instance
2. Set `pb_url` in localStorage to point to their server
3. Create required collections (see Section 4)
4. Deploy the same frontend (or host separately)

---

*SiteShrimp v2 · Built with PocketBase + React + Gemini AI · MIT License*
