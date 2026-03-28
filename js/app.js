/* SiteSnag — app.js
   Construction defect reporting PWA.
   Talks to Google Apps Script backend (Gemini + Sheets + Drive). */

// ─── Config (localStorage) ───────────────────────────────────────────
const Config = {
  get name()       { return localStorage.getItem('ss_name') || ''; },
  set name(v)      { localStorage.setItem('ss_name', v); },
  get project()    { return localStorage.getItem('ss_project') || ''; },
  set project(v)   { localStorage.setItem('ss_project', v); },
  get apiUrl()     { return localStorage.getItem('ss_api') || ''; },
  set apiUrl(v)    { localStorage.setItem('ss_api', v); },
  get geminiKey()  { return localStorage.getItem('ss_gemini') || ''; },
  set geminiKey(v) { localStorage.setItem('ss_gemini', v); },
  get ready()      { return !!(this.name && this.apiUrl); },
};

// ─── Category / Defect-Type / Trade data (mirrors app.py) ───────────
const CATEGORIES = {
  'Structural': ['Column','Beam','Slab','Foundation','Retaining Wall'],
  'Architectural': ['Door','Window','Wall','Floor','Ceiling','Roof','Staircase','Fence/Railing','Balcony','Corridor'],
  'Carpentry': ['Cabinet','Wardrobe','Countertop','Skirting','Shelf'],
  'M&E': ['Plumbing','Electrical','Aircon','Lighting','Sanitary','Fire Safety'],
  'Finishes': ['Painting','Tiling','Waterproofing','Plastering'],
  'External/Landscape': ['Driveway','Walkway','Garden/Planting','Drain/Gutter','Car Park','Swimming Pool','Playground'],
  'General': ['General'],
};

const DEFECT_TYPES = {
  Column:['Crack','Spalling','Exposed rebar','Misaligned','Honeycombing'],
  Beam:['Crack','Spalling','Exposed rebar','Deflection','Sagging'],
  Slab:['Crack','Spalling','Exposed rebar','Deflection','Uneven'],
  Foundation:['Settlement','Crack','Heaving','Water seepage'],
  'Retaining Wall':['Crack','Tilting','Bulging','Seepage'],
  Door:['Misaligned',"Won't close",'Gap','Scratch','Broken hinge','Defective lock'],
  Window:["Won't open",'Seal gap','Cracked glass','Water ingress','Faulty latch'],
  Wall:['Crack','Bulging','Damp patch','Uneven','Hole','Mould','Peeling paint'],
  Floor:['Scratch','Uneven','Hollow','Stain','Chipped','Cracked tile'],
  Ceiling:['Sagging','Water mark','Crack','Gap','Mould','Peeling paint'],
  Roof:['Leak','Missing tile','Ponding','Crack','Sagging'],
  Staircase:['Uneven step','Crack','Loose railing','Chipped'],
  'Fence/Railing':['Loose','Rust','Missing section','Misaligned'],
  Balcony:['Crack','Water ponding','Loose railing','Spalling'],
  Corridor:['Crack','Uneven floor','Chipped','Stain'],
  Cabinet:['Misaligned','Scratch','Broken hinge','Swollen'],
  Wardrobe:['Misaligned door','Broken track','Scratch','Swollen'],
  Countertop:['Crack','Chip','Stain','Scratch'],
  Skirting:['Gap','Loose','Misaligned','Chipped'],
  Shelf:['Sagging','Loose bracket','Scratch'],
  Plumbing:['Leak','Blockage','Low pressure','Dripping tap','Burst pipe'],
  Electrical:['No power','Faulty switch','Exposed wiring','Flickering light'],
  Aircon:['Not cooling','Leaking','Noisy','Bad smell'],
  Lighting:['Not working','Flickering','Wrong colour','Faulty sensor'],
  Sanitary:['Cracked basin','Loose WC','Faulty flush','Drain smell'],
  'Fire Safety':['Missing extinguisher','Faulty alarm','Blocked exit'],
  Painting:['Peeling','Stain','Uneven coat','Crack line','Bubbling','Colour mismatch'],
  Tiling:['Cracked','Loose','Uneven grout','Hollow','Chipped','Lippage'],
  Waterproofing:['Seepage','Damp wall','Water mark','Ponding'],
  Plastering:['Crack','Uneven','Hollow','Bulging'],
  Driveway:['Crack','Uneven','Ponding','Pothole'],
  Walkway:['Crack','Uneven','Trip hazard','Loose paver'],
  'Garden/Planting':['Dead plant','Overgrown','Soil erosion'],
  'Drain/Gutter':['Blocked','Crack','Misaligned','Overflow'],
  'Car Park':['Crack','Ponding','Faded marking','Pothole'],
  'Swimming Pool':['Leak','Cracked tile','Faulty pump'],
  Playground:['Damaged equipment','Loose bolt','Rust','Worn surface'],
  General:['Other'],
};

