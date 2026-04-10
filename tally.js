// Feature tally script - compare intro page vs features tab
const features = [
  ["Authentication & Onboarding",["Login / Sign up","Password reset","One-step registration + company setup","Auto-recover session","Install as app","Server URL config"]],
  ["Team & Roles",["Invite members (link + code)","Role-based access (Admin, Manager, Inspector, Viewer)","Edit roles / remove members","Permission matrix"]],
  ["Project Management",["Create / rename projects","Switch active project","Archive / restore projects"]],
  ["Entry Logging",["Log with title, severity, location","4 default + custom entry types with icon & color","Multi-level location (Level > Zone > Room > Grid)","Up to 10 photos with markup editor","AI photo analysis (Gemini, Ollama, GPT)","AI auto-assign trade + suggested assignee","AI safety risk scoring (auto-escalate Critical)","Duplicate detection on submit","Voice-to-text on all fields","Component + issue selector (93 / 517)","Cost & time tracking","Batch logging mode"]],
  ["Entry Management",["Full-text search with highlighting","AI natural language search (voice + text)","Filter by status, severity, entry type","Resolution timeline with photo comments","Quick reactions on timeline entries","Verification photo on Close / Verify","Before / after photo comparison","Update status workflow (5 stages)","Delete entry (Admin only)","Telegram alerts"]],
  ["Drawings & Floor Plans",["Upload JPG, PNG, TIF, PDF (max 50MB)","PDF rendering with page navigation","Zoom, pan, pinch-to-zoom","Ring-style pins with severity pulse","Quick-pin: create entry from drawing","Defect heatmap overlay","Drawing-level markup (freehand, arrows, circles)","Pin count & severity badges"]],
  ["Dashboard & Analytics",["Real-time status counts + critical alerts","Severity breakdown chart","Admin analytics (per-user, per-type, per-project)","AI usage stats"]],
  ["Reports & Exports",["Site report with charts","Filter by severity / status / assignee / date","CSV export","Email report via EmailJS"]],
  ["AI Integrations",["Google Gemini (cloud)","Ollama (local / self-hosted)","OpenAI / GPT (API-compatible)","Auto-fill title, severity, description, trade, assignee","Safety risk scoring","Natural language search"]],
  ["Telegram Notifications",["Bot setup + test","Alerts on new entries","Alerts on status changes + comments"]],
  ["Storage Options",["PocketBase (default server)","Local path (self-hosted)","Google Drive (OAuth)"]],
  ["Offline Sync",["Save entries to IndexedDB when offline","Queued badge in header + Dashboard","Auto-sync when back online","Manual sync"]],
  ["Account Settings",["Edit display name + job title","Change email","Change password"]],
  ["Platform Compatibility",["Mobile (iOS Safari, Android Chrome)","Desktop (Chrome, Firefox, Edge)","Installable as app (PWA)","Offline-capable"]],
];

// Items from intro page (98) that are NOT in Features tab
const introOnly = [
  "Password visibility toggle",
  "Custom type manager (icon & color picker)",
  "Assign to team member",
  "Collapsible filters with clear button",
  "Entry type badges on list & detail",
  "Detail view with all fields + photos",
  "Photo comments in timeline",
  "Critical pin pulse animation",
  "Pin tooltip with entry details + remove",
  "Markup color picker + undo/clear",
  "PDF thumbnail preview in list",
  "Recent entries with type badges",
  "Live sync indicator + queue count",
  "Entries today / week / month / all time",
  "Active users tracking",
  "Per-user ranking bar chart",
  "Photos stats (total & avg per entry)",
  "Entries by entry type breakdown",
  "Entries by project breakdown",
  "Telegram bot setup + test",
  "AI multi-provider setup + test",
  "Email report config",
  "Daily AI usage limit",
  "Storage mode selector",
  "Queued/synced status indicator",
  "Comprehensive help guide",
  "Feedback form (suggestion, bug, praise)",
  "Cached app shell (service worker)",
  "Photo compression (auto-resize)",
];

console.log("=== FEATURES TAB ===");
let total = 0;
features.forEach(([cat, items]) => { console.log(`  ${cat}: ${items.length}`); total += items.length; });
console.log(`  TOTAL: ${total}`);

console.log("\n=== MISSING FROM FEATURES TAB (in intro but not features) ===");
console.log(`  ${introOnly.length} items could be added`);
introOnly.forEach(f => console.log(`  + ${f}`));
console.log(`\n=== IF ALL ADDED: ${total + introOnly.length} features ===`);
