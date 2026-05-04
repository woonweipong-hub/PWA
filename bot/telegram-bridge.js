#!/usr/bin/env node
// ── SiteShrimp Telegram Bridge ────────────────────────────────────
// Connects Telegram to PocketBase for hands-free site management.
// Workers send photos/voice/text in Telegram → bot creates defect
// entries in PocketBase → SiteShrimp app updates in real-time.
//
// Usage: node telegram-bridge.js
// Config: Set environment variables or create bot/.env file
//
// Required:
//   TG_BOT_TOKEN     — Telegram bot token from @BotFather
//   PB_URL           — PocketBase server URL
//   PB_EMAIL         — PocketBase admin or user email
//   PB_PASSWORD      — PocketBase password
//
// Optional AI (uses your own tokens):
//   AI_PROVIDER      — "gemini" | "openai" | "ollama" (default: gemini)
//   GEMINI_KEY       — Google Gemini API key
//   OPENAI_KEY       — OpenAI API key
//   OPENAI_URL       — OpenAI-compatible URL (default: https://api.openai.com)
//   OPENAI_MODEL     — Model name (default: gpt-4o-mini)
//   OLLAMA_URL       — Ollama URL (default: http://localhost:11434)
//   OLLAMA_MODEL     — Ollama model (default: llava)
//
// Optional:
//   PROJECT_ID       — Default project ID (auto-detects if not set)
//   POLL_INTERVAL    — Polling interval in ms (default: 1000)

const fs = require('fs');
const path = require('path');

// ── Load .env file if present ─────────────────────────────────────
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
      const match = line.match(/^\s*([\w]+)\s*=\s*(.+?)\s*$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    });
  }
} catch (e) { /* no .env, use environment variables */ }

// ── Config ────────────────────────────────────────────────────────
const TG_TOKEN = process.env.TG_BOT_TOKEN;
const PB_URL = (process.env.PB_URL || '').replace(/\/+$/, '');
const PB_EMAIL = process.env.PB_EMAIL;
const PB_PASSWORD = process.env.PB_PASSWORD;
const AI_PROVIDER = process.env.AI_PROVIDER || 'gemini';
const PROJECT_ID = process.env.PROJECT_ID || '';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL) || 1000;

if (!TG_TOKEN || !PB_URL || !PB_EMAIL || !PB_PASSWORD) {
  console.error('Missing required config. Set: TG_BOT_TOKEN, PB_URL, PB_EMAIL, PB_PASSWORD');
  console.error('See bot/.env.example for reference.');
  process.exit(1);
}

// ── State ─────────────────────────────────────────────────────────
let pbToken = '';
let pbUserId = '';        // bridge user id (for resolving membership)
let defaultProjectId = PROJECT_ID;
let defaultCompanyId = '';  // resolved from members.companyId on startup
let botInfo = null;
let lastUpdateId = 0;