const AUTO_TRADE = {
  Column:'Structural Engineer',Beam:'Structural Engineer',Slab:'Structural Engineer',
  Foundation:'Structural Engineer','Retaining Wall':'Structural Engineer',
  Door:'Carpenter',Window:'Carpenter',Wall:'Painter',Floor:'Flooring Contractor',
  Ceiling:'Ceiling Contractor',Roof:'Roofing Contractor',Staircase:'General Contractor',
  'Fence/Railing':'Metal Worker',Balcony:'General Contractor',Corridor:'General Contractor',
  Cabinet:'Carpenter',Wardrobe:'Carpenter',Countertop:'Carpenter',Skirting:'Carpenter',Shelf:'Carpenter',
  Plumbing:'Plumber',Electrical:'Electrician',Aircon:'Aircon Contractor',Lighting:'Electrician',
  Sanitary:'Plumber','Fire Safety':'Fire Safety Contractor',
  Painting:'Painter',Tiling:'Tiler',Waterproofing:'Waterproofing Contractor',Plastering:'Plasterer',
  Driveway:'Landscape Contractor',Walkway:'Landscape Contractor','Garden/Planting':'Landscape Contractor',
  'Drain/Gutter':'Landscape Contractor','Car Park':'General Contractor',
  'Swimming Pool':'Pool Contractor',Playground:'General Contractor',General:'TBD',
};

// ─── DOM Refs ────────────────────────────────────────────────────────
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ─── State ───────────────────────────────────────────────────────────
let currentView = 'setup';
let photoBase64 = '';     // current report photo
let photoFile = null;
let voiceTranscript = '';
let walkItems = [];       // [{base64, transcript, file}]
let walkResults = [];     // AI-analyzed walk defects
let allDefects = [];      // cached from Sheet

// ─── API (auto-detects backend: PocketBase or Google Apps Script) ────
function isPocketBase() {
  return Config.apiUrl && !Config.apiUrl.includes('script.google.com');
}

const API = {
  // ── Google Apps Script backend ──
  async post(action, data = {}) {
    const url = Config.apiUrl;
    if (!url) throw new Error('Backend URL not configured');
    const payload = { action, ...data };
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload),
      redirect: 'follow',
    });
    const text = await resp.text();
    try { return JSON.parse(text); }
    catch { return { success: false, raw: text }; }
  },

  // ── PocketBase helpers ──
  async pbFetch(path, options = {}) {
    const base = Config.apiUrl.replace(/\/+$/, '');
    const resp = await fetch(`${base}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers },
    });
    return resp.json();
  },

  // ── Unified API methods (work with both backends) ──

  async analyzePhoto(base64, context) {
    if (isPocketBase()) {
      // PocketBase: call Gemini directly from client (or server hook handles it)
      return this.pbFetch('/api/sitesnag/analyze', {
        method: 'POST',
        body: JSON.stringify({ base64, context }),
      }).catch(() => ({ success: false }));
    }
    return this.post('analyze', { base64, context: context || '', geminiKey: Config.geminiKey });
  },

  async uploadPhoto(base64, filename) {
    if (isPocketBase()) {
      // PocketBase handles photos as part of the defect record
      return { success: true, url: '' };
    }
    return this.post('photo', { base64, fileName: filename, mimeType: 'image/jpeg' });
  },

  async submitDefect(defect) {
    if (isPocketBase()) {
      // Convert base64 photo to file upload via FormData
      const formData = new FormData();
      for (const [key, val] of Object.entries(defect)) {
        if (key === 'photo_base64' || key === 'photo_dataUrl') continue;
        formData.append(key, val || '');
      }
      // Attach photo as file if present
      if (defect.photo_base64) {
        const byteString = atob(defect.photo_base64);
        const ab = new ArrayBuffer(byteString.length);
        const ia = new Uint8Array(ab);
        for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
        const blob = new Blob([ab], { type: 'image/jpeg' });
        formData.append('photo', blob, `${defect.defect_id || 'photo'}.jpg`);
      }
      const base = Config.apiUrl.replace(/\/+$/, '');
      const resp = await fetch(`${base}/api/collections/defects/records`, {
        method: 'POST',
        body: formData,
      });
      const result = await resp.json();
      return { success: !result.code, defect_id: result.defect_id || result.id };
    }
    return this.post('sheet', { data: defect });
  },

  async readDefects() {
    if (isPocketBase()) {
      const result = await this.pbFetch('/api/collections/defects/records?perPage=500&sort=-created');
      const rows = (result.items || []).map((item) => {
        // Build photo URL from PocketBase file path
        let photoUrl = '';
        if (item.photo) {
          const base = Config.apiUrl.replace(/\/+$/, '');
          photoUrl = `${base}/api/files/defects/${item.id}/${item.photo}`;
        }
        return { ...item, photo_url: photoUrl };
      });
      return { success: true, rows };
    }
    return this.post('read');
  },

  async resolveDefect(defectId) {
    if (isPocketBase()) {
      // Find record by defect_id
      const result = await this.pbFetch(`/api/collections/defects/records?filter=(defect_id='${defectId}')`);
      if (result.items && result.items.length > 0) {
        const record = result.items[0];
        const now = new Date().toISOString().split('T')[0];
        await this.pbFetch(`/api/collections/defects/records/${record.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'Completed', resolved_date: now }),
        });
        return { success: true };
      }
      return { success: false, error: 'Defect not found' };
    }
    const now = new Date().toISOString().split('T')[0];
    return this.post('update', { defect_id: defectId, field: 'status', value: 'Completed' })
      .then(() => this.post('update', { defect_id: defectId, field: 'resolved_date', value: now }));
  },

  async nextDefectId() {
    if (isPocketBase()) {
      // PocketBase hook auto-generates IDs — return placeholder
      return 'AUTO';
    }
    const result = await this.post('next_id');
    return result.defect_id || 'DEF-????';
  },
};

