// ── i18n — Lightweight translation helper ────────────────────────
// Zero-dependency, CDN-friendly. Falls back to English for missing keys.
// Usage: t("nav.dashboard") → "Dashboard"

const LANGUAGES = [
  { code: "en",    name: "English",             flag: "\u{1F1EC}\u{1F1E7}" },
  { code: "zh",    name: "\u4E2D\u6587 (\u7B80\u4F53)",           flag: "\u{1F1E8}\u{1F1F3}" },
  { code: "zh-TW", name: "\u4E2D\u6587 (\u7E41\u9AD4)",           flag: "\u{1F1F9}\u{1F1FC}" },
  { code: "ms",    name: "Bahasa Melayu",        flag: "\u{1F1F2}\u{1F1FE}" },
  { code: "id",    name: "Bahasa Indonesia",     flag: "\u{1F1EE}\u{1F1E9}" },
  { code: "hi",    name: "\u0939\u093F\u0928\u094D\u0926\u0940",                 flag: "\u{1F1EE}\u{1F1F3}" },
  { code: "ta",    name: "\u0BA4\u0BAE\u0BBF\u0BB4\u0BCD",                  flag: "\u{1F1EE}\u{1F1F3}" },
  { code: "th",    name: "\u0E44\u0E17\u0E22",                   flag: "\u{1F1F9}\u{1F1ED}" },
  { code: "vi",    name: "Ti\u1EBFng Vi\u1EC7t",           flag: "\u{1F1FB}\u{1F1F3}" },
  { code: "bn",    name: "\u09AC\u09BE\u0982\u09B2\u09BE",                  flag: "\u{1F1E7}\u{1F1E9}" },
  { code: "ja",    name: "\u65E5\u672C\u8A9E",                 flag: "\u{1F1EF}\u{1F1F5}" },
  { code: "ko",    name: "\uD55C\uAD6D\uC5B4",                  flag: "\u{1F1F0}\u{1F1F7}" },
  { code: "de",    name: "Deutsch",              flag: "\u{1F1E9}\u{1F1EA}" },
  { code: "fr",    name: "Fran\u00E7ais",             flag: "\u{1F1EB}\u{1F1F7}" },
  { code: "es",    name: "Espa\u00F1ol",              flag: "\u{1F1EA}\u{1F1F8}" },
  { code: "pt",    name: "Portugu\u00EAs",            flag: "\u{1F1F5}\u{1F1F9}" },
  { code: "it",    name: "Italiano",             flag: "\u{1F1EE}\u{1F1F9}" },
  { code: "tr",    name: "T\u00FCrk\u00E7e",               flag: "\u{1F1F9}\u{1F1F7}" },
  { code: "sv",    name: "Svenska",              flag: "\u{1F1F8}\u{1F1EA}" },
  { code: "no",    name: "Norsk",                flag: "\u{1F1F3}\u{1F1F4}" },
  { code: "da",    name: "Dansk",                flag: "\u{1F1E9}\u{1F1F0}" },
  { code: "fi",    name: "Suomi",                flag: "\u{1F1EB}\u{1F1EE}" },
];

let _lang = {};        // Current language pack
let _fallback = {};    // English fallback
let _currentCode = "en";
let _i18nReady = false;
const _listeners = []; // Re-render callbacks

// Resolve nested key like "nav.dashboard" from object
function _resolve(obj, key) {
  return key.split(".").reduce(function(o, k) { return (o && o[k] !== undefined) ? o[k] : undefined; }, obj);
}

// Main translation function — global, works before React loads
function t(key, replacements) {
  var str = _resolve(_lang, key);
  if (str === undefined) str = _resolve(_fallback, key);
  if (str === undefined) return key; // Show key as last resort
  // Simple {{var}} interpolation
  if (replacements && typeof str === "string") {
    Object.keys(replacements).forEach(function(k) {
      str = str.replace(new RegExp("\\{\\{" + k + "\\}\\}", "g"), replacements[k]);
    });
  }
  return str;
}

// Load a language pack from /lang/{code}.json
function loadLanguage(code) {
  return fetch("lang/" + code + ".json?v=" + Date.now())
    .then(function(resp) {
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      return resp.json();
    })
    .then(function(data) {
      _lang = data;
      _currentCode = code;
      localStorage.setItem("lang", code);
      document.documentElement.lang = code;
      _listeners.forEach(function(fn) { fn(code); });
    })
    .catch(function(e) {
      console.warn("Failed to load language:", code, e);
      if (code !== "en") {
        _lang = _fallback;
        _currentCode = "en";
        localStorage.setItem("lang", "en");
      }
    });
}

// Load English as fallback (called once on startup)
function initI18n() {
  return fetch("lang/en.json?v=" + Date.now())
    .then(function(resp) { return resp.json(); })
    .then(function(data) {
      _fallback = data;
      var saved = localStorage.getItem("lang") || "en";
      if (saved === "en") {
        _lang = _fallback;
        _currentCode = "en";
        _i18nReady = true;
        _listeners.forEach(function(fn) { fn("en"); });
        return;
      }
      return loadLanguage(saved).then(function() { _i18nReady = true; });
    })
    .catch(function(e) {
      console.warn("Failed to load English fallback:", e);
      _fallback = {};
      _i18nReady = true;
    });
}

function getCurrentLang() { return _currentCode; }

function onLangChange(fn) {
  _listeners.push(fn);
  return function() { var i = _listeners.indexOf(fn); if (i >= 0) _listeners.splice(i, 1); };
}