// ── PocketBase API ────────────────────────────────────────────────
async function pbAuth() {
  const resp = await fetch(`${PB_URL}/api/collections/users/auth-with-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity: PB_EMAIL, password: PB_PASSWORD }),
  });
  if (!resp.ok) throw new Error('PocketBase auth failed: ' + (await resp.text()));
  const data = await resp.json();
  pbToken = data.token;
  pbUserId = data.record.id;
  console.log(`[PB] Authenticated as ${data.record.name || data.record.email}`);
  return data;
}

// Resolve the bridge user's company. Caches on first success. Required so
// every defect write carries companyId — RBAC tenant rules will reject
// orphaned writes once tightened, and the server-side autofill hook can't
// run before rule validation.
async function getDefaultCompanyId() {
  if (defaultCompanyId) return defaultCompanyId;
  if (!pbUserId) return '';
  try {
    const filter = encodeURIComponent(`userId="${pbUserId}"`);
    const resp = await pbApi(`/api/collections/members/records?perPage=1&filter=${filter}`);
    if (resp.items && resp.items.length > 0) {
      defaultCompanyId = resp.items[0].companyId;
      console.log(`[PB] Bridge company: ${defaultCompanyId} (member role: ${resp.items[0].role})`);
    } else {
      console.warn('[PB] Bridge user has no members row — defects will be tenant-orphaned until membership is set up.');
    }
  } catch (e) {
    console.warn('[PB] Could not resolve bridge company:', e.message);
  }
  return defaultCompanyId;
}

async function pbApi(path, opts = {}) {
  const resp = await fetch(`${PB_URL}${path}`, {
    ...opts,
    headers: { 'Authorization': 'Bearer ' + pbToken, ...(opts.headers || {}) },
  });
  if (resp.status === 401) {
    // Token expired — re-auth and retry
    await pbAuth();
    return pbApi(path, opts);
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`PB API ${path}: ${resp.status} ${text}`);
  }
  return resp.json();
}

async function pbCreate(collection, data) {
  return pbApi(`/api/collections/${collection}/records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

async function pbUploadPhoto(collection, recordId, photoBuffer, filename) {
  const form = new FormData();
  form.append('photo', new Blob([photoBuffer], { type: 'image/jpeg' }), filename);
  return pbApi(`/api/collections/${collection}/records/${recordId}`, {
    method: 'PATCH',
    body: form,
  });
}

async function getDefaultProject() {
  if (defaultProjectId) return defaultProjectId;
  try {
    const resp = await pbApi('/api/collections/projects/records?page=1&perPage=1&sort=-created');
    if (resp.items && resp.items.length > 0) {
      defaultProjectId = resp.items[0].id;
      console.log(`[PB] Default project: ${resp.items[0].name} (${defaultProjectId})`);
    }
  } catch (e) { console.warn('[PB] Could not find default project:', e.message); }
  return defaultProjectId;
}

// ── Telegram API ──────────────────────────────────────────────────
const TG_API = `https://api.telegram.org/bot${TG_TOKEN}`;

async function tg(method, body = {}) {
  const resp = await fetch(`${TG_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (!data.ok) throw new Error(`TG ${method}: ${data.description}`);
  return data.result;
}

async function tgReply(chatId, text, replyToId) {
  return tg('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...(replyToId ? { reply_to_message_id: replyToId } : {}),
  });
}

async function tgGetFile(fileId) {
  const file = await tg('getFile', { file_id: fileId });
  const resp = await fetch(`https://api.telegram.org/file/bot${TG_TOKEN}/${file.file_path}`);
  return { buffer: Buffer.from(await resp.arrayBuffer()), path: file.file_path };
}

// ── AI Processing ─────────────────────────────────────────────────
const AI_PROMPT = 'Analyze this construction defect photo. Respond in valid JSON only, no markdown: {"title":"max 5 word defect title","severity":"one of Critical Major Minor Observation","description":"2 sentence technical description","trade":"responsible trade e.g. Plumbing Electrical Waterproofing Painting Tiling Structural Carpentry Aircon General","suggested_assignee":"trade role to assign"}';

const VOICE_PROMPT = 'You are a construction site assistant. The worker just sent a voice message. Extract the defect information and respond in valid JSON only, no markdown: {"title":"max 5 word defect title","severity":"one of Critical Major Minor Observation","description":"2 sentence description based on what they said","location":"location mentioned or empty string","trade":"responsible trade","suggested_assignee":"trade role to assign"}. Here is the transcription: ';

async function analyzePhotoWithAI(base64) {
  try {
    if (AI_PROVIDER === 'gemini') {
      const key = process.env.GEMINI_KEY;
      if (!key) return null;
      const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [
          { inline_data: { mime_type: 'image/jpeg', data: base64 } },
          { text: AI_PROMPT }
        ] }] }),
      });
      const data = await resp.json();
      const parts = data.candidates?.[0]?.content?.parts || [];
      const nonThought = parts.filter(p => p.text && !p.thought);
      const text = (nonThought.length ? nonThought.pop() : parts.filter(p => p.text).pop() || {}).text || '{}';
      return JSON.parse(text.replace(/```json|```/g, '').trim());
    }
    if (AI_PROVIDER === 'openai') {
      const key = process.env.OPENAI_KEY;
      const url = (process.env.OPENAI_URL || 'https://api.openai.com').replace(/\/+$/, '');
      const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
      const resp = await fetch(`${url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({ model, max_tokens: 300, messages: [{ role: 'user', content: [
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + base64, detail: 'low' } },
          { type: 'text', text: AI_PROMPT }
        ] }] }),
      });
      const data = await resp.json();
      const text = data.choices?.[0]?.message?.content || '{}';
      return JSON.parse(text.replace(/```json|```/g, '').trim());
    }
    if (AI_PROVIDER === 'ollama') {
      const url = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, '');
      const model = process.env.OLLAMA_MODEL || 'llava';
      const resp = await fetch(`${url}/api/generate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: AI_PROMPT, images: [base64], stream: false }),
      });
      const data = await resp.json();
      const text = data.response || '{}';
      return JSON.parse(text.replace(/```json|```/g, '').trim());
    }
  } catch (e) { console.warn('[AI] Photo analysis failed:', e.message); }
  return null;
}