// ─── Toast ───────────────────────────────────────────────────────────
function showToast(msg, type = '', duration = 3000) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (type ? ` toast-${type}` : '');
  el.hidden = false;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.hidden = true; }, duration);
}

// ─── Loading ─────────────────────────────────────────────────────────
function showLoading(text = 'Analyzing...') {
  $('#loading-text').textContent = text;
  $('#loading').hidden = false;
}
function hideLoading() { $('#loading').hidden = true; }

// ─── Navigation ──────────────────────────────────────────────────────
function navigate(view) {
  $$('.view').forEach((v) => (v.hidden = true));
  $(`#view-${view}`).hidden = false;
  currentView = view;

  // Show/hide bottom nav
  const showNav = ['home', 'report', 'walk', 'history'].includes(view);
  $('#bottom-nav').hidden = !showNav;

  // Update active nav button
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));

  // View-specific init
  if (view === 'home') refreshHome();
  if (view === 'history') refreshHistory();
  if (view === 'report') initReport();
  if (view === 'walk') initWalk();
  if (view === 'settings') initSettings();
}

// ─── Setup ───────────────────────────────────────────────────────────
// Default hosted backend URL (pre-filled so users don't need to type it)
const DEFAULT_API_URL = 'https://sitesnag.duckdns.org';

function initSetup() {
  // Check for ?api= query param (viral link)
  const params = new URLSearchParams(window.location.search);
  const apiFromUrl = params.get('api');
  if (apiFromUrl) {
    Config.apiUrl = apiFromUrl;
    $('#setup-api').value = apiFromUrl;
    // Clean URL
    window.history.replaceState({}, '', window.location.pathname);
  } else if (!Config.apiUrl) {
    // Pre-fill with default hosted backend
    $('#setup-api').value = DEFAULT_API_URL;
  }
}

$('#form-setup').addEventListener('submit', async (e) => {
  e.preventDefault();
  Config.name = $('#setup-name').value.trim();
  Config.project = $('#setup-project').value.trim();

  const mode = localStorage.getItem('ss_mode') || 'hosted';

  if (mode === 'selfhost') {
    // Google Apps Script mode
    Config.apiUrl = ($('#setup-api-gs') && $('#setup-api-gs').value.trim()) || '';
    Config.geminiKey = ($('#setup-gemini') && $('#setup-gemini').value.trim()) || '';
    const sheetUrl = ($('#setup-sheet') && $('#setup-sheet').value.trim()) || '';
    if (sheetUrl || Config.geminiKey) {
      showLoading('Connecting to your Google Sheet...');
      try {
        await API.post('configure', { sheetUrl, geminiKey: Config.geminiKey });
        hideLoading();
      } catch (err) {
        hideLoading();
        console.warn('Configure call failed:', err);
      }
    }
  } else {
    // PocketBase hosted mode
    Config.apiUrl = $('#setup-api').value.trim();
  }

  showToast('Setup complete!', 'success');
  navigate('home');
});

// ─── Home ────────────────────────────────────────────────────────────
async function refreshHome() {
  try {
    const result = await API.readDefects();
    if (result.success && result.rows) {
      allDefects = result.rows;
      const outstanding = allDefects.filter((d) => (d.status || '').toLowerCase() !== 'completed').length;
      const resolved = allDefects.filter((d) => (d.status || '').toLowerCase() === 'completed').length;
      $('#stat-outstanding').textContent = outstanding;
      $('#stat-resolved').textContent = resolved;
      $('#stat-total').textContent = allDefects.length;

      // Recent 5
      renderDefectList('#recent-list', allDefects.slice(-5).reverse());
    }
  } catch (err) {
    console.warn('Failed to load defects:', err);
  }
}

