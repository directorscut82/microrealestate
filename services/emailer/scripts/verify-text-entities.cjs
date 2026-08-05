#!/usr/bin/env node
/**
 * Regression check for the Mustache HTML-escaping leak into plain-text email.
 *
 * i18n renders every {{placeholder}} through Mustache (node_modules/i18n/i18n.js:621)
 * and Mustache HTML-escapes by default, so `/ ' & < >` in any interpolated value
 * became entities. In the HTML body they decode and are invisible; in the plain-text
 * body (and the subject line) the tenant sees `07&#x2F;08&#x2F;2026` / `O&#39;Neil`.
 *
 * The escaping is NOT disabled globally on purpose: the HTML templates interpolate
 * tenant-supplied names through raw `<%-`, so Mustache is the only thing preventing
 * markup injection there. emailcontent.ts therefore decodes the TEXT+SUBJECT only.
 *
 * The emailer has no jest harness; run this directly after touching emailcontent.ts
 * or the locales:  node services/emailer/scripts/verify-text-entities.cjs
 */
const path = require('path');
const fs = require('fs');
const i18n = require('i18n');

const pkgRoot = path.join(__dirname, '..');
const distFile = path.join(pkgRoot, 'dist', 'emailcontent.js');
if (!fs.existsSync(distFile)) {
  console.error('dist/emailcontent.js missing — run `yarn build` in services/emailer first.');
  process.exit(1);
}

// Load the SHIPPED table + function, so this tests real code rather than a copy.
const src = fs.readFileSync(distFile, 'utf8');
const table = src.match(/const _TEXT_ENTITIES = \{[\s\S]*?\};/);
const fn = src.match(/function _decodeTextEntities\([\s\S]*?\n\}/);
if (!table || !fn) {
  console.error('could not extract _decodeTextEntities from dist — did it get renamed?');
  process.exit(1);
}
// eslint-disable-next-line no-eval
eval(`${table[0]}\n${fn[0]}`);

i18n.configure({
  locales: ['en', 'el'],
  directory: path.join(pkgRoot, 'src', 'locales'),
  objectNotation: false,
  updateFiles: false
});
i18n.setLocale('el');

const CASES = [
  { label: 'date', value: '07/08/2026', mustNotContain: '&#x2F;' },
  { label: 'apostrophe', value: "O'Neil", mustNotContain: '&#39;' },
  { label: 'ampersand', value: 'Alpha & Beta', mustNotContain: '&amp;' },
  { label: 'angle brackets', value: '<b>x</b>', mustNotContain: '&lt;' }
];

let failed = 0;
for (const c of CASES) {
  const rendered = i18n.__('Property: {{name}}', { name: c.value });
  const asText = _decodeTextEntities(rendered);
  const ok = !asText.includes(c.mustNotContain) && asText.includes(c.value);
  if (!ok) failed++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${c.label.padEnd(15)} text=${JSON.stringify(asText)}`
  );
  // The HTML path must KEEP its escaping — that is the injection guard.
  if (c.label === 'angle brackets' && !rendered.includes('&lt;')) {
    console.log('FAIL  html path lost its escaping — injection guard gone');
    failed++;
  }
}

// A count-agnostic Greek plural: «σε {{n}} ημέρα/ες» must be grammatical for 0/1/many.
for (const n of ['0', '1', '2']) {
  const out = i18n.__('The lease for {{name}} expires on {{date}} (in {{n}} days).', {
    name: 'ΔΟΚΙΜΗ',
    date: '07/08/2026',
    n
  });
  const text = _decodeTextEntities(out);
  const bad = /σε 1 ημέρες/.test(text);
  if (bad) failed++;
  console.log(`${bad ? 'FAIL' : 'PASS'}  plural n=${n}      ${text.slice(-34)}`);
}

process.exit(failed ? 1 : 0);