async function transcribeVoice(audioBuffer) {
  try {
    if (AI_PROVIDER === 'openai' || AI_PROVIDER === 'gemini') {
      // Use OpenAI Whisper for transcription (works with OpenAI-compatible APIs)
      const key = process.env.OPENAI_KEY || process.env.GEMINI_KEY;
      const url = (process.env.OPENAI_URL || 'https://api.openai.com').replace(/\/+$/, '');
      if (AI_PROVIDER === 'openai' && key) {
        const form = new FormData();
        form.append('file', new Blob([audioBuffer], { type: 'audio/ogg' }), 'voice.ogg');
        form.append('model', 'whisper-1');
        const resp = await fetch(`${url}/v1/audio/transcriptions`, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + key },
          body: form,
        });
        const data = await resp.json();
        return data.text || '';
      }
      // Gemini — use as text model to process voice description
      if (AI_PROVIDER === 'gemini' && process.env.GEMINI_KEY) {
        // Gemini doesn't do audio transcription directly via this API
        // Return null to fall back to text parsing
        return null;
      }
    }
  } catch (e) { console.warn('[AI] Voice transcription failed:', e.message); }
  return null;
}

async function processTextWithAI(text) {
  try {
    const prompt = VOICE_PROMPT + text;
    if (AI_PROVIDER === 'gemini') {
      const key = process.env.GEMINI_KEY;
      if (!key) return null;
      const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      });
      const data = await resp.json();
      const parts = data.candidates?.[0]?.content?.parts || [];
      const nonThought = parts.filter(p => p.text && !p.thought);
      const t = (nonThought.length ? nonThought.pop() : parts.filter(p => p.text).pop() || {}).text || '{}';
      return JSON.parse(t.replace(/```json|```/g, '').trim());
    }
    if (AI_PROVIDER === 'openai') {
      const key = process.env.OPENAI_KEY;
      const url = (process.env.OPENAI_URL || 'https://api.openai.com').replace(/\/+$/, '');
      const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
      const resp = await fetch(`${url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({ model, max_tokens: 300, messages: [{ role: 'user', content: prompt }] }),
      });
      const data = await resp.json();
      const t = data.choices?.[0]?.message?.content || '{}';
      return JSON.parse(t.replace(/```json|```/g, '').trim());
    }
    if (AI_PROVIDER === 'ollama') {
      const url = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, '');
      const model = process.env.OLLAMA_MODEL || 'llava';
      const resp = await fetch(`${url}/api/generate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, stream: false }),
      });
      const data = await resp.json();
      const t = data.response || '{}';
      return JSON.parse(t.replace(/```json|```/g, '').trim());
    }
  } catch (e) { console.warn('[AI] Text processing failed:', e.message); }
  return null;
}