function renderDefectList(selector, defects) {
  const container = $(selector);
  if (!defects.length) {
    container.innerHTML = '<p class="empty-state">No defects found.</p>';
    return;
  }
  container.innerHTML = defects.map((d) => {
    const statusClass = (d.status || '').toLowerCase() === 'completed' ? 'completed' : 'outstanding';
    const sevClass = (d.severity || 'medium').toLowerCase();
    const photoHtml = d.photo_url
      ? `<img class="defect-thumb" src="${escapeHtml(d.photo_url)}" alt="">`
      : `<div class="defect-thumb"></div>`;
    return `
      <div class="defect-card" data-id="${escapeHtml(d.defect_id || '')}">
        ${photoHtml}
        <div class="defect-info">
          <span class="defect-id">${escapeHtml(d.defect_id || '')}</span>
          <span class="badge badge-${statusClass}">${escapeHtml(d.status || 'Outstanding')}</span>
          <span class="badge badge-${sevClass}">${escapeHtml(d.severity || '')}</span>
          <div class="defect-desc">${escapeHtml(d.description || d.defect_type || '')}</div>
          <div class="defect-meta">${escapeHtml(d.category || '')} &middot; ${escapeHtml(d.unit || '')} &middot; ${escapeHtml(d.location || '')}</div>
        </div>
      </div>`;
  }).join('');

  // Make cards tappable — open detail modal
  container.querySelectorAll('.defect-card').forEach((card) => {
    card.addEventListener('click', () => {
      const id = card.dataset.id;
      if (id) openDefectModal(id);
    });
  });
}

// ─── Report ──────────────────────────────────────────────────────────
function initReport() {
  $('#report-project').value = Config.project;
  $('#report-unit').value = '';
  $('#report-location').value = '';
  $('#report-notes').value = '';
  clearPhoto();
  clearVoice();
}

function clearPhoto() {
  photoBase64 = '';
  photoFile = null;
  $('#photo-preview').hidden = true;
  $('#label-photo').style.display = '';
  $('#input-photo').value = '';
}

function clearVoice() {
  voiceTranscript = '';
  $('#voice-result').hidden = true;
  $('#voice-text').textContent = '';
}

$('#input-photo').addEventListener('change', handlePhotoSelect);
$('#btn-remove-photo').addEventListener('click', clearPhoto);
$('#btn-clear-voice').addEventListener('click', clearVoice);

function handlePhotoSelect(e) {
  const file = e.target.files[0];
  if (!file) return;
  photoFile = file;
  const reader = new FileReader();
  reader.onload = (ev) => {
    const dataUrl = ev.target.result;
    photoBase64 = dataUrl.split(',')[1]; // strip data:image/...;base64,
    $('#photo-img').src = dataUrl;
    $('#photo-preview').hidden = false;
    $('#label-photo').style.display = 'none';
  };
  reader.readAsDataURL(file);
}

// ─── Voice (Web Speech API) ──────────────────────────────────────────
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let isRecording = false;

function initSpeech() {
  if (!SpeechRecognition) return;
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  let finalTranscript = '';
  recognition.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalTranscript += t + ' ';
      else interim += t;
    }
    const txt = (finalTranscript + interim).trim();
    $('#voice-text').textContent = txt || 'Listening...';
    $('#voice-result').hidden = false;
    voiceTranscript = finalTranscript.trim();
  };

  recognition.onend = () => {
    isRecording = false;
    $('#btn-voice').classList.remove('recording');
    $('#btn-voice').querySelector('span').textContent = 'Hold to Speak';
    if ($('#walk-voice-btn')) $('#walk-voice-btn').classList.remove('recording');
  };

  recognition.onerror = (e) => {
    if (e.error !== 'no-speech') console.warn('Speech error:', e.error);
    isRecording = false;
    $('#btn-voice').classList.remove('recording');
  };
}

function startRecording(btn) {
  if (!recognition) { showToast('Speech recognition not supported in this browser', 'error'); return; }
  recognition._finalTranscript = '';
  try {
    recognition.start();
    isRecording = true;
    btn.classList.add('recording');
    const span = btn.querySelector('span');
    if (span) span.textContent = 'Listening...';
  } catch { /* already started */ }
}

function stopRecording(btn) {
  if (recognition && isRecording) {
    recognition.stop();
    isRecording = false;
    btn.classList.remove('recording');
  }
}

// Hold-to-speak for Report
$('#btn-voice').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  startRecording($('#btn-voice'));
});
$('#btn-voice').addEventListener('pointerup', () => stopRecording($('#btn-voice')));
$('#btn-voice').addEventListener('pointerleave', () => stopRecording($('#btn-voice')));

// ─── Analyze ─────────────────────────────────────────────────────────
$('#btn-analyze').addEventListener('click', async () => {
  if (!photoBase64 && !voiceTranscript && !$('#report-notes').value.trim()) {
    showToast('Add a photo, voice note, or description first', 'error');
    return;
  }

  const context = [
    voiceTranscript,
    $('#report-notes').value.trim(),
    `Project: ${$('#report-project').value.trim()}`,
    `Unit: ${$('#report-unit').value.trim()}`,
    `Location: ${$('#report-location').value.trim()}`,
  ].filter(Boolean).join('. ');

  showLoading('AI is analyzing...');

  try {
    let fields = {};

    if (photoBase64) {
      const result = await API.analyzePhoto(photoBase64, context);
      if (result.success && result.fields) {
        fields = result.fields;
      } else {
        // Fallback: use context only
        fields = extractFromText(context);
      }
    } else {
      fields = extractFromText(context);
    }

    // Fill review form
    populateReview(fields);
    hideLoading();
    navigate('review');
  } catch (err) {
    hideLoading();
    showToast('Analysis failed: ' + err.message, 'error');
    // Still go to review with what we have
    populateReview(extractFromText(context));
    navigate('review');
  }
});

