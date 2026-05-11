// AI variant evaluation harness.
//
// Reads AI_PROMPT_VERSION / AI_SERVER_PROMPT / AI_OUTPUT_SCHEMA /
// AI_VARIANT_TABLE / buildAiInputs from deploy/pocketbase/pb_hooks/main.pb.js
// via Node's vm module so the harness never drifts from the live prompt.
// Runs every test case under tests/ai/cases/** through the configured AI
// provider, scores each field against expected.json, and writes a run log.
//
// Usage: see `node tools/eval-ai.js --help`.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const https = require('https');

const REPO = path.resolve(__dirname, '..');
const HOOK_FILE = path.join(REPO, 'deploy/pocketbase/pb_hooks/main.pb.js');
const CASES_DIR_DEFAULT = path.join(REPO, 'tests/ai/cases');
const RUNS_DIR = path.join(REPO, 'tests/ai/runs');

// ---------- args ----------

function parseArgs(argv) {
  const args = {
    provider: 'gemini',
    cases: CASES_DIR_DEFAULT,
    filter: '',
    maxCases: 0,
    dryRun: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { printHelp(); process.exit(0); }
    else if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--provider=')) args.provider = a.slice(11);
    else if (a.startsWith('--cases=')) args.cases = path.resolve(a.slice(8));
    else if (a.startsWith('--filter=')) args.filter = a.slice(9);
    else if (a.startsWith('--max=')) args.maxCases = Number(a.slice(6)) || 0;
    else { console.error('Unknown arg:', a); process.exit(1); }
  }
  return args;
}

function printHelp() {
  console.log([
    '',
    'Usage: node tools/eval-ai.js [options]',
    '',
    'Runs the AI variant prompts against labeled test cases under',
    'tests/ai/cases/** and reports per-field, per-variant accuracy.',
    '',
    'Options:',
    '  --provider=gemini    AI provider to call (default: gemini)',
    '  --cases=PATH         Directory containing labeled cases',
    '  --filter=STR         Only run cases whose path contains STR',
    '  --max=N              Stop after N cases',
    '  --dry-run            Validate cases against schema; no API calls',
    '  -h, --help           Show this help',
    '',
    'Environment:',
    '  GEMINI_API_KEY       Required for --provider=gemini',
    '',
    'Source of truth:',
    '  AI prompt + schema + buildAiInputs are loaded from',
    '  deploy/pocketbase/pb_hooks/main.pb.js via Node vm.',
    '  Never duplicate them.',
    '',
  ].join('\n'));
}

// ---------- load AI constants from hook file ----------

function loadAiInputs() {
  const src = fs.readFileSync(HOOK_FILE, 'utf8');
  const start = src.indexOf('var AI_PROMPT_VERSION');
  const end = src.indexOf('function analyzeWithGeminiServer');
  if (start < 0 || end < 0 || end < start) {
    throw new Error('Could not locate AI constants block in main.pb.js — markers moved?');
  }
  const slice = src.slice(start, end);
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(slice, ctx);
  if (typeof ctx.buildAiInputs !== 'function') {
    throw new Error('buildAiInputs not extracted — check the slice boundaries');
  }
  return {
    promptVersion: ctx.AI_PROMPT_VERSION,
    baseSchema: ctx.AI_OUTPUT_SCHEMA,
    variants: ctx.AI_VARIANT_TABLE,
    buildAiInputs: ctx.buildAiInputs,
  };
}

// ---------- case discovery + load ----------

function listCases(dir, filter) {
  const out = [];
  function walk(d, rel) {
    if (!fs.existsSync(d)) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      const relPath = path.posix.join(rel, entry.name);
      if (entry.isDirectory()) {
        const expectedFile = path.join(full, 'expected.json');
        if (fs.existsSync(expectedFile)) {
          if (!filter || relPath.includes(filter)) {
            out.push({ id: relPath, dir: full });
          }
        } else {
          walk(full, relPath);
        }
      }
    }
  }
  walk(dir, '');
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