// ── Simple text parser (no AI, near-zero latency) ─────────────────
function parseDefectText(text) {
  const lower = text.toLowerCase();
  // Try to extract severity
  let severity = 'Major';
  if (/critical|urgent|danger|emergency/i.test(text)) severity = 'Critical';
  else if (/minor|small|cosmetic/i.test(text)) severity = 'Minor';
  else if (/observation|note|fyi/i.test(text)) severity = 'Observation';

  // Try to extract location (common patterns: "level 3", "L2", "floor 5", "block A")
  let location = '';
  const locMatch = text.match(/(?:level|lvl|floor|flr|L|F)\s*(\d+)/i) || text.match(/(?:block|blk)\s*([A-Z0-9]+)/i);
  if (locMatch) location = locMatch[0];

  // Try to extract trade
  let trade = '';
  const trades = { plumb: 'Plumbing', elec: 'Electrical', paint: 'Painting', tile: 'Tiling', water: 'Waterproofing', struct: 'Structural', carp: 'Carpentry', aircon: 'Aircon', 'a/c': 'Aircon', hvac: 'Aircon' };
  for (const [key, val] of Object.entries(trades)) {
    if (lower.includes(key)) { trade = val; break; }
  }

  return {
    title: text.substring(0, 60).replace(/\n/g, ' ').trim(),
    severity,
    description: text.trim(),
    location,
    trade,
    suggested_assignee: '',
  };
}