function populateReview(fields) {
  // Photo
  if (photoBase64) {
    $('#review-photo').src = 'data:image/jpeg;base64,' + photoBase64;
    $('#review-photo-wrap').hidden = false;
  } else {
    $('#review-photo-wrap').hidden = true;
  }

  // Populate category dropdown
  const catSelect = $('#review-category');
  catSelect.innerHTML = '';
  for (const [group, items] of Object.entries(CATEGORIES)) {
    const optgroup = document.createElement('optgroup');
    optgroup.label = group;
    items.forEach((cat) => {
      const opt = document.createElement('option');
      opt.value = cat;
      opt.textContent = cat;
      if (cat === fields.category) opt.selected = true;
      optgroup.appendChild(opt);
    });
    catSelect.appendChild(optgroup);
  }
  if (!fields.category) catSelect.value = 'General';

  updateDefectTypeDropdown(catSelect.value);

  $('#review-location').value = fields.location || ($('#report-location') ? $('#report-location').value.trim() : '') || '';
  $('#review-severity').value = fields.severity || 'Medium';
  $('#review-description').value = fields.description || voiceTranscript || '';
  $('#review-trade').value = fields.trade || AUTO_TRADE[catSelect.value] || 'TBD';
  $('#review-target-date').value = fields.target_fix_date || '';

  // Set defect type after dropdown is populated
  if (fields.defect_type) {
    const dtSelect = $('#review-defect-type');
    for (const opt of dtSelect.options) {
      if (opt.value === fields.defect_type) { opt.selected = true; break; }
    }
  }
}

function updateDefectTypeDropdown(category) {
  const dtSelect = $('#review-defect-type');
  dtSelect.innerHTML = '';
  const types = DEFECT_TYPES[category] || ['Other'];
  types.forEach((t) => {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t;
    dtSelect.appendChild(opt);
  });
}

$('#review-category').addEventListener('change', (e) => {
  updateDefectTypeDropdown(e.target.value);
  $('#review-trade').value = AUTO_TRADE[e.target.value] || 'TBD';
});

// ─── Submit Defect ───────────────────────────────────────────────────
$('#btn-submit').addEventListener('click', async () => {
  showLoading('Submitting...');
  try {
    // Get defect ID (PocketBase auto-generates, Apps Script needs explicit call)
    const defectId = await API.nextDefectId();

    // Upload photo (for Apps Script — PocketBase handles it in submitDefect)
    let photoUrl = '';
    if (photoBase64 && !isPocketBase()) {
      const uploadResult = await API.uploadPhoto(photoBase64, `${defectId}.jpg`);
      photoUrl = uploadResult.url || '';
    }

    const defect = {
      defect_id: defectId === 'AUTO' ? '' : defectId,
      status: 'Outstanding',
      timestamp_utc: new Date().toISOString().replace('T', ' ').split('.')[0] + 'Z',
      user_name: Config.name,
      telegram_user: Config.name,
      project: $('#report-project').value.trim() || Config.project || 'TBD',
      unit: $('#report-unit').value.trim() || 'TBD',
      location: $('#review-location').value.trim() || 'TBD',
      category: $('#review-category').value,
      defect_type: $('#review-defect-type').value,
      severity: $('#review-severity').value,
      description: $('#review-description').value.trim(),
      trade: $('#review-trade').value.trim(),
      assigned_to: '',
      target_fix_date: $('#review-target-date').value,
      resolved_date: '',
      input_source: 'pwa',
      photo_url: photoUrl,
      photo_base64: isPocketBase() ? photoBase64 : '',
      initiated_by: Config.name,
      responsible_party: '',
      follow_up_by: '',
      remarks: '',
      cost: '',
      quality: '',
    };

    await API.submitDefect(defect);
    hideLoading();
    showToast(`${defectId} submitted!`, 'success');
    navigate('home');
  } catch (err) {
    hideLoading();
    showToast('Submit failed: ' + err.message, 'error');
  }
});

// ─── Walk Mode ───────────────────────────────────────────────────────
function initWalk() {
  $('#walk-project').value = Config.project;
  $('#walk-unit').value = '';
  $('#walk-location').value = '';
  walkItems = [];
  walkResults = [];
  renderWalkItems();
}

$('#walk-photo-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    const dataUrl = ev.target.result;
    const b64 = dataUrl.split(',')[1];
    walkItems.push({ base64: b64, dataUrl, transcript: '', type: 'photo' });
    renderWalkItems();
  };
  reader.readAsDataURL(file);
  e.target.value = '';
});

