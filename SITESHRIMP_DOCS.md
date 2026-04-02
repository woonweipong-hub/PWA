# SiteShrimp v2 — Full Documentation

**Version:** 2.0  
**Stack:** PocketBase · React 18 · Babel · Gemini AI · Telegram · EmailJS  
**Live URL:** https://siteshrimp.pages.dev  
**GitHub:** Private repository  

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [File Structure](#3-file-structure)
4. [Firebase Setup](#4-firebase-setup)
5. [User Flows](#5-user-flows)
6. [Role & Permission System](#6-role--permission-system)
7. [Multi-Tenant Data Model](#7-multi-tenant-data-model)
8. [Firestore Security Rules](#8-firestore-security-rules)
9. [Features Reference](#9-features-reference)
10. [Integrations Setup](#10-integrations-setup)
11. [App Installation](#11-app-installation)
12. [Deployment](#12-deployment)
13. [Known Limitations & Notes](#13-known-limitations--notes)
14. [Firestore Index Required](#14-firestore-index-required)
15. [Future Roadmap](#15-future-roadmap)

---

## 1. Overview

SiteShrimp is a mobile-first Progressive Web App for construction site defect tracking. It supports multiple companies, each with their own isolated data, users, projects, and access control. No native app store installation required — users add it to their home screen directly from the browser.

### Key Capabilities
- **Real-time sync** — All team members see defect updates instantly via Firebase Firestore
- **Multi-tenant** — Each company has completely isolated data; companies cannot see each other
- **Role-based access** — Admin, Manager, Inspector, Viewer with different permissions
- **Multi-project** — Each company manages multiple construction projects
- **AI photo analysis** — Google Gemini auto-fills defect title, severity, description from photos
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
│    └── sw.js (service worker — offline cache)              │
│    └── manifest.json (installable app config)              │
└──────────────────────┬──────────────────────────────────────┘
                       │
          ┌────────────┼──────────────────┐
          │            │                  │
   ┌──────▼──────┐  ┌──▼─────────┐  ┌───▼──────────────┐
   │  Firebase   │  │  Telegram  │  │  Google Gemini   │
   │  Auth +     │  │  Bot API   │  │  Vision AI API   │
   │  Firestore  │  │            │  │  (photo analysis)│
   └─────────────┘  └────────────┘  └──────────────────┘
          │
   ┌──────▼──────┐
   │   EmailJS   │
   │  (reports)  │
   └─────────────┘
```

### Design Decisions
- **Single HTML file + one JS file** — No build step, deployable anywhere, easy to update
- **Babel standalone** — JSX compiled in-browser; acceptable for this scale
- **Firebase free tier** — 50K reads/20K writes per day; sufficient for most site teams
- **Each company = own Firebase subcollection** — Full data isolation without separate Firebase projects
- **localStorage** for user session persistence — company, project, settings survive page refresh

---

## 3. File Structure

```
SiteShrimp/
├── index.html          ← HTML shell: loads Firebase, React, Babel, EmailJS, calls js/app.js
├── js/
│   └── app.js          ← All React components, business logic, Firestore operations (92KB)
├── manifest.json       ← App install config (name, icons, theme colour)
├── sw.js               ← Service worker: caches app shell, enables offline
├── icons/
│   ├── icon-192.svg    ← App icon (home screen, splash)
│   └── icon-512.svg    ← App icon (large)
├── css/                ← Legacy (styles now inline in app.js)
└── backend/            ← Legacy (Google Sheets backend, optional)
```

### index.html responsibilities
- Loads all CDN scripts in correct order
- Initialises Firebase (`db`, `auth` as globals)
- Registers service worker
- Provides `<div id="root">` mount point
- Loads `js/app.js` as `type="text/babel"`

### app.js structure (in order)
```
Constants & Config
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
App (root component with all state + Firestore listeners)
ReactDOM.createRoot().render(<App/>)
```

---

## 4. Firebase Setup

### Required Services
| Service | Purpose |
|---|---|
| **Authentication** | Email/password login for all users |
| **Firestore** | Real-time database for defects, companies, members, projects |

### Step 1 — Create Firebase Project
1. Go to [console.firebase.google.com](https://console.firebase.google.com)
2. Create new project (or use existing `siteshrimp-e70ad`)
3. No Google Analytics needed

### Step 2 — Enable Email/Password Authentication
1. Authentication → Sign-in method
2. Enable **Email/Password**
3. Disable **Anonymous** (no longer used in v2)

### Step 3 — Create Firestore Database
1. Firestore Database → Create database
2. Start in **production mode** (rules set in Step 5)
3. Choose server location closest to users

### Step 4 — Create Composite Index (REQUIRED)
The defects query filters by `projectId` AND sorts by `createdAt`. Firestore requires a composite index for this.

**Option A — Auto-create (easiest):**
1. Deploy the app and open it
2. Open browser DevTools → Console
3. You will see: `⚠️ Missing Firestore index. Create at: ...` with a direct link
4. Click the link → Firebase creates the index automatically

**Option B — Manual:**
1. Firestore → Indexes → Composite → Add index
2. Collection group: `defects`
3. Fields:
   - `projectId` — Ascending
   - `createdAt` — Descending
4. Click Create → wait ~2 minutes

### Step 5 — Set Firestore Security Rules

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function isMember(companyId) {
      return request.auth != null &&
        exists(/databases/$(database)/documents/companies/$(companyId)/members/$(request.auth.uid));
    }

    match /companies/{companyId} {
      allow read: if isMember(companyId);
      allow create: if request.auth != null;
      allow update: if isMember(companyId);
    }

    match /companies/{companyId}/members/{memberId} {
      allow read: if isMember(companyId);
      allow create: if request.auth != null;
      allow update, delete: if isMember(companyId);
    }

    match /companies/{companyId}/invites/{inviteId} {
      allow read, update: if request.auth != null;
      allow create: if isMember(companyId);
    }

    match /companies/{companyId}/projects/{projectId} {
      allow read, write: if isMember(companyId);
    }

    match /companies/{companyId}/defects/{defectId} {
      allow read, write: if isMember(companyId);
    }
  }
}
```

---

## 5. User Flows

### 5.1 First-Time Setup (Company Admin)

```
Open app URL
    ↓
Register with email + password
    ↓
"Create Company" → enter company name + job title
    → Creates: companies/{id}, members/{uid} as Admin, projects/default
    ↓
Main App — Dashboard
    ↓
🤖 Setup AI (optional) → paste Gemini API key → Test → Save
Telegram icon → setup Bot Token + Chat ID → Test → Save
    ↓
👥 Team Management → generate invite links → share with team
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
📷 Add photo (camera opens)
    ↓
Optional: 🤖 ANALYZE WITH AI → auto-fills title, severity, description
    ↓
Edit/confirm: Title · Location · Severity · Assign To · Description
    ↓
SUBMIT DEFECT
    → Saved to Firestore under company/project
    → Telegram: photo + details sent to group
    ↓
"Log another at same location?" → YES (same location pre-filled) or DONE
```

### 5.4 Returning User (Page Refresh)

```
Open app URL → Loading spinner
    ↓
Firebase Auth restores session automatically
Company + project loaded from localStorage
Member data loaded from Firestore
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
| View dashboard / defects / report | ✅ | ✅ | ✅ | ✅ |
| Log new defect | ✅ | ✅ | ✅ | ❌ |
| Update defect status | ✅ | ✅ | ✅ | ❌ |
| Add comments | ✅ | ✅ | ✅ | ❌ |
| Delete defect | ✅ | ❌ | ❌ | ❌ |
| Manage projects (add/archive) | ✅ | ✅ | ❌ | ❌ |
| Invite users | ✅ | ❌ | ❌ | ❌ |
| Change user roles / remove users | ✅ | ❌ | ❌ | ❌ |
| Email reports / CSV export | ✅ | ✅ | ✅ | ✅ |

### UI Enforcement
- Log tab **hidden from Viewer** in bottom nav
- Delete button **only shown to Admin** in Defect Detail
- 👥 Team icon **only shown to Admin** in header
- Comment input **hidden from Viewer** (shows "Viewer access — comments disabled")
- Role badge shown alongside commenter name in comments

---

## 7. Multi-Tenant Data Model

### Firestore Structure

```
companies/
  {companyId}/
    name, adminId, adminEmail, createdAt

    members/
      {userId}/
        name, email, role, jobTitle, joinedAt

    invites/
      {code}/
        role, jobTitle, createdBy, createdAt, expiresAt, usedBy, usedAt

    projects/
      {projectId}/
        name, createdAt, createdBy, archived

    defects/
      {defectId}/
        title, location, severity, status, assignee
        description, photo (base64 ~15-25KB)
        projectId, projectName
        loggedBy, loggedByRole
        createdAt, updatedAt
        comments: [{text, by, role, at}]
```

### Isolation Guarantee
- Every Firestore read/write goes through `companies/{companyId}/...`
- Firestore rules block cross-company access at database level
- localStorage only stores `companyId` + `projectId` references — no actual defect data

---

## 8. Firestore Security Rules

See Section 4 Step 5 for the complete rules.

**Key principles:**
1. Authentication required for all access
2. `isMember()` helper enforces company membership at every path
3. Role-based permissions (Admin/Manager/Inspector/Viewer) enforced in app JavaScript
4. Invite paths allow any authenticated user to read/update (required for joining)

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
- Photo (full width)
- Status update (Inspector+)
- Comments with role badge and voice input
- Delete (Admin only, with confirm dialog)
- Telegram notification on status change + comments

### Report
- 5 filter types: Severity, Status, Assignee, Date From, Date To
- Active filter count badge
- Summary stats + severity chart + status tiles + assignee table
- 📧 EMAIL REPORT (filtered, HTML format)
- 📊 CSV EXPORT (filtered, spreadsheet-ready)

### Profile Dropdown
- Name, email, role, job title
- Email settings shortcut
- Sign out

### Header
- Company name + project switcher (▼)
- Open count
- 🤖 AI + Telegram setup buttons
- 👥 Team management (Admin)
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

1. Go to [aistudio.google.com](https://aistudio.google.com) → sign in
2. Get API Key → Create API Key → copy
3. In SiteShrimp: 🤖 → paste key → TEST → SAVE

**Free:** 1,500 requests/day, no credit card.  
**Per-device setting** — stored in browser localStorage.

### Email Reports (EmailJS)

1. [emailjs.com](https://emailjs.com) → sign up free
2. Add Email Service (Gmail/Outlook) → copy **Service ID**
3. Create Template → Subject: `{{subject}}` · HTML body: `{{{html_content}}}` · To: `{{to_email}}` → copy **Template ID**
4. Account → API Keys → copy **Public Key**
5. In SiteShrimp: Profile → Email Settings → paste all 3 keys + recipient emails → SAVE

**Free:** 200 emails/month.  
**Note:** Photos excluded from email (base64 too large for free tier — shows "📷 Photo available in app" note instead).

---

## 11. App Installation

### Android (Chrome)
1. Open app URL in Chrome
2. Tap ⋮ menu → **Add to Home screen** → Confirm

### iPhone (Safari)
1. Open app URL in Safari
2. Tap Share icon → **Add to Home Screen** → Confirm

App launches full-screen with no browser chrome, like a native app.

---

## 12. Deployment

### GitHub Pages (primary)
Auto-deploys from `main` branch. Edit files via GitHub web editor → commit → live in ~1 minute.

**Files to update per release:**

| File | When |
|---|---|
| `js/app.js` | Every feature update |
| `index.html` | New CDN libs or Firebase config change |
| `manifest.json` | App name / icon / theme changes |
| `sw.js` | Cache strategy changes — bump `siteshrimp-v2` → `siteshrimp-v3` |

### How to Edit on GitHub Mobile
1. Go to the private GitHub repository
2. Tap file → pencil ✏️ icon
3. Select All → paste new content
4. Scroll down → Commit changes

---

## 13. Known Limitations & Notes

| Issue | Detail | Workaround |
|---|---|---|
| Email photos excluded | Base64 exceeds EmailJS 50KB free limit | Email shows "📷 Photo in app" note |
| Gemini key per-device | Stored in localStorage, not shared | Each user enters own free key |
| Firebase free tier | 50K reads / 20K writes per day | Upgrade to Blaze if needed |
| Voice: Firefox | Web Speech API not supported | Mic button auto-hidden |
| Offline submissions | Cannot save defects without internet | Planned: offline queue |
| Telegram caption limit | 1024 chars max | Long names auto-truncated by Telegram |
| Composite index needed | Required for defects query | See Section 14 |

---

## 14. Firestore Index Required

**Without this, the defects list will be empty.**

### Index to Create

| Collection path | Field | Order |
|---|---|---|
| `companies/{id}/defects` | `projectId` | Ascending |
| `companies/{id}/defects` | `createdAt` | Descending |

### Auto-create (recommended)
Open the app → browser DevTools → Console → click the Firebase error link that appears → index created automatically.

### Manual
Firebase Console → Firestore → Indexes → Composite → Add:
- Collection: `defects`
- `projectId` Ascending + `createdAt` Descending
- Wait ~2 minutes to build.

---

## 15. Future Roadmap

### Near Term
- Firebase setup wizard in-app (guided onboarding for new companies)
- Push notifications (FCM) — alerts when app is closed
- Offline submission queue (IndexedDB)
- PDF report export
- Multiple photos per defect

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
| `CompanySetupScreen` | `user, inviteCode, onDone(cd, proj)` | Create or join company |
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
| `sdt-co-v1` | `{companyId, companyName}` | Active company (persists session) |
| `sdt-proj-v1` | `{id, name}` | Active project |
| `sdt-tg-v2` | `{token, chatId}` | Telegram config (per device) |
| `sdt-email-v1` | `{publicKey, serviceId, templateId, recipients[]}` | EmailJS config (per device) |
| `sdt-gemini-v1` | `"AIzaSy..."` | Gemini API key (per device) |

---

## Appendix C — Sharing With Another Company

Each company that wants to use SiteShrimp independently should:

1. Create their own Firebase project (free)
2. Enable Email/Password Auth + Firestore
3. Copy `firebaseConfig` from Firebase Console → Project Settings → Your apps
4. Replace `firebaseConfig` in `index.html` with their own values
5. Set Firestore rules (Section 4 Step 5)
6. Create composite index (Section 14)
7. Host on their own GitHub Pages

This gives each company full data sovereignty — their data never touches another company's Firebase.

Alternatively, multiple companies can share the same Firebase project using the multi-tenant subcollection model already implemented — they will be fully isolated from each other by the `isMember()` Firestore rules.

---

*SiteShrimp v2 · Built with Firebase + React + Gemini AI · MIT License*