// ── Message Handler ───────────────────────────────────────────────
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const msgId = msg.message_id;
  const from = msg.from?.first_name || msg.from?.username || 'User';

  // ── /start command ──
  if (msg.text === '/start') {
    return tgReply(chatId, [
      '<b>SiteShrimp Bot</b>',
      '',
      'Send me defect info and I\'ll log it:',
      '• 📷 <b>Photo</b> — AI analyzes the defect',
      '• 🎤 <b>Voice</b> — transcribed and logged',
      '• ✏️ <b>Text</b> — parsed and logged',
      '',
      '<b>Commands:</b>',
      '/log <i>title</i> — quick log a defect',
      '/status — show open defect counts',
      '/recent — show 5 most recent entries',
      '/help — show this message',
    ].join('\n'));
  }

  if (msg.text === '/help') return handleMessage({ ...msg, text: '/start' });

  // ── /status command ──
  if (msg.text === '/status') {
    try {
      const projectId = await getDefaultProject();
      const filter = projectId ? `projectId="${projectId}"` : '';
      const resp = await pbApi(`/api/collections/defects/records?filter=${encodeURIComponent(filter)}&perPage=500&fields=status,severity`);
      const items = resp.items || [];
      const byStatus = {};
      const bySev = {};
      items.forEach(d => {
        byStatus[d.status] = (byStatus[d.status] || 0) + 1;
        bySev[d.severity] = (bySev[d.severity] || 0) + 1;
      });
      const statusLine = ['Open', 'In Progress', 'Done', 'Verified', 'Closed'].map(s => `${s}: <b>${byStatus[s] || 0}</b>`).join('\n');
      const sevLine = ['Critical', 'Major', 'Minor', 'Observation'].map(s => `${s}: <b>${bySev[s] || 0}</b>`).join(' · ');
      return tgReply(chatId, `📊 <b>Project Status</b>\nTotal: <b>${items.length}</b>\n\n${statusLine}\n\n${sevLine}`);
    } catch (e) {
      return tgReply(chatId, '❌ Could not fetch status: ' + e.message);
    }
  }

  // ── /recent command ──
  if (msg.text === '/recent') {
    try {
      const resp = await pbApi('/api/collections/defects/records?sort=-created&perPage=5&fields=title,severity,status,location,created');
      const items = resp.items || [];
      if (items.length === 0) return tgReply(chatId, 'No entries yet.');
      const lines = items.map((d, i) => {
        const sev = { Critical: '🔴', Major: '🟠', Minor: '🟡', Observation: '🔵' }[d.severity] || '⚪';
        const date = new Date(d.created).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
        return `${sev} <b>${d.title || 'Untitled'}</b>\n    ${d.status} · ${d.location || '—'} · ${date}`;
      });
      return tgReply(chatId, `📋 <b>Recent Entries</b>\n\n${lines.join('\n\n')}`);
    } catch (e) {
      return tgReply(chatId, '❌ Could not fetch entries: ' + e.message);
    }
  }

  // ── /log command ──
  if (msg.text?.startsWith('/log ')) {
    const text = msg.text.substring(5).trim();
    if (!text) return tgReply(chatId, 'Usage: /log <i>Cracked tile level 3</i>', msgId);

    // Acknowledge instantly
    const ack = await tgReply(chatId, '📥 Logging...', msgId);

    const parsed = parseDefectText(text);
    try {
      const projectId = await getDefaultProject();
      const companyId = await getDefaultCompanyId();
      await pbCreate('defects', {
        title: parsed.title,
        severity: parsed.severity,
        description: parsed.description,
        location: parsed.location,
        component: parsed.trade,
        status: 'Open',
        entryType: 'Defect',
        loggedBy: from,
        loggedByRole: 'Field',
        companyId,
        projectId,
        source: 'telegram',
      });
      return tgReply(chatId, `✅ <b>Logged:</b> ${parsed.title}\n${parsed.severity} · ${parsed.location || 'No location'} · ${parsed.trade || 'General'}`, msgId);
    } catch (e) {
      return tgReply(chatId, '❌ Failed to log: ' + e.message, msgId);
    }
  }

  // ── Photo message ──
  if (msg.photo && msg.photo.length > 0) {
    // Acknowledge instantly (near-zero latency response)
    const ack = await tgReply(chatId, '📥 Photo received — analyzing...', msgId);
    const caption = msg.caption || '';

    try {
      // Get highest resolution photo
      const photo = msg.photo[msg.photo.length - 1];
      const { buffer } = await tgGetFile(photo.file_id);
      const base64 = buffer.toString('base64');

      // AI analysis + text parsing in parallel
      const [aiResult] = await Promise.all([
        analyzePhotoWithAI(base64),
      ]);

      const captionParsed = caption ? parseDefectText(caption) : {};
      const result = {
        title: aiResult?.title || captionParsed.title || 'Photo entry',
        severity: aiResult?.severity || captionParsed.severity || 'Major',
        description: aiResult?.description || captionParsed.description || caption || '',
        location: captionParsed.location || '',
        trade: aiResult?.trade || captionParsed.trade || '',
        assignee: aiResult?.suggested_assignee || '',
      };

      const projectId = await getDefaultProject();
      const companyId = await getDefaultCompanyId();
      const record = await pbCreate('defects', {
        title: result.title,
        severity: result.severity,
        description: result.description,
        location: result.location,
        component: result.trade,
        status: 'Open',
        entryType: 'Defect',
        loggedBy: from,
        loggedByRole: 'Field',
        companyId,
        projectId,
        photo: 'data:image/jpeg;base64,' + base64,
        source: 'telegram',
      });

      return tgReply(chatId, [
        `✅ <b>${result.title}</b>`,
        `${result.severity} · ${result.trade || 'General'}`,
        result.location ? `📍 ${result.location}` : '',
        result.description ? `📝 ${result.description}` : '',
        `👤 Logged by ${from}`,
      ].filter(Boolean).join('\n'), msgId);
    } catch (e) {
      return tgReply(chatId, '❌ Failed to process photo: ' + e.message, msgId);
    }
  }

  // ── Voice message ──
  if (msg.voice || msg.audio) {
    const ack = await tgReply(chatId, '🎤 Voice received — processing...', msgId);

    try {
      const fileId = (msg.voice || msg.audio).file_id;
      const { buffer } = await tgGetFile(fileId);

      // Try transcription
      let transcript = await transcribeVoice(buffer);
      let result;

      if (transcript) {
        // AI-powered: transcribe → extract defect data
        result = await processTextWithAI(transcript);
        if (!result || !result.title) result = parseDefectText(transcript);
      } else {
        // Fallback: ask user to type instead
        return tgReply(chatId, '🎤 Voice received but transcription unavailable with current AI provider.\n\nTip: Use /log <i>description</i> or send a photo instead.', msgId);
      }

      const projectId = await getDefaultProject();
      const companyId = await getDefaultCompanyId();
      await pbCreate('defects', {
        title: result.title || 'Voice entry',
        severity: result.severity || 'Major',
        description: result.description || transcript,
        location: result.location || '',
        component: result.trade || '',
        status: 'Open',
        entryType: 'Defect',
        loggedBy: from,
        loggedByRole: 'Field',
        companyId,
        projectId,
        source: 'telegram-voice',
      });

      return tgReply(chatId, [
        `✅ <b>${result.title}</b>`,
        `${result.severity} · ${result.trade || 'General'}`,
        result.location ? `📍 ${result.location}` : '',
        `🎤 "${transcript.substring(0, 100)}${transcript.length > 100 ? '...' : ''}"`,
        `👤 Logged by ${from}`,
      ].filter(Boolean).join('\n'), msgId);
    } catch (e) {
      return tgReply(chatId, '❌ Failed to process voice: ' + e.message, msgId);
    }
  }

  // ── Plain text message (not a command) ──
  if (msg.text && !msg.text.startsWith('/')) {
    const text = msg.text.trim();
    if (text.length < 5) return; // Ignore short messages

    const ack = await tgReply(chatId, '📥 Processing...', msgId);

    // Try AI first, fall back to simple parser
    let result = await processTextWithAI(text);
    if (!result || !result.title) result = parseDefectText(text);

    try {
      const projectId = await getDefaultProject();
      const companyId = await getDefaultCompanyId();
      await pbCreate('defects', {
        title: result.title,
        severity: result.severity || 'Major',
        description: result.description || text,
        location: result.location || '',
        component: result.trade || '',
        status: 'Open',
        entryType: 'Defect',
        loggedBy: from,
        loggedByRole: 'Field',
        companyId,
        projectId,
        source: 'telegram',
      });

      return tgReply(chatId, [
        `✅ <b>${result.title}</b>`,
        `${result.severity} · ${result.trade || 'General'}`,
        result.location ? `📍 ${result.location}` : '',
        `👤 Logged by ${from}`,
      ].filter(Boolean).join('\n'), msgId);
    } catch (e) {
      return tgReply(chatId, '❌ Failed to log: ' + e.message, msgId);
    }
  }
}