// Walk voice
$('#walk-voice-btn').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  voiceTranscript = '';
  $('#voice-text').textContent = '';
  startRecording($('#walk-voice-btn'));
});
$('#walk-voice-btn').addEventListener('pointerup', () => {
  stopRecording($('#walk-voice-btn'));
  if (voiceTranscript) {
    walkItems.push({ base64: '', dataUrl: '', transcript: voiceTranscript, type: 'voice' });
    voiceTranscript = '';
    renderWalkItems();
  }
});
$('#walk-voice-btn').addEventListener('pointerleave', () => stopRecording($('#walk-voice-btn')));

function renderWalkItems() {
  const container = $('#walk-items');
  $('#walk-count').textContent = `${walkItems.length} items`;
  $('#btn-walk-process').disabled = walkItems.length === 0;

  if (!walkItems.length) {
    container.innerHTML = '<p class="empty-state" style="padding:20px">Add photos or voice notes to start.</p>';
    return;
  }

  container.innerHTML = walkItems.map((item, i) => {
    const thumbHtml = item.dataUrl
      ? `<img class="walk-item-thumb" src="${item.dataUrl}" alt="">`
      : `<div class="walk-item-thumb" style="display:flex;align-items:center;justify-content:center;font-size:1.5rem">🎤</div>`;
    return `
      <div class="walk-item">
        ${thumbHtml}
        <div class="walk-item-info">
          <span class="walk-item-num">#${i + 1} ${item.type === 'photo' ? 'Photo' : 'Voice'}</span>
          <span class="walk-item-text">${escapeHtml(item.transcript || 'Photo captured')}</span>
        </div>
        <button class="walk-item-remove" data-idx="${i}">&times;</button>
      </div>`;
  }).join('');

  container.querySelectorAll('.walk-item-remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      walkItems.splice(parseInt(btn.dataset.idx), 1);
      renderWalkItems();
    });
  });
}

// Process all walk items
$('#btn-walk-process').addEventListener('click', async () => {
  if (!walkItems.length) return;

  showLoading(`Processing ${walkItems.length} items...`);
  walkResults = [];

  const project = $('#walk-project').value.trim() || Config.project || 'TBD';
  const unit = $('#walk-unit').value.trim() || 'TBD';
  const walkLocation = $('#walk-location').value.trim() || '';

  for (let i = 0; i < walkItems.length; i++) {
    $('#loading-text').textContent = `Analyzing item ${i + 1} of ${walkItems.length}...`;
    const item = walkItems[i];
    const context = [item.transcript, `Project: ${project}`, `Unit: ${unit}`, walkLocation ? `Location: ${walkLocation}` : ''].filter(Boolean).join('. ');

    try {
      let fields = {};
      if (item.base64) {
        const result = await API.analyzePhoto(item.base64, context);
        fields = (result.success && result.fields) ? result.fields : extractFromText(context);
      } else {
        fields = extractFromText(item.transcript + `. Project: ${project}. Unit: ${unit}`);
      }
      if (!fields.location && walkLocation) fields.location = walkLocation;
      walkResults.push({ ...fields, _base64: item.base64, _project: project, _unit: unit });
    } catch {
      walkResults.push({ description: item.transcript || 'Photo item', _base64: item.base64, _project: project, _unit: unit });
    }
  }

  hideLoading();
  renderWalkReview();
  navigate('walk-review');
});

function renderWalkReview() {
  const container = $('#walk-review-list');
  const catOptions = Object.entries(CATEGORIES).map(([group, items]) =>
    `<optgroup label="${group}">${items.map(c => `<option value="${c}">${c}</option>`).join('')}</optgroup>`
  ).join('');
  const sevOptions = ['Critical','High','Medium','Low'].map(s => `<option value="${s}">${s}</option>`).join('');

  container.innerHTML = walkResults.map((r, i) => {
    const photoHtml = r._base64 ? `<img src="data:image/jpeg;base64,${r._base64}" alt="">` : '';
    return `
      <div class="walk-review-item" data-idx="${i}">
        ${photoHtml}
        <div style="font-weight:700;color:var(--primary);margin-bottom:8px">#${i + 1}</div>
        <div class="field-row">
          <label class="field-label">Category
            <select class="wr-category" data-idx="${i}">${catOptions}</select>
          </label>
          <label class="field-label">Severity
            <select class="wr-severity" data-idx="${i}">${sevOptions}</select>
          </label>
        </div>
        <label class="field-label">Location
          <input type="text" class="wr-location" data-idx="${i}" value="${escapeHtml(r.location || '')}">
        </label>
        <label class="field-label">Defect Type
          <input type="text" class="wr-defect-type" data-idx="${i}" value="${escapeHtml(r.defect_type || '')}">
        </label>
        <label class="field-label">Description
          <textarea class="wr-description" data-idx="${i}" rows="3">${escapeHtml(r.description || '')}</textarea>
        </label>
        <label class="field-label">Trade
          <input type="text" class="wr-trade" data-idx="${i}" value="${escapeHtml(r.trade || AUTO_TRADE[r.category] || '')}">
        </label>
      </div>`;
  }).join('');

  // Set selected values for dropdowns after rendering
  walkResults.forEach((r, i) => {
    const catSelect = container.querySelector(`.wr-category[data-idx="${i}"]`);
    if (catSelect && r.category) catSelect.value = r.category;
    const sevSelect = container.querySelector(`.wr-severity[data-idx="${i}"]`);
    if (sevSelect && r.severity) sevSelect.value = r.severity;
  });

  // Auto-fill trade when category changes
  container.querySelectorAll('.wr-category').forEach(sel => {
    sel.addEventListener('change', (e) => {
      const idx = e.target.dataset.idx;
      const trade = container.querySelector(`.wr-trade[data-idx="${idx}"]`);
      if (trade) trade.value = AUTO_TRADE[e.target.value] || 'TBD';
    });
  });
}

