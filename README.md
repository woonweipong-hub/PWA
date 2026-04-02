# SiteShrimp - Construction Defect Tracker

**Snap. Speak. Done.**

A mobile-first PWA for construction site defect tracking with AI photo analysis, real-time sync, Telegram notifications, and multi-tenant team management. No app store needed — open the link, add to home screen, start reporting.

**Live:** https://siteshrimp.pages.dev

---

## Quick Start

### For site workers (30 seconds)

1. Open **https://siteshrimp.pages.dev** on your phone
2. **Android**: Menu > "Add to Home Screen"
3. **iPhone**: Share > "Add to Home Screen"
4. Sign up with email, join or create a company
5. Start reporting defects

### For admins (5 minutes)

1. Sign up and create a company
2. Set up integrations in Settings:
   - **Gemini API Key** — enables AI photo analysis (free at aistudio.google.com/apikey)
   - **Telegram Bot** — sends defect notifications to your team group
   - **EmailJS** — sends HTML defect reports via email
3. Create projects, invite team members via company code

---

## Features

| Feature | Description |
|---------|-------------|
| **AI Photo Analysis** | Snap a photo, Gemini auto-fills title, severity, description |
| **Voice Input** | Hold mic button, speak to fill any text field |
| **Real-time Sync** | All team members see updates instantly (Firebase Firestore) |
| **Multi-tenant** | Each company has isolated data, users can't see other companies |
| **Role-based Access** | Admin, Manager, Inspector, Viewer with different permissions |
| **Multi-project** | Each company manages multiple construction projects |
| **Telegram Alerts** | New defects and status changes sent to team group with photo |
| **Email Reports** | Filtered HTML report sent to multiple recipients |
| **CSV Export** | Download filtered defects for Google Sheets / Excel |
| **Batch Logging** | Quickly log multiple defects at same location |
| **Offline Support** | App shell cached, works without internet |
| **Comments** | Team discussion thread on each defect |
| **Status Tracking** | Open > In Progress > Closed workflow |
| **Installable PWA** | Add to home screen, works like native app |

---

## Architecture

```
Phone (PWA)                     Cloud Services (all free tier)
+------------------+            +---------------------------+
|  React 18 (JSX)  |            |  Firebase                 |
|  Babel (browser)  |---------->|    Auth (email/password)   |
|  Service Worker  |            |    Firestore (database)    |
+------------------+            +---------------------------+
       |                        |  Google Gemini AI          |
       |  Photo + Voice ------->|    (photo analysis)        |
       |                        +---------------------------+
       |                        |  Telegram Bot API          |
       |  Notifications ------->|    (team alerts)           |
       |                        +---------------------------+
       |                        |  EmailJS                   |
       +--- Email reports ----->|    (HTML reports)          |
                                +---------------------------+
```

---

## Tech Stack

| Layer | Technology | Cost |
|-------|-----------|------|
| Frontend | React 18 + Babel (in-browser JSX) | Free |
| Auth | Firebase Authentication (email/password) | Free (50K MAU) |
| Database | Firebase Firestore | Free (50K reads/20K writes per day) |
| AI | Google Gemini 2.0 Flash | Free (15 req/min) |
| Voice | Web Speech API | Free (browser built-in) |
| Notifications | Telegram Bot API | Free |
| Email | EmailJS | Free (200 emails/month) |
| Hosting | GitHub Pages | Free |
| **Total** | | **$0/month** |

---

## Firebase Setup

### 1. Create Firebase Project

1. Go to **https://console.firebase.google.com/**
2. Click **Add project** > name it (e.g. "siteshrimp")
3. Disable Google Analytics (optional) > **Create project**

### 2. Enable Authentication

1. In Firebase console, go to **Authentication > Sign-in method**
2. Enable **Email/Password**
3. Disable Anonymous sign-in (if enabled)

### 3. Create Firestore Database

1. Go to **Firestore Database > Create database**
2. Start in **production mode**
3. Select a location (e.g. asia-southeast1 for Singapore)

### 4. Create Firestore Index

1. Open the app in your browser
2. Open browser console (F12 > Console)
3. If you see a Firestore index error, click the link in the error message
4. Click **Create index** in Firebase console
5. Wait 2-3 minutes for it to build

### 5. Get Firebase Config

The app already has Firebase config in index.html. If you fork this repo, replace the config with your own:

```javascript
const firebaseConfig = {
  apiKey: "your-api-key",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project-id",
  storageBucket: "your-project.firebasestorage.app",
  messagingSenderId: "123456789",
  appId: "your-app-id"
};
```

---

## Integrations Setup

### Gemini AI (photo analysis)

1. Go to **https://aistudio.google.com/apikey**
2. Create API key
3. In the app: Settings > Gemini API Key > paste key

### Telegram Notifications

1. Create a bot via **@BotFather** on Telegram
2. Get your group's Chat ID (add @userinfobot to group)
3. In the app: Settings > Telegram > enter Bot Token + Chat ID

### EmailJS (reports)

1. Sign up at **https://www.emailjs.com/**
2. Create a service + template
3. In the app: Settings > Email > enter Service ID, Template ID, Public Key

---

## Data Model (Firestore)

```
companies/{companyId}/
  ├── info: { name, code, createdBy, createdAt }
  ├── members/{uid}: { email, name, role, jobTitle }
  ├── projects/{projectId}: { name, createdBy, createdAt }
  └── defects/{defectId}: {
        title, description, location, severity, status,
        photo, assignee, loggedBy, loggedByUid,
        projectId, projectName, companyId,
        comments: [{ by, text, at }],
        createdAt, updatedAt
      }
```

### Role Permissions

| Action | Admin | Manager | Inspector | Viewer |
|--------|-------|---------|-----------|--------|
| Create defects | Yes | Yes | Yes | No |
| Edit defects | Yes | Yes | Own only | No |
| Delete defects | Yes | No | No | No |
| Change status | Yes | Yes | Own only | No |
| Manage members | Yes | No | No | No |
| Manage projects | Yes | Yes | No | No |
| View all defects | Yes | Yes | Yes | Yes |
| Export CSV | Yes | Yes | Yes | No |
| Send email report | Yes | Yes | No | No |

---

## File Structure

```
PWA/
  index.html              # App shell: Firebase, React, Babel, EmailJS
  js/app.js               # All React components + business logic
  manifest.json           # PWA install config
  sw.js                   # Service worker (offline cache)
  icons/
    icon-192.svg          # App icon
    icon-512.svg          # App icon (large)
  SITESHRIMP_DOCS.md        # Detailed technical documentation
  backend/                # Legacy Google Sheets backend (optional)
  deploy/                 # PocketBase deployment scripts (optional)
```

---

## Deployment

The app is deployed automatically via GitHub Pages. Push to `main` and the site updates.

To fork and deploy your own:
1. Fork this repo
2. Update Firebase config in `index.html`
3. Enable GitHub Pages (Settings > Pages > main branch)
4. Your app is live at your Cloudflare Pages URL

---

## License

MIT