// ── Long Polling Loop ─────────────────────────────────────────────
async function poll() {
  try {
    const updates = await tg('getUpdates', {
      offset: lastUpdateId + 1,
      timeout: 30,
      allowed_updates: ['message'],
    });

    for (const update of updates) {
      lastUpdateId = update.update_id;
      if (update.message) {
        // Process each message without blocking the poll loop
        handleMessage(update.message).catch(e => {
          console.error('[MSG] Error handling message:', e.message);
        });
      }
    }
  } catch (e) {
    console.error('[POLL] Error:', e.message);
    await new Promise(r => setTimeout(r, 3000)); // Wait before retry
  }

  // Continue polling
  setTimeout(poll, POLL_INTERVAL);
}

// ── Startup ───────────────────────────────────────────────────────
async function start() {
  console.log('──────────────────────────────────────');
  console.log('  SiteShrimp Telegram Bridge');
  console.log('──────────────────────────────────────');

  // Auth with PocketBase
  await pbAuth();
  await getDefaultProject();

  // Get bot info
  botInfo = await tg('getMe');
  console.log(`[TG] Bot: @${botInfo.username} (${botInfo.first_name})`);
  console.log(`[AI] Provider: ${AI_PROVIDER}`);
  console.log(`[PB] Server: ${PB_URL}`);
  console.log('──────────────────────────────────────');
  console.log('Listening for messages...\n');

  // Start polling
  poll();
}

start().catch(e => {
  console.error('Failed to start:', e.message);
  process.exit(1);
});