// Submit all walk defects — reads from editable form fields
$('#btn-walk-submit').addEventListener('click', async () => {
  const items = $$('#walk-review-list .walk-review-item');
  showLoading(`Submitting ${items.length} defects...`);

  let submitted = 0;
  for (let i = 0; i < items.length; i++) {
    $('#loading-text').textContent = `Submitting ${i + 1} of ${items.length}...`;
    const item = items[i];
    const idx = parseInt(item.dataset.idx);
    const r = walkResults[idx] || {};

    // Read user-edited values from form fields
    const category = item.querySelector('.wr-category')?.value || r.category || 'General';
    const severity = item.querySelector('.wr-severity')?.value || r.severity || 'Medium';
    const location = item.querySelector('.wr-location')?.value?.trim() || r.location || 'TBD';
    const defectType = item.querySelector('.wr-defect-type')?.value?.trim() || r.defect_type || '';
    const description = item.querySelector('.wr-description')?.value?.trim() || r.description || '';
    const trade = item.querySelector('.wr-trade')?.value?.trim() || AUTO_TRADE[category] || 'TBD';

    try {
      const defectId = await API.nextDefectId();
      let photoUrl = '';
      if (r._base64) {
        const uploadResult = await API.uploadPhoto(r._base64, `${defectId}.jpg`);
        photoUrl = uploadResult.url || '';
      }

      const defect = {
        defect_id: defectId,
        status: 'Outstanding',
        timestamp_utc: new Date().toISOString().replace('T', ' ').split('.')[0] + 'Z',
        telegram_user: Config.name,
        project: r._project || Config.project || 'TBD',
        unit: r._unit || 'TBD',
        location: location,
        category: category,
        defect_type: defectType,
        severity: severity,
        description: description,
        trade: trade,
        assigned_to: '',
        target_fix_date: r.target_fix_date || '',
        resolved_date: '',
        input_source: 'pwa-walk',
        photo_url: photoUrl,
        initiated_by: Config.name,
        responsible_party: '',
        follow_up_by: '',
        remarks: '',
        cost: '',
        quality: '',
      };

      await API.submitDefect(defect);
      submitted++;
    } catch (err) {
      console.error(`Failed to submit walk item ${i + 1}:`, err);
    }
  }

  hideLoading();
  showToast(`${submitted} defects submitted!`, 'success');
  walkItems = [];
  walkResults = [];
  navigate('home');
});

// ─── History ─────────────────────────────────────────────────────────
async function refreshHistory() {
  try {
    const result = await API.readDefects();
    if (result.success && result.rows) {
      allDefects = result.rows;
    }
  } catch { /* use cached */ }
  applyFilters();
}

function applyFilters() {
  const status = $('#filter-status').value.toLowerCase();
  const search = $('#filter-search').value.toLowerCase();
  let filtered = allDefects;
  if (status) filtered = filtered.filter((d) => (d.status || '').toLowerCase() === status);
  if (search) filtered = filtered.filter((d) =>
    Object.values(d).some((v) => String(v).toLowerCase().includes(search))
  );
  renderDefectList('#history-list', filtered.reverse());
}

$('#filter-status').addEventListener('change', applyFilters);
$('#filter-search').addEventListener('input', applyFilters);

// ─── Settings ────────────────────────────────────────────────────────
function initSettings() {
  $('#settings-name').value = Config.name;
  $('#settings-project').value = Config.project;
  $('#settings-api').value = Config.apiUrl;
  $('#settings-sheet').value = localStorage.getItem('ss_sheet') || '';
  $('#settings-gemini').value = Config.geminiKey;
}

$('#form-settings').addEventListener('submit', async (e) => {
  e.preventDefault();
  Config.name = $('#settings-name').value.trim();
  Config.project = $('#settings-project').value.trim();
  Config.apiUrl = $('#settings-api').value.trim();
  Config.geminiKey = $('#settings-gemini').value.trim();

  const sheetUrl = $('#settings-sheet').value.trim();
  localStorage.setItem('ss_sheet', sheetUrl);

  // Send updated config to Apps Script
  if (sheetUrl || Config.geminiKey) {
    showLoading('Updating configuration...');
    try {
      await API.post('configure', {
        sheetUrl: sheetUrl,
        geminiKey: Config.geminiKey,
      });
      hideLoading();
    } catch (err) {
      hideLoading();
      console.warn('Configure call failed:', err);
    }
  }

  showToast('Settings saved!', 'success');
  navigate('home');
});

