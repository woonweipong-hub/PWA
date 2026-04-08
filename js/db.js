// SiteShrimp — PocketBase Data Layer
// Drop-in replacement for Firebase (Firestore + Auth)
// All UI code calls DB.* methods instead of firebase.*

const DB = (() => {
  let _baseUrl = '';
  let _token = '';
  let _user = null;
  let _authCallbacks = [];
  let _sseConnections = {};
  const AUTH_KEY = 'pb_auth';

  // ── Internal helpers ─────────────────────────────────────────────
  function headers(extra = {}) {
    const h = { ...extra };
    if (_token) h['Authorization'] = 'Bearer ' + _token;
    return h;
  }

  async function api(path, opts = {}) {
    const url = _baseUrl + path;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const resp = await fetch(url, {
        ...opts,
        headers: headers(opts.headers || {}),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const text = await resp.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
      if (!resp.ok) {
        // PocketBase validation errors live at data.data.fieldName.message
        let msg = data?.message;
        if (data?.data && typeof data.data === 'object') {
          const fieldErrors = Object.values(data.data)
            .map(v => (v && typeof v === 'object' ? v.message : null))
            .filter(Boolean);
          if (fieldErrors.length) msg = fieldErrors.join(' · ');
        }
        throw new Error(msg || `API error ${resp.status}`);
      }
      return data;
    } catch (err) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') {
        throw new Error('Server not responding (timeout). Make sure your PocketBase VM is running, then reload.');
      }
      if (err.name === 'TypeError' || err.message === 'Failed to fetch') {
        throw new Error('Cannot reach server. Start your PocketBase VM, check the URL, then reload.');
      }
      throw err;
    }
  }

  async function apiJson(path, method, body) {
    return api(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  // ── Init ─────────────────────────────────────────────────────────
  async function init(baseUrl) {
    _baseUrl = baseUrl.replace(/\/+$/, '');
    // Try to restore session
    try {
      const saved = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null');
      if (saved?.token && saved?.user) {
        _token = saved.token;
        _user = saved.user;
        // Validate token
        try {
          const result = await api('/api/collections/users/auth-refresh', { method: 'POST' });
          _token = result.token;
          _user = result.record;
          _saveAuth();
        } catch {
          // Token expired
          _token = '';
          _user = null;
          localStorage.removeItem(AUTH_KEY);
        }
      }
    } catch {}
    // Notify auth callbacks
    _notifyAuth();
  }

  function _saveAuth() {
    if (_token && _user) {
      localStorage.setItem(AUTH_KEY, JSON.stringify({ token: _token, user: _user }));
    }
  }

  function _notifyAuth() {
    _authCallbacks.forEach(cb => {
      try { cb(_user); } catch {}
    });
  }

  // ── Auth ─────────────────────────────────────────────────────────
  const auth = {
    get currentUser() { return _user; },

    async login(email, password) {
      try {
        const result = await apiJson('/api/collections/users/auth-with-password', 'POST', {
          identity: email, password
        });
        _token = result.token;
        _user = result.record;
        _saveAuth();
        _notifyAuth();
        return { user: _user };
      } catch (err) {
        if (err.message && err.message.includes('Failed to authenticate')) {
          throw new Error(
            'Login failed — wrong email or password.\n' +
            'If you forgot your password, tap "Forgot password?" below.\n' +
            'If you\'re new, switch to SIGN UP.'
          );
        }
        throw err;
      }
    },

    async register(email, password, name) {
      // Create user
      await apiJson('/api/collections/users/records', 'POST', {
        email, password, passwordConfirm: password, name
      });
      // Auto login after register
      return auth.login(email, password);
    },

    async resetPassword(email) {
      await apiJson('/api/collections/users/request-password-reset', 'POST', { email });
    },

    signOut() {
      _token = '';
      _user = null;
      localStorage.removeItem(AUTH_KEY);
      // Close all SSE connections
      Object.values(_sseConnections).forEach(es => { try { es.close(); } catch {} });
      _sseConnections = {};
      _notifyAuth();
    },

    onAuthStateChanged(callback) {
      _authCallbacks.push(callback);
      // Call immediately with current state
      setTimeout(() => callback(_user), 0);
      // Return unsubscribe
      return () => {
        _authCallbacks = _authCallbacks.filter(cb => cb !== callback);
      };
    },
  };

  // ── Generic CRUD ─────────────────────────────────────────────────
  function crud(collection) {
    return {
      async list(filter = '', sort = '', perPage = 500) {
        const params = new URLSearchParams({ perPage });
        if (sort) params.set('sort', sort);
        if (filter) params.set('filter', filter);
        const result = await api(`/api/collections/${collection}/records?${params}`);
        return result.items || [];
      },

      async get(id) {
        return api(`/api/collections/${collection}/records/${id}`);
      },

      async getFirst(filter) {
        const params = new URLSearchParams({ perPage: 1, filter });
        const result = await api(`/api/collections/${collection}/records?${params}`);
        return result.items?.[0] || null;
      },

      async create(data) {
        return apiJson(`/api/collections/${collection}/records`, 'POST', data);
      },

      async createWithFile(data, fileField, fileBlob, fileName) {
        const fd = new FormData();
        for (const [k, v] of Object.entries(data)) {
          if (v !== null && v !== undefined) {
            fd.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
          }
        }
        if (fileBlob) {
          fd.append(fileField, fileBlob, fileName || 'photo.jpg');
        }
        return api(`/api/collections/${collection}/records`, { method: 'POST', body: fd });
      },

      async update(id, data) {
        return apiJson(`/api/collections/${collection}/records/${id}`, 'PATCH', data);
      },

      async delete(id) {
        return api(`/api/collections/${collection}/records/${id}`, { method: 'DELETE' });
      },

      subscribe(filter, callback) {
        // PocketBase SSE real-time
        const key = `${collection}_${filter}`;
        if (_sseConnections[key]) {
          try { _sseConnections[key].close(); } catch {}
        }

        // Initial load — must call callback even on error so UI doesn't hang
        this.list(filter).then(items => callback(items)).catch(() => callback([]));

        // SSE subscription
        try {
          const es = new EventSource(`${_baseUrl}/api/realtime`);
          _sseConnections[key] = es;

          es.addEventListener('PB_CONNECT', (e) => {
            const data = JSON.parse(e.data);
            const clientId = data.clientId;
            // Subscribe to collection
            apiJson('/api/realtime', 'POST', {
              clientId,
              subscriptions: [collection],
            }).catch(() => {});
          });

          es.addEventListener(collection, () => {
            // On any change, re-fetch the full list
            this.list(filter).then(items => callback(items)).catch(() => {});
          });

          es.onerror = () => {
            // Reconnect on error
            setTimeout(() => {
              if (_sseConnections[key] === es) {
                this.list(filter).then(items => callback(items)).catch(() => {});
              }
            }, 3000);
          };
        } catch {
          // SSE not supported — polling fallback
          const interval = setInterval(() => {
            this.list(filter).then(items => callback(items)).catch(() => {});
          }, 10000);
          _sseConnections[key] = { close: () => clearInterval(interval) };
        }

        // Return unsubscribe
        return () => {
          if (_sseConnections[key]) {
            try { _sseConnections[key].close(); } catch {}
            delete _sseConnections[key];
          }
        };
      },
    };
  }

  // ── Collection instances ─────────────────────────────────────────
  const companies = crud('companies');
  const members = crud('members');
  const projects = crud('projects');
  const defects = crud('defects');
  const invites = crud('invites');
  const settings = crud('settings');
  const activity = crud('activity');
  const locationPresets = crud('location_presets');
  const componentPresets = crud('component_presets');
  const drawings = crud('drawings');
  const pins = crud('pins');

  // ── High-level helpers ───────────────────────────────────────────
  const helpers = {
    async findUserCompany(userId) {
      const mems = await members.list(`userId = "${userId}"`);
      if (mems.length === 0) return null;
      const mem = mems[0];
      const comp = await companies.get(mem.companyId);
      return { companyId: comp.id, companyName: comp.name, member: mem };
    },

    async createCompany(name, userId, userEmail, userName, jobTitle) {
      const comp = await companies.create({
        name, adminId: userId, adminEmail: userEmail, createdAt: new Date().toISOString()
      });
      await members.create({
        companyId: comp.id, userId, name: userName, email: userEmail,
        role: 'Admin', jobTitle, joinedAt: new Date().toISOString()
      });
      const proj = await projects.create({
        companyId: comp.id, name: 'Default Project',
        createdBy: userId, createdAt: new Date().toISOString()
      });
      return { company: comp, project: proj };
    },

    async addDefect(companyId, data) {
      // Handle photos: convert base64 to file uploads (supports multiple)
      const cleanData = { ...data, companyId };
      const extraPhotos = cleanData.extraPhotos || [];
      delete cleanData.extraPhotos;
      delete cleanData.photos; // Remove the array form, we use photo + extraPhotos

      function b64toBlob(dataUrl) {
        const parts = dataUrl.split(',');
        const mime = parts[0].match(/:(.*?);/)?.[1] || 'image/jpeg';
        const b64 = parts[1];
        const bytes = atob(b64);
        const arr = new Uint8Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
        return new Blob([arr], { type: mime });
      }

      // Build FormData with all photos
      const hasMainPhoto = cleanData.photo && cleanData.photo.startsWith('data:');
      const hasExtra = extraPhotos.length > 0;

      if (hasMainPhoto || hasExtra) {
        const fd = new FormData();
        const photoField = cleanData.photo;
        delete cleanData.photo;
        for (const [k, v] of Object.entries(cleanData)) {
          if (v !== null && v !== undefined) {
            fd.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
          }
        }
        // Append all photos under the same 'photo' field (PocketBase supports multiple)
        if (hasMainPhoto) {
          fd.append('photo', b64toBlob(photoField), 'photo_1.jpg');
        }
        for (let i = 0; i < extraPhotos.length; i++) {
          if (extraPhotos[i] && extraPhotos[i].startsWith('data:')) {
            fd.append('photo', b64toBlob(extraPhotos[i]), `photo_${i + 2}.jpg`);
          }
        }
        return api(`/api/collections/defects/records`, { method: 'POST', body: fd });
      } else {
        delete cleanData.photo;
        return defects.create(cleanData);
      }
    },

    fileUrl(collectionName, recordId, filename) {
      if (!filename) return '';
      return `${_baseUrl}/api/files/${collectionName}/${recordId}/${filename}`;
    },

    serverTimestamp() {
      return new Date().toISOString();
    },
  };

  // ── Public API ───────────────────────────────────────────────────
  return {
    init,
    auth,
    companies,
    members,
    projects,
    defects,
    invites,
    settings,
    activity,
    locationPresets,
    componentPresets,
    drawings,
    pins,
    ...helpers,
    async sendEmail(recipients, subject, html) {
      return apiJson('/api/send-email', 'POST', { recipients, subject, html });
    },
    async configureSmtp(host, port, username, password, fromEmail, fromName) {
      return apiJson('/api/configure-smtp', 'POST', { host, port, username, password, fromEmail, fromName });
    },
    async testSmtp(to) {
      return apiJson('/api/test-smtp', 'POST', { to });
    },
    get baseUrl() { return _baseUrl; },
  };
})();

// ── Google Drive Storage Layer ────────────────────────────────────
// Allows users to store photos in their own Google Drive account.
// Uses OAuth2 with Google's client-side flow + Drive API v3.
const GDrive = (() => {
  const SCOPES = 'https://www.googleapis.com/auth/drive.file';
  const FOLDER_NAME = 'SiteShrimp Photos';
  let _accessToken = '';
  let _folderId = '';
  let _clientId = '';
  let _tokenExpiry = 0;

  function init(clientId) {
    _clientId = clientId;
    // Restore saved token if still valid
    try {
      const saved = JSON.parse(localStorage.getItem(GDRIVE_KEY) || 'null');
      if (saved?.token && saved?.expiry > Date.now()) {
        _accessToken = saved.token;
        _tokenExpiry = saved.expiry;
      }
    } catch {}
  }

  function isConnected() {
    return !!(_accessToken && _tokenExpiry > Date.now());
  }

  // OAuth2 implicit flow — opens popup for Google sign-in
  function authorize() {
    return new Promise((resolve, reject) => {
      if (!_clientId) return reject(new Error('Google Client ID not configured'));
      const redirectUri = window.location.origin + window.location.pathname;
      const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id: _clientId,
        redirect_uri: redirectUri,
        response_type: 'token',
        scope: SCOPES,
        include_granted_scopes: 'true',
        prompt: 'consent',
      });
      const popup = window.open(url, 'gdrive_auth', 'width=500,height=600,left=200,top=100');
      if (!popup) return reject(new Error('Popup blocked — please allow popups for this site'));

      const timer = setInterval(() => {
        try {
          if (popup.closed) { clearInterval(timer); reject(new Error('Auth cancelled')); return; }
          const loc = popup.location.href;
          if (loc && loc.startsWith(redirectUri)) {
            clearInterval(timer);
            const hash = new URL(loc).hash.substring(1);
            const params = new URLSearchParams(hash);
            const token = params.get('access_token');
            const expiresIn = parseInt(params.get('expires_in') || '3600', 10);
            popup.close();
            if (token) {
              _accessToken = token;
              _tokenExpiry = Date.now() + expiresIn * 1000;
              localStorage.setItem(GDRIVE_KEY, JSON.stringify({ token, expiry: _tokenExpiry }));
              resolve(token);
            } else {
              reject(new Error('No access token received'));
            }
          }
        } catch { /* cross-origin — keep polling */ }
      }, 300);

      // Timeout after 2 minutes
      setTimeout(() => { clearInterval(timer); try { popup.close(); } catch {} reject(new Error('Auth timed out')); }, 120000);
    });
  }

  function disconnect() {
    _accessToken = '';
    _tokenExpiry = 0;
    _folderId = '';
    localStorage.removeItem(GDRIVE_KEY);
  }

  async function _apiGet(path) {
    const resp = await fetch('https://www.googleapis.com/drive/v3' + path, {
      headers: { Authorization: 'Bearer ' + _accessToken },
    });
    if (!resp.ok) throw new Error('Drive API error: ' + resp.status);
    return resp.json();
  }

  // Find or create the SiteShrimp Photos folder
  async function _ensureFolder() {
    if (_folderId) return _folderId;
    // Search for existing folder
    const q = encodeURIComponent(`name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    const result = await _apiGet(`/files?q=${q}&fields=files(id,name)&spaces=drive`);
    if (result.files && result.files.length > 0) {
      _folderId = result.files[0].id;
      return _folderId;
    }
    // Create folder
    const resp = await fetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + _accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
    });
    if (!resp.ok) throw new Error('Failed to create Drive folder');
    const folder = await resp.json();
    _folderId = folder.id;
    return _folderId;
  }

  // Upload a photo (base64 data URL) to Google Drive, returns {fileId, webViewLink}
  async function uploadPhoto(dataUrl, fileName) {
    if (!isConnected()) throw new Error('Not connected to Google Drive');
    const folderId = await _ensureFolder();

    // Convert data URL to blob
    const parts = dataUrl.split(',');
    const mime = parts[0].match(/:(.*?);/)?.[1] || 'image/jpeg';
    const b64 = parts[1];
    const bytes = atob(b64);
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    const blob = new Blob([arr], { type: mime });

    // Multipart upload (metadata + file content)
    const metadata = { name: fileName, parents: [folderId] };
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', blob);

    const resp = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink,webContentLink', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + _accessToken },
      body: form,
    });
    if (!resp.ok) throw new Error('Upload to Drive failed: ' + resp.status);
    const file = await resp.json();

    // Make file viewable by anyone with link (so photos display in the app)
    await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}/permissions`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + _accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'reader', type: 'anyone' }),
    }).catch(() => {}); // non-critical

    return {
      fileId: file.id,
      url: `https://drive.google.com/uc?export=view&id=${file.id}`,
    };
  }

  // Get a direct-view URL for a file
  function fileUrl(fileId) {
    return `https://drive.google.com/uc?export=view&id=${fileId}`;
  }

  // Test connection — list files to verify token works
  async function testConnection() {
    if (!isConnected()) return false;
    try {
      await _apiGet('/about?fields=user');
      return true;
    } catch { return false; }
  }

  // Get user info
  async function getUserInfo() {
    if (!isConnected()) return null;
    try {
      const result = await _apiGet('/about?fields=user');
      return result.user;
    } catch { return null; }
  }

  return { init, authorize, disconnect, isConnected, uploadPhoto, fileUrl, testConnection, getUserInfo };
})();

// ── Offline Queue (IndexedDB) ─────────────────────────────────────
// Queues defect entries when offline, auto-syncs when back online.
const OfflineQueue = (() => {
  const DB_NAME = 'siteshrimp_offline';
  const STORE = 'queue';
  const DB_VERSION = 1;
  let _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  async function add(entry) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const req = store.add({ ...entry, queuedAt: new Date().toISOString() });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function getAll() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function remove(id) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async function count() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function clear() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  return { open, add, getAll, remove, count, clear };
})();