function loadCase(caseDir) {
  const expectedPath = path.join(caseDir, 'expected.json');
  const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
  if (!expected._meta || !expected._meta.workCategory) {
    throw new Error('expected.json missing _meta.workCategory');
  }
  const photoPath = path.join(caseDir, 'photo.jpg');
  const photoExists = fs.existsSync(photoPath);
  let photoB64 = null;
  if (photoExists) photoB64 = fs.readFileSync(photoPath).toString('base64');
  return { expected, photoB64, photoExists };
}

// ---------- schema validation ----------

function validate(output, schema) {
  const errors = [];
  if (schema.required) {
    for (const k of schema.required) {
      if (!(k in output)) errors.push('missing required field: ' + k);
    }
  }
  for (const k of Object.keys(output)) {
    const prop = schema.properties[k];
    if (!prop) {
      if (schema.additionalProperties === false) errors.push('unexpected field: ' + k);
      continue;
    }
    const v = output[k];
    const types = Array.isArray(prop.type) ? prop.type : [prop.type];
    let valueType = v === null ? 'null'
      : Array.isArray(v) ? 'array'
      : typeof v === 'number' ? (Number.isInteger(v) && types.includes('integer') ? 'integer' : 'number')
      : typeof v;
    if (prop.type && !types.includes(valueType)) {
      errors.push(`${k}: expected ${types.join('|')}, got ${valueType}`);
      continue;
    }
    if (prop.enum && !prop.enum.includes(v)) {
      errors.push(`${k}: value ${JSON.stringify(v)} not in enum`);
    }
    if (prop.minimum !== undefined && typeof v === 'number' && v < prop.minimum) {
      errors.push(`${k}: ${v} < min ${prop.minimum}`);
    }
    if (prop.maximum !== undefined && typeof v === 'number' && v > prop.maximum) {
      errors.push(`${k}: ${v} > max ${prop.maximum}`);
    }
  }
  return errors;
}

// ---------- field scoring ----------

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    const tmp = prev; prev = curr; curr = tmp;
  }
  return prev[n];
}

function stringSim(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const A = String(a).toLowerCase().trim();
  const B = String(b).toLowerCase().trim();
  if (A === B) return 1;
  const dist = levenshtein(A, B);
  return 1 - dist / Math.max(A.length, B.length);
}

function isFloatProp(prop) {
  if (!prop) return true;
  const types = Array.isArray(prop.type) ? prop.type : [prop.type];
  return types.includes('number') && !types.includes('integer');
}

function scoreField(expected, actual, schemaProp) {
  if (expected === null && actual === null) return { score: 1, kind: 'null=null' };
  if (expected === null && actual !== null) return { score: 0, kind: 'expected-null' };
  if (expected !== null && actual === null) return { score: 0, kind: 'unexpected-null' };
  const isEnum = schemaProp && schemaProp.enum;
  if (isEnum) return { score: expected === actual ? 1 : 0, kind: 'enum' };
  if (typeof expected === 'boolean') return { score: expected === actual ? 1 : 0, kind: 'bool' };
  if (typeof expected === 'number') {
    if (!isFloatProp(schemaProp) || Number.isInteger(expected)) {
      return { score: expected === actual ? 1 : 0, kind: 'int' };
    }
    const diff = Math.abs(expected - actual);
    const tol = 0.15;
    if (diff <= tol) return { score: 1 - (diff / (tol * 2)), kind: 'number-tol' };
    return { score: Math.max(0, 1 - diff), kind: 'number-tol' };
  }
  if (typeof expected === 'string') {
    return { score: stringSim(expected, actual), kind: 'string-sim' };
  }
  return { score: 0, kind: 'unknown' };
}

