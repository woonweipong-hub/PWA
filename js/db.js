// SiteSnag — PocketBase Data Layer
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
    const resp = await fetch(url, {
      ...opts,
      headers: headers(opts.headers || {}),
    });
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!resp.ok) {
      const msg = data?.message || data?.data?.message || `API error ${resp.status}`;
      throw new Error(msg);
    }
    return data;
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
      const result = await apiJson('/api/collections/users/auth-with-password', 'POST', {
        identity: email, password
      });
      _token = result.token;
      _user = result.record;
      _saveAuth();
      _notifyAuth();
      return { user: _user };
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
      async list(filter = '', sort = '-created', perPage = 500) {
        const params = new URLSearchParams({ perPage, sort });
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

        // Initial load
        this.list(filter).then(items => callback(items)).catch(() => {});

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
      // Handle photo: convert base64 to file upload
      let photoBlob = null;
      let photoName = 'photo.jpg';
      const cleanData = { ...data, companyId };

      if (data.photo && data.photo.startsWith('data:')) {
        const parts = data.photo.split(',');
        const mime = parts[0].match(/:(.*?);/)?.[1] || 'image/jpeg';
        const b64 = parts[1];
        const bytes = atob(b64);
        const arr = new Uint8Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
        photoBlob = new Blob([arr], { type: mime });
        delete cleanData.photo;
      }

      if (photoBlob) {
        return defects.createWithFile(cleanData, 'photo', photoBlob, photoName);
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
    ...helpers,
    get baseUrl() { return _baseUrl; },
  };
})();
