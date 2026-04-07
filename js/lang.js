// ── i18n — Lightweight translation helper ────────────────────────
// Zero-dependency, CDN-friendly. Falls back to English for missing keys.
// Usage: t("nav.dashboard") → "Dashboard"

const LANGUAGES = [
  { code: "en",    name: "English",             flag: "🇬🇧" },
  { code: "zh",    name: "中文 (简体)",           flag: "🇨🇳" },
  { code: "zh-TW", name: "中文 (繁體)",           flag: "🇹🇼" },
  { code: "ms",    name: "Bahasa Melayu",        flag: "🇲🇾" },
  { code: "id",    name: "Bahasa Indonesia",     flag: "🇮🇩" },
  { code: "hi",    name: "हिन्दी",                 flag: "🇮🇳" },
  { code: "ta",    name: "தமிழ்",                  flag: "🇮🇳" },
  { code: "th",    name: "ไทย",                   flag: "🇹🇭" },
  { code: "vi",    name: "Tiếng Việt",           flag: "🇻🇳" },
  { code: "bn",    name: "বাংলা",                  flag: "🇧🇩" },
  { code: "ja",    name: "日本語",                 flag: "🇯🇵" },
  { code: "ko",    name: "한국어",                  flag: "🇰🇷" },
  { code: "de",    name: "Deutsch",              flag: "🇩🇪" },
  { code: "fr",    name: "Français",             flag: "🇫🇷" },
  { code: "es",    name: "Español",              flag: "🇪🇸" },
  { code: "pt",    name: "Português",            flag: "🇵🇹" },
  { code: "it",    name: "Italiano",             flag: "🇮🇹" },
  { code: "tr",    name: "Türkçe",               flag: "🇹🇷" },
  { code: "sv",    name: "Svenska",              flag: "🇸🇪" },
  { code: "no",    name: "Norsk",                flag: "🇳🇴" },
  { code: "da",    name: "Dansk",                flag: "🇩🇰" },
  { code: "fi",    name: "Suomi",                flag: "🇫🇮" },
];

let _lang = {};        // Current language pack
let _fallback = {};    // English fallback
let _currentCode = "en";
const _listeners = []; // Re-render callbacks

// Resolve nested key like "nav.dashboard" from object
function _resolve(obj, key) {
  return key.split(".").reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);
}

// Main translation function
function t(key, replacements) {
  let str = _resolve(_lang, key);
  if (str === undefined) str = _resolve(_fallback, key);
  if (str === undefined) return key; // Show key as last resort
  // Simple {{var}} interpolation
  if (replacements && typeof str === "string") {
    Object.keys(replacements).forEach(k => {
      str = str.replace(new RegExp("\\{\\{" + k + "\\}\\}", "g"), replacements[k]);
    });
  }
  return str;
}

// Load a language pack from /lang/{code}.json
async function loadLanguage(code) {
  try {
    const resp = await fetch(`lang/${code}.json?v=${Date.now()}`);
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    _lang = data;
    _currentCode = code;
    localStorage.setItem("lang", code);
    document.documentElement.lang = code;
    // Notify React to re-render
    _listeners.forEach(fn => fn(code));
  } catch (e) {
    console.warn("Failed to load language:", code, e);
    // Fall back to English
    if (code !== "en") {
      _lang = _fallback;
      _currentCode = "en";
      localStorage.setItem("lang", "en");
    }
  }
}

// Load English as fallback (called once on startup)
async function initI18n() {
  try {
    const resp = await fetch("lang/en.json?v=" + Date.now());
    _fallback = await resp.json();
  } catch (e) {
    console.warn("Failed to load English fallback:", e);
    _fallback = {};
  }
  // Load user's preferred language
  const saved = localStorage.getItem("lang") || "en";
  if (saved === "en") {
    _lang = _fallback;
    _currentCode = "en";
  } else {
    await loadLanguage(saved);
  }
}

function getCurrentLang() { return _currentCode; }

function onLangChange(fn) {
  _listeners.push(fn);
  return () => { const i = _listeners.indexOf(fn); if (i >= 0) _listeners.splice(i, 1); };
}

// React hook for language changes
function useLang() {
  const [, setTick] = (typeof React !== "undefined" && React.useState) ? React.useState(0) : [0, () => {}];
  if (typeof React !== "undefined" && React.useEffect) {
    React.useEffect(() => {
      return onLangChange(() => setTick(t => t + 1));
    }, []);
  }
  return { t, lang: _currentCode, setLang: loadLanguage, languages: LANGUAGES };
}
