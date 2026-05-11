// One-time backfill: set ontology_edition = "bca-conquas-pr-2025" on every
// project where it's empty/null. Fixes the historical signups whose Default
// Project was auto-created by js/db.js without the default edition string.
//
// Usage:
//   $env:PB_URL          = "https://api.siteshrimp.org"
//   $env:PB_ADMIN_EMAIL  = "woonwei.pong@gmail.com"   # superuser email
//   $env:PB_ADMIN_PASS   = "..."                       # set via secure input
//   node tools/backfill-ontology-edition.js --dry-run
//   node tools/backfill-ontology-edition.js --apply
//
// Source of truth: js/app.js DEFAULT_ONTOLOGY_EDITION = "bca-conquas-pr-2025".

'use strict';

const https = require('https');
const { URL } = require('url');

const DEFAULT_EDITION = 'bca-conquas-pr-2025';

function parseArgs(argv) {
  const args = { apply: false, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--apply') args.apply = true;
    else if (a === '-h' || a === '--help') { printHelp(); process.exit(0); }
    else { console.error('Unknown arg:', a); process.exit(1); }
  }
  if (!args.apply && !args.dryRun) args.dryRun = true; // default safe
  return args;
}

function printHelp() {
  console.log([
    '',
    'Usage: node tools/backfill-ontology-edition.js [--dry-run|--apply]',
    '',
    'Sets ontology_edition="bca-conquas-pr-2025" on every project where the',
    'value is empty/null. --dry-run lists what would change; --apply commits.',
    '',
    'Environment:',
    '  PB_URL          PocketBase base URL  (default: https://api.siteshrimp.org)',
    '  PB_ADMIN_EMAIL  superuser email',
    '  PB_ADMIN_PASS   superuser password',
    '',
  ].join('\n'));
}

function req(method, urlStr, body, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method,
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': data ? Buffer.byteLength(data) : 0,
      }, headers || {}),
    };
    const r = https.request(opts, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`${method} ${urlStr} → ${res.statusCode}: ${buf.slice(0, 400)}`));
        }
        try { resolve(buf ? JSON.parse(buf) : {}); }
        catch (e) { resolve(buf); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function authSuperuser(base, email, pass) {
  const r = await req('POST', `${base}/api/collections/_superusers/auth-with-password`, {
    identity: email, password: pass,
  });
  if (!r.token) throw new Error('Superuser auth returned no token');
  return r.token;
}

async function listAllProjects(base, token) {
  const out = [];
  let page = 1;
  while (true) {
    const r = await req('GET',
      `${base}/api/collections/projects/records?perPage=200&page=${page}&fields=id,name,companyId,ontology_edition,archived,createdAt`,
      null, { Authorization: token });
    if (!r.items) break;
    out.push(...r.items);
    if (r.items.length < 200) break;
    page++;
  }
  return out;
}

async function patchProject(base, token, id, body) {
  return req('PATCH', `${base}/api/collections/projects/records/${id}`, body,
    { Authorization: token });
}

async function main() {
  const args = parseArgs(process.argv);
  const base = process.env.PB_URL || 'https://api.siteshrimp.org';
  const email = process.env.PB_ADMIN_EMAIL;
  const pass = process.env.PB_ADMIN_PASS;
  if (!email || !pass) {
    console.error('PB_ADMIN_EMAIL and PB_ADMIN_PASS must be set.');
    process.exit(1);
  }
  console.log(`Target: ${base}  (mode: ${args.apply ? 'APPLY' : 'DRY-RUN'})`);
  const token = await authSuperuser(base, email, pass);
  console.log('Authed as superuser.');
  const projects = await listAllProjects(base, token);
  console.log(`Projects: ${projects.length} total`);

  const needs = projects.filter(p => !p.ontology_edition || p.ontology_edition === '');
  console.log(`Needing backfill (empty/null ontology_edition): ${needs.length}`);
  if (!needs.length) { console.log('Nothing to do.'); return; }

  console.log('');
  console.log('id        | created    | arch | name');
  console.log('----------+------------+------+----------------------------------');
  for (const p of needs) {
    const arch = p.archived ? ' YES  ' : '      ';
    console.log(`${p.id.padEnd(9)} | ${String(p.createdAt || '').slice(0,10).padEnd(10)} | ${arch}| ${p.name}`);
  }
  console.log('');

  if (!args.apply) {
    console.log(`[dry-run] would PATCH ${needs.length} projects to ontology_edition="${DEFAULT_EDITION}".`);
    console.log('Re-run with --apply to commit.');
    return;
  }

  let ok = 0, fail = 0;
  for (const p of needs) {
    try {
      await patchProject(base, token, p.id, { ontology_edition: DEFAULT_EDITION });
      ok++;
      process.stdout.write('.');
    } catch (e) {
      fail++;
      console.error(`\n  FAIL ${p.id} (${p.name}): ${e.message}`);
    }
  }
  console.log(`\nApplied: ${ok} ok, ${fail} failed.`);
}

main().catch(e => { console.error(e); process.exit(1); });
