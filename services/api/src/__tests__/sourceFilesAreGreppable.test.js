/**
 * No source file may contain a raw control byte.
 *
 * WHY THIS EXISTS. `pdfgenerator/src/routes/documents.ts` spelled the control-char
 * class of its two path-traversal guards with the LITERAL U+0000..U+001F bytes,
 * where the escape spelling would have read identically to the regex engine. The
 * NUL bytes make the file binary to `file(1)`, and grep/ripgrep silently skip
 * matches in binary files: every code search over that 1449-line route file
 * returned NOTHING. Combined with a stale line-number citation in `billstorage.ts`
 * ("the by-key route at documents.ts:639"), the honest conclusion from searching
 * was that `GET /documents/by-key` did not exist — so the archived bill PDFs
 * looked unretrievable. Both routes were there the whole time, at 722 and 815.
 *
 * A file that cannot be searched is a file whose contents get re-derived by
 * guesswork. Escape sequences are semantically identical (asserted separately by
 * running the extracted regexes against a real NUL and BEL), so there is no reason
 * to keep the raw bytes.
 *
 * TAB (0x09), LF (0x0a) and CR (0x0d) are legitimate whitespace and allowed.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

// Hand-written source only. Locales are JSON (checked too — a stray control byte
// in a translation would break the same way), but node_modules/build output is not
// ours to police.
const ROOTS = [
  'services/api/src',
  'services/common/src',
  'services/pdfgenerator/src',
  'services/authenticator/src',
  'services/emailer/src',
  'services/gateway/src',
  'services/tenantapi/src',
  'types/src',
  'webapps/landlord/src',
  'webapps/tenant/src'
];
const EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.ejs']);
const ALLOWED = new Set([0x09, 0x0a, 0x0d]);

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.next') continue;
      walk(p, out);
    } else if (EXT.has(path.extname(e.name))) {
      out.push(p);
    }
  }
  return out;
}

describe('source files stay searchable', () => {
  const files = ROOTS.flatMap((r) => walk(path.join(REPO, r), []));

  it('finds source files to check (the walk itself must not silently pass)', () => {
    // A broken ROOTS path would make every assertion below vacuously true — the
    // exact failure mode this suite exists to prevent elsewhere.
    expect(files.length).toBeGreaterThan(400);
  });

  it('contains no raw control bytes outside tab/newline/CR', () => {
    const offenders = [];
    for (const f of files) {
      const buf = fs.readFileSync(f);
      for (let i = 0; i < buf.length; i++) {
        const b = buf[i];
        if (b < 0x20 && !ALLOWED.has(b)) {
          offenders.push({
            file: path.relative(REPO, f),
            line: buf.subarray(0, i).toString('utf8').split('\n').length,
            byte: `0x${b.toString(16).padStart(2, '0')}`
          });
          break; // one report per file is enough to act on
        }
      }
    }
    // Named, so the failure message says WHICH file and WHERE — the information
    // grep could not give when the bytes were there.
    expect(offenders).toEqual([]);
  });
});