function scoreCase(expected, actual, schema) {
  const fields = {};
  let total = 0, count = 0;
  for (const k of Object.keys(expected)) {
    if (k.startsWith('_')) continue;
    const exp = expected[k];
    const act = actual[k];
    const prop = schema.properties[k];
    const r = scoreField(exp, act, prop);
    fields[k] = { expected: exp, actual: act, score: r.score, kind: r.kind };
    total += r.score;
    count++;
  }
  return { fields, score: count ? total / count : 0, fieldCount: count };
}

// ---------- Gemini provider ----------

function toGeminiSchema(schema) {
  function convert(node) {
    if (!node || typeof node !== 'object') return node;
    const out = {};
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (k === 'type' && Array.isArray(v)) {
        const nonNull = v.filter(t => t !== 'null');
        out.type = String(nonNull[0]).toUpperCase();
        if (v.includes('null')) out.nullable = true;
      } else if (k === 'type' && typeof v === 'string') {
        out.type = v.toUpperCase();
      } else if (k === 'enum' && Array.isArray(v)) {
        out.enum = v.filter(x => x !== null).map(String);
      } else if (k === 'properties') {
        out.properties = {};
        for (const pk of Object.keys(v)) out.properties[pk] = convert(v[pk]);
      } else if (k === 'additionalProperties') {
        // Gemini responseSchema does not accept this; drop
      } else if (k === 'required') {
        out.required = v;
      } else {
        out[k] = v;
      }
    }
    return out;
  }
  return convert(schema);
}