$('#btn-settings').addEventListener('click', () => navigate('settings'));

// ─── Local Text Extraction (offline fallback, mirrors app.py) ────────
function extractFromText(text) {
  const lower = text.toLowerCase();
  let severity = 'Medium';
  for (const s of ['critical', 'high', 'medium', 'low']) {
    if (lower.includes(s)) { severity = s.charAt(0).toUpperCase() + s.slice(1); break; }
  }

  const categoryMap = {
    plumbing:'Plumbing',pipe:'Plumbing',leak:'Plumbing',tap:'Plumbing',
    electrical:'Electrical',wiring:'Electrical',socket:'Electrical',switch:'Electrical',
    painting:'Painting',paint:'Painting',tiling:'Tiling',tile:'Tiling',
    carpentry:'Cabinet',door:'Door',window:'Window',cabinet:'Cabinet',wardrobe:'Wardrobe',
    ceiling:'Ceiling',aircon:'Aircon','air con':'Aircon',
    floor:'Floor',flooring:'Floor',waterproofing:'Waterproofing',seepage:'Waterproofing',
    structural:'Column',crack:'Wall',wall:'Wall',
  };
  let category = 'General';
  for (const [kw, cat] of Object.entries(categoryMap)) {
    if (lower.includes(kw)) { category = cat; break; }
  }

  const locMatch = lower.match(/(?:in the|in|at the|at)\s+(kitchen|bathroom|bedroom|master bedroom|living room|balcony|toilet|corridor|staircase|lobby)/);
  const location = locMatch ? locMatch[1].replace(/\b\w/g, (c) => c.toUpperCase()) : '';

  const dateMatch = text.match(/(\d{4}-\d{2}-\d{2})/);

  return {
    category,
    severity,
    location,
    description: text.trim(),
    trade: AUTO_TRADE[category] || 'TBD',
    defect_type: '',
    target_fix_date: dateMatch ? dateMatch[1] : '',
  };
}

// ─── Navigation Wiring ───────────────────────────────────────────────
// Bottom nav
$$('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => navigate(btn.dataset.view));
});

// Back buttons
$$('.btn-back').forEach((btn) => {
  btn.addEventListener('click', () => navigate(btn.dataset.back));
});

// Home action buttons
$('#btn-report').addEventListener('click', () => navigate('report'));
$('#btn-walk').addEventListener('click', () => navigate('walk'));
$('#btn-view-all').addEventListener('click', () => navigate('history'));

// ─── Defect Detail Modal ─────────────────────────────────────────────
function openDefectModal(defectId) {
  const d = allDefects.find((r) => r.defect_id === defectId);
  if (!d) return;

  $('#modal-defect-id').textContent = d.defect_id || 'Unknown';
  $('#modal-status').textContent = d.status || 'Outstanding';
  $('#modal-project').textContent = d.project || '';
  $('#modal-unit').textContent = d.unit || '';
  $('#modal-location').textContent = d.location || '';
  $('#modal-category').textContent = d.category || '';
  $('#modal-severity').textContent = d.severity || '';
  $('#modal-description').textContent = d.description || '';
  $('#modal-trade').textContent = d.trade || '';
  $('#modal-timestamp').textContent = d.timestamp_utc || '';

  // Photo
  if (d.photo_url) {
    $('#modal-photo-img').src = d.photo_url;
    $('#modal-photo').hidden = false;
  } else {
    $('#modal-photo').hidden = true;
  }

  // Resolve button — show only for Outstanding defects
  const isResolved = (d.status || '').toLowerCase() === 'completed';
  $('#btn-resolve').hidden = isResolved;
  $('#modal-resolved-info').hidden = !isResolved;
  if (isResolved) {
    $('#modal-resolved-info').textContent = 'Completed on ' + (d.resolved_date || 'unknown date');
  }

  $('#btn-resolve').onclick = async () => {
    showLoading('Updating...');
    try {
      await API.resolveDefect(defectId);
      hideLoading();
      showToast(defectId + ' completed!', 'success');
      $('#defect-modal').hidden = true;
      refreshHome();
      if (currentView === 'history') refreshHistory();
    } catch (err) {
      hideLoading();
      showToast('Failed to resolve: ' + err.message, 'error');
    }
  };

  $('#defect-modal').hidden = false;
}

$('#btn-modal-close').addEventListener('click', () => { $('#defect-modal').hidden = true; });
$('.modal-backdrop').addEventListener('click', () => { $('#defect-modal').hidden = true; });

// ─── Utils ───────────────────────────────────────────────────────────
function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

// ─── Service Worker ──────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW:', err));
}

// ─── Boot ────────────────────────────────────────────────────────────
function boot() {
  initSetup();
  initSpeech();

  if (Config.ready) {
    navigate('home');
  } else {
    navigate('setup');
  }
}

boot();
