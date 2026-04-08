#!/usr/bin/env node

/**
 * Auto-translate missing/untranslated keys in lang/*.json from en.json
 *
 * Usage:
 *   node tools/translate.js          # translate all languages
 *   node tools/translate.js hi       # translate only Hindi
 *   node tools/translate.js hi ta    # translate Hindi and Tamil
 */

const fs = require('fs');
const path = require('path');

const LANG_DIR = path.join(__dirname, '..', 'lang');
const EN_FILE = path.join(LANG_DIR, 'en.json');
const DELAY_MS = 200;

// All target languages (code -> Google Translate language code)
const LANG_MAP = {
  'zh':    'zh-CN',
  'zh-TW': 'zh-TW',
  'ms':    'ms',
  'id':    'id',
  'hi':    'hi',
  'ta':    'ta',
  'th':    'th',
  'vi':    'vi',
  'bn':    'bn',
  'ja':    'ja',
  'ko':    'ko',
  'de':    'de',
  'fr':    'fr',
  'es':    'es',
  'pt':    'pt',
  'it':    'it',
  'tr':    'tr',
  'sv':    'sv',
  'no':    'no',
  'da':    'da',
  'fi':    'fi',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Flatten a nested object into dot-separated key paths.
 * e.g. { nav: { dashboard: "Dashboard" } } -> { "nav.dashboard": "Dashboard" }
 */
function flatten(obj, prefix = '') {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(result, flatten(value, fullKey));
    } else {
      result[fullKey] = value;
    }
  }
  return result;
}

/**
 * Unflatten dot-separated keys back into a nested object,
 * following the key order from a template object.
 */
function unflatten(flat, template) {
  const result = {};
  const templateFlat = flatten(template);

  // Use template key order
  for (const dotKey of Object.keys(templateFlat)) {
    if (!(dotKey in flat)) continue;
    const parts = dotKey.split('.');
    let cur = result;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!(parts[i] in cur)) cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = flat[dotKey];
  }
  return result;
}

async function translateText(text, targetLang) {
  // Dynamic import for ESM module
  const { translate } = await import('google-translate-api-x');
  const res = await translate(text, { to: targetLang });
  return res.text;
}

async function processLanguage(langCode) {
  const googleLang = LANG_MAP[langCode];
  if (!googleLang) {
    console.log(`  [SKIP] Unknown language code: ${langCode}`);
    return;
  }

  const targetFile = path.join(LANG_DIR, `${langCode}.json`);
  const enData = JSON.parse(fs.readFileSync(EN_FILE, 'utf8'));
  const enFlat = flatten(enData);

  // Load existing translations if file exists
  let existingFlat = {};
  if (fs.existsSync(targetFile)) {
    try {
      const existing = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
      existingFlat = flatten(existing);
    } catch (e) {
      console.log(`  [WARN] Could not parse ${langCode}.json, starting fresh`);
    }
  }

  // Find keys that need translation:
  // 1) Missing from target
  // 2) Value identical to English (likely untranslated)
  const toTranslate = [];
  for (const [key, enValue] of Object.entries(enFlat)) {
    if (typeof enValue !== 'string') continue;
    const existing = existingFlat[key];
    if (existing === undefined || existing === enValue) {
      toTranslate.push(key);
    }
  }

  if (toTranslate.length === 0) {
    console.log(`  [${langCode}] All ${Object.keys(enFlat).length} keys already translated.`);
    return;
  }

  console.log(`  [${langCode}] ${toTranslate.length} keys to translate (out of ${Object.keys(enFlat).length} total)`);

  // Start with all existing translations, fill in English defaults
  const merged = { ...enFlat };
  for (const [key, val] of Object.entries(existingFlat)) {
    merged[key] = val;
  }

  let translated = 0;
  let failed = 0;

  for (const key of toTranslate) {
    const enValue = enFlat[key];
    try {
      const result = await translateText(enValue, googleLang);
      merged[key] = result;
      translated++;
      if (translated % 20 === 0) {
        console.log(`    ...${translated}/${toTranslate.length} done`);
      }
    } catch (err) {
      // Keep English text as fallback
      merged[key] = enValue;
      failed++;
      if (failed <= 3) {
        console.log(`    [ERR] "${key}": ${err.message}`);
      } else if (failed === 4) {
        console.log(`    [ERR] Suppressing further error messages...`);
      }
    }
    await sleep(DELAY_MS);
  }

  // Rebuild nested structure matching en.json key order
  const output = unflatten(merged, enData);
  fs.writeFileSync(targetFile, JSON.stringify(output, null, 2) + '\n', 'utf8');

  console.log(`  [${langCode}] Done: ${translated} translated, ${failed} failed (kept English). Saved to ${langCode}.json`);
}

async function main() {
  console.log('=== SiteShrimp Translation Tool ===\n');

  // Check en.json exists
  if (!fs.existsSync(EN_FILE)) {
    console.error('ERROR: en.json not found at', EN_FILE);
    process.exit(1);
  }

  // Determine which languages to process
  const args = process.argv.slice(2);
  let languages;

  if (args.length > 0) {
    languages = args;
    // Validate
    for (const lang of languages) {
      if (!LANG_MAP[lang]) {
        console.error(`ERROR: Unknown language "${lang}". Available: ${Object.keys(LANG_MAP).join(', ')}`);
        process.exit(1);
      }
    }
  } else {
    languages = Object.keys(LANG_MAP);
  }

  console.log(`Languages to process: ${languages.join(', ')}\n`);

  for (const lang of languages) {
    console.log(`Processing ${lang}...`);
    await processLanguage(lang);
    console.log();
  }

  console.log('=== Translation complete ===');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