function callGemini(b64Photo, prompt, schema, apiKey) {
  const body = JSON.stringify({
    contents: [{ parts: [
      { text: prompt },
      { inline_data: { mime_type: 'image/jpeg', data: b64Photo } },
    ]}],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: toGeminiSchema(schema),
      temperature: 0.1,
    },
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: '/v1beta/models/gemini-2.5-flash:generateContent?key=' + apiKey,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Gemini ${res.statusCode}: ${buf.slice(0, 500)}`));
        }
        try {
          const j = JSON.parse(buf);
          const text = j.candidates && j.candidates[0]
            && j.candidates[0].content && j.candidates[0].content.parts
            && j.candidates[0].content.parts[0] && j.candidates[0].content.parts[0].text;
          if (!text) return reject(new Error('Gemini returned no text'));
          const parsed = JSON.parse(String(text).replace(/^```json\s*|\s*```$/g, ''));
          resolve({ output: parsed, usage: j.usageMetadata || {}, raw: text });
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---------- main ----------

function stripMeta(obj) {
  const out = {};
  for (const k of Object.keys(obj)) if (!k.startsWith('_')) out[k] = obj[k];
  return out;
}

async function run() {
  const args = parseArgs(process.argv);
  if (args.dryRun) console.log('[dry-run] no API calls will be made');

  console.log('Loading AI constants from main.pb.js ...');
  const ai = loadAiInputs();
  console.log(`Source: ${path.relative(REPO, HOOK_FILE)} (AI_PROMPT_VERSION ${ai.promptVersion})`);
  console.log(`Variants registered: ${Object.keys(ai.variants).join(', ')}`);

  const cases = listCases(args.cases, args.filter);
  console.log(`Cases found: ${cases.length}` + (args.filter ? ` (filter: ${args.filter})` : ''));
  if (!cases.length) { console.log('Nothing to do.'); return; }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!args.dryRun && args.provider === 'gemini' && !apiKey) {
    console.warn('GEMINI_API_KEY not set — falling back to dry-run.');
    args.dryRun = true;
  }

  const results = [];
  const limit = args.maxCases || cases.length;
  for (let i = 0; i < Math.min(cases.length, limit); i++) {
    const c = cases[i];
    let loaded;
    try { loaded = loadCase(c.dir); }
    catch (e) {
      console.log(`[${i + 1}/${limit}] ${c.id} ... LOAD-FAIL: ${e.message}`);
      results.push({ id: c.id, status: 'load-fail', error: e.message });
      continue;
    }
    const { expected, photoB64, photoExists } = loaded;
    const workCategory = expected._meta.workCategory;
    const description = expected._meta.description || '';
    const built = ai.buildAiInputs(workCategory, description);
    process.stdout.write(`[${i + 1}/${limit}] ${c.id} (${workCategory}) ... `);

    if (args.dryRun) {
      // validate expected.json shape against the built schema (without `_meta`)
      const errs = validate(stripMeta(expected), built.schema);
      const photoNote = photoExists ? '' : ' (no photo.jpg)';
      if (errs.length) {
        console.log('DRY-RUN SCHEMA ERRORS' + photoNote + ':');
        for (const e of errs) console.log('   - ' + e);
      } else {
        console.log('dry-run OK' + photoNote);
      }
      results.push({ id: c.id, status: 'dry-run', workCategory, photoExists, schemaErrors: errs });
      continue;
    }
    if (!photoExists) {
      console.log('SKIP (no photo.jpg)');
      results.push({ id: c.id, status: 'skip-no-photo', workCategory });
      continue;
    }

    let r;
    try { r = await callGemini(photoB64, built.prompt, built.schema, apiKey); }
    catch (e) {
      console.log('CALL-FAIL:', e.message);
      results.push({ id: c.id, status: 'call-fail', workCategory, error: e.message });
      continue;
    }
    const schemaErrors = validate(r.output, built.schema);
    const scored = scoreCase(expected, r.output, built.schema);
    console.log(`score ${scored.score.toFixed(3)}` + (schemaErrors.length ? ` (${schemaErrors.length} schema errors)` : ''));
    results.push({
      id: c.id,
      status: 'ok',
      workCategory,
      expected: stripMeta(expected),
      actual: r.output,
      caseScore: scored.score,
      fields: scored.fields,
      schemaErrors,
      usage: r.usage,
    });
  }

  // ---- summary ----
  const ok = results.filter(r => r.status === 'ok');
  console.log('\n== Summary ==');
  const dr = results.filter(r => r.status === 'dry-run').length;
  const skip = results.filter(r => r.status === 'skip-no-photo').length;
  const fail = results.filter(r => /fail|error/.test(r.status)).length;
  console.log(`Run: ${ok.length} ok, ${dr} dry-run, ${skip} skipped (no photo), ${fail} failed`);

  if (ok.length) {
    const overall = ok.reduce((a, r) => a + r.caseScore, 0) / ok.length;
    console.log(`Overall accuracy: ${overall.toFixed(3)}`);
    const byVariant = {};
    for (const r of ok) {
      byVariant[r.workCategory] = byVariant[r.workCategory] || { sum: 0, n: 0 };
      byVariant[r.workCategory].sum += r.caseScore;
      byVariant[r.workCategory].n++;
    }
    console.log('Per-variant:');
    for (const k of Object.keys(byVariant)) {
      console.log(`  ${k.padEnd(28)} ${(byVariant[k].sum / byVariant[k].n).toFixed(3)}  (n=${byVariant[k].n})`);
    }
    const byField = {};
    for (const r of ok) {
      for (const fk of Object.keys(r.fields)) {
        byField[fk] = byField[fk] || { sum: 0, n: 0 };
        byField[fk].sum += r.fields[fk].score;
        byField[fk].n++;
      }
    }
    console.log('Per-field:');
    for (const fk of Object.keys(byField).sort()) {
      console.log(`  ${fk.padEnd(28)} ${(byField[fk].sum / byField[fk].n).toFixed(3)}  (n=${byField[fk].n})`);
    }
  }

  // ---- persist ----
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  const runFile = path.join(RUNS_DIR, new Date().toISOString().replace(/[:.]/g, '-') + '.json');
  fs.writeFileSync(runFile, JSON.stringify({
    timestamp: new Date().toISOString(),
    promptVersion: ai.promptVersion,
    provider: args.provider,
    args,
    results,
  }, null, 2));
  console.log(`\nRun saved: ${path.relative(REPO, runFile)}`);
}

run().catch(e => { console.error(e); process.exit(1); });
