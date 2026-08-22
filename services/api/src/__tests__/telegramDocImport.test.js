/* eslint-env node, jest */
/**
 * The Telegram document ORCHESTRATOR — a PDF sent to the bot routes to the
 * lease/Ε9 lane instead of bill OCR, entirely through the scanner's DI seams
 * (no network, no mongo, no pdfjs: extractPdfText is injected).
 *
 * The lease lane runs the REAL parseGreekLease (pure regex, fast) over the
 * same AADE receipt text its own suite parses — so these tests break if the
 * parser and the orchestrator drift apart. The Ε9 parser is stubbed shaped
 * (the real one costs ~3s/call and has its own fixture suite); the
 * classification of REAL Ε9 text is covered in docclassify.test.js.
 */
import {
  _awaitParseQueue,
  scanTelegramInbox,
  _clearRetries
} from '../jobs/telegramInboxScanner.js';
import { parseGreekLease } from '../managers/greekleaseparser.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const FIXED_NOW = new Date('2026-08-22T12:00:00.000Z');
const REALM = {
  realmId: 'realm-1',
  realmName: 'Landlord',
  botToken: 'TESTTOKEN',
  adminChatId: '111'
};

const LEASE_TEXT =
  'ΑΠΟΔΕΙΞΗ ΥΠΟΒΟΛΗΣ ΔΗΛΩΣΗΣ ΠΛΗΡΟΦΟΡΙΑΚΩΝ ΣΤΟΙΧΕΙΩΝ ΜΙΣΘΩΣΗΣ ΑΚΙΝΗΤΗΣ ΠΕΡΙΟΥΣΙΑΣ ' +
  'ΑΡ. ΔΗΛΩΣΗΣ   999532166   ΗΜ/ΝΙΑ ΥΠΟΒΟΛΗΣ   01/03/2026 ' +
  'ΣΤΟΙΧΕΙΑ ΕΚΜΙΣΘΩΤH: A/A 1 Κύριος   ΔΟΚΙΜΗ ΚΑΠΠΑ (ΑΦΜ Δηλούντος:999000018) Ποσοστό   100 ' +
  'ΣΤΟΙΧΕΙΑ ΜΙΣΘΩΤH: A/A 1 ΟΝΟΜΑΤΕΠΩΝΥΜΟ/ΕΠΩΝΥΜΙΑ   ΜΙΣΘΩΤΗΣ ΑΛΦΑ (Α.Φ.Μ:999000043) Ημ/νία Αποδοχής 26/03/2026 ' +
  'ΣΤΟΙΧΕΙΑ ΜΙΣΘΩΣΗΣ ΗΜΕΡΟΜΗΝΙΑ ΕΝΑΡΞΗΣ ΜΙΣΘΩΣΗΣ   01/01/2023';

const E9_TEXT =
  'ΒΕΒΑΙΩΣΗ ΥΠΟΒΟΛΗΣ ΔΗΛΩΣΗΣ ΣΤΟΙΧΕΙΩΝ ΑΚΙΝΗΤΩΝ ΕΤΟΥΣ 2026 (Ε9) ΠΙΝΑΚΑΣ 1';

const E9_PARSED = {
  owner: { taxId: '999000018', lastName: 'ΔΟΚΙΜΗ', firstName: 'ΚΑΠΠΑ' },
  buildings: [
    {
      address: { street1: 'ΟΔΟΣ ΑΛΦΑ 12', zipCode: '11111' },
      units: [{ atakNumber: '1' }, { atakNumber: '2' }]
    },
    {
      address: { street1: 'ΟΔΟΣ ΒΗΤΑ 4', zipCode: '22222' },
      units: [{ atakNumber: '3' }]
    }
  ],
  skippedLandPlots: 0
};

function pdfMsg(updateId, messageId, fileName = 'doc.pdf') {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      chat: { id: 111 },
      document: {
        file_id: `doc-${messageId}`,
        file_name: fileName,
        mime_type: 'application/pdf'
      }
    }
  };
}

function makeDeps({
  updates = [],
  pdfText = '',
  extractThrows = false,
  parseE9Result = E9_PARSED,
  classifyResult = { kind: 'extension', matchedTenantId: 't-1' }
} = {}) {
  const state = {
    created: [],
    rows: {},
    replies: [],
    edits: [],
    updates: [],
    archives: [],
    parseBillCalls: 0,
    extractCalls: []
  };
  const deps = {
    now: () => FIXED_NOW,
    findTelegramRealms: async () => [REALM],
    getOffset: async () => 0,
    setOffset: async () => {},
    getUpdates: async () => updates,
    downloadFile: async () => ({
      buffer: Buffer.from('%PDF-fake'),
      fileName: 'doc.pdf'
    }),
    parseBill: async () => {
      state.parseBillCalls++;
      return { success: false, error: 'not a bill' };
    },
    findMatch: async () => null,
    hasInboxItem: async () => false,
    createInboxItem: async (doc) => {
      const id = `item-${state.created.length + 1}`;
      const row = { _id: id, ...doc };
      state.created.push(row);
      state.rows[id] = row;
      return id;
    },
    updateInboxItem: async (id, patch) => {
      state.updates.push({ id, patch });
      if (state.rows[id]) Object.assign(state.rows[id], patch);
      return true;
    },
    sendReply: async (_b, _c, text) => {
      state.replies.push(text);
      return 9000 + state.replies.length;
    },
    editReply: async (_b, _c, messageId, text) => {
      state.edits.push({ messageId, text });
    },
    archiveSource: async (realm, billLikeId, fileName, _buf, contentType) => {
      state.archives.push({ billLikeId, contentType });
      return `${realm.realmId}/docs/${billLikeId}/${fileName}`;
    },
    tryRecapture: async () => false,
    extractPdfText: async (_buf, maxPages) => {
      state.extractCalls.push(maxPages ?? null);
      if (extractThrows) throw new Error('pdfjs exploded');
      return pdfText;
    },
    parseLeaseText: parseGreekLease,
    parseE9Text: () => parseE9Result,
    classifyLease: async () => classifyResult
  };
  return { deps, state };
}

beforeEach(() => _clearRetries());

describe('telegram document orchestrator — routing at receipt', () => {
  it('a lease PDF becomes a leaseImport row: named ack, parsed payload, fresh-enough summary, honest shadow reply', async () => {
    const { deps, state } = makeDeps({
      updates: [pdfMsg(1, 100, 'misthotirio.pdf')],
      pdfText: LEASE_TEXT
    });
    await scanTelegramInbox(deps);
    await _awaitParseQueue();

    const row = state.created[0];
    expect(row.kind).toBe('leaseImport');
    expect(state.replies[0]).toContain('μισθωτήριο');
    // the worker finished it: pending, with the parser's own output verbatim
    expect(row.status).toBe('pending');
    expect(row.parseError).toBeUndefined();
    expect(row.importDoc.docKind).toBe('lease');
    expect(row.importDoc.parsed.tenants[0].taxId).toBe('999000043');
    expect(row.importDoc.summary.title).toContain('ΜΙΣΘΩΤΗΣ ΑΛΦΑ');
    expect(row.importDoc.summary.title).toContain('999000043');
    expect(row.importDoc.summary.classification).toBe('extension');
    // the original was archived and its key stored — the dialogs re-use it
    expect(state.archives).toEqual([
      { billLikeId: 'tg-100', contentType: 'application/pdf' }
    ]);
    expect(row.sourcePdfUrl).toContain('tg-100');
    // the final reply says what arrived and that NOTHING was imported
    const finalText = state.edits[state.edits.length - 1].text;
    expect(finalText).toContain('μισθωτήριο');
    expect(finalText).toContain('Δεν καταχωρήθηκε τίποτα αυτόματα');
    // and the bill lane never ran
    expect(state.parseBillCalls).toBe(0);
  });

  it('an Ε9 PDF becomes an e9Import row with the counted summary', async () => {
    const { deps, state } = makeDeps({
      updates: [pdfMsg(1, 101, 'e9-2026.pdf')],
      pdfText: E9_TEXT
    });
    await scanTelegramInbox(deps);
    await _awaitParseQueue();

    const row = state.created[0];
    expect(row.kind).toBe('e9Import');
    expect(state.replies[0]).toContain('Ε9');
    expect(row.status).toBe('pending');
    expect(row.importDoc.docKind).toBe('e9');
    expect(row.importDoc.parsed.owner.taxId).toBe('999000018');
    expect(row.importDoc.summary.title).toBe('2 κτίρια · 3 μονάδες');
    expect(row.importDoc.summary.subtitle).toBe('ΟΔΟΣ ΑΛΦΑ 12 + 1 ακόμη');
    expect(state.parseBillCalls).toBe(0);
  });

  it('lease header but an empty full parse dead-ends HONESTLY, never into bill OCR', async () => {
    // Carries the header (classifies lease) but none of the tenant/property
    // sections — parseGreekLease returns the empty shape.
    const { deps, state } = makeDeps({
      updates: [pdfMsg(1, 102)],
      pdfText: 'ΔΗΛΩΣΗ ΠΛΗΡΟΦΟΡΙΑΚΩΝ ΣΤΟΙΧΕΙΩΝ ΜΙΣΘΩΣΗΣ — και τίποτα άλλο'
    });
    await scanTelegramInbox(deps);
    await _awaitParseQueue();

    const row = state.created[0];
    expect(row.kind).toBe('leaseImport');
    expect(row.status).toBe('pending');
    expect(row.parseError).toContain('δεν διαβάστηκαν στοιχεία');
    expect(row.importDoc.parsed).toBeNull();
    expect(state.parseBillCalls).toBe(0);
    expect(state.edits[state.edits.length - 1].text).toContain(
      'δεν διαβάστηκε'
    );
  });

  it('an Ε9 with only land plots gets the ΠΙΝΑΚΑΣ-2 message, not «nothing found»', async () => {
    const { deps, state } = makeDeps({
      updates: [pdfMsg(1, 103)],
      pdfText: E9_TEXT,
      parseE9Result: {
        owner: { taxId: '999000018' },
        buildings: [],
        skippedLandPlots: 3
      }
    });
    await scanTelegramInbox(deps);
    await _awaitParseQueue();
    expect(state.created[0].parseError).toContain('ΠΙΝΑΚΑΣ 2');
  });

  it('a PDF that is a BILL falls through to the bill lane unchanged', async () => {
    const { deps, state } = makeDeps({
      updates: [pdfMsg(1, 104, 'deh.pdf')],
      pdfText: 'ΔΕΗ ΛΟΓΑΡΙΑΣΜΟΣ ΡΕΥΜΑΤΟΣ ΠΛΗΡΩΤΕΟ ΠΟΣΟ 186,21'
    });
    await scanTelegramInbox(deps);
    await _awaitParseQueue();
    expect(state.created[0].kind).toBe('bill');
    expect(state.parseBillCalls).toBe(1);
  });

  it('a NON-PDF document never runs extraction — straight to the bill lane', async () => {
    const { deps, state } = makeDeps({
      updates: [
        {
          update_id: 1,
          message: {
            message_id: 105,
            chat: { id: 111 },
            document: {
              file_id: 'img-105',
              file_name: 'bill.jpg',
              mime_type: 'image/jpeg'
            }
          }
        }
      ],
      pdfText: LEASE_TEXT // would misroute if extraction ran
    });
    await scanTelegramInbox(deps);
    await _awaitParseQueue();
    expect(state.extractCalls).toEqual([]);
    expect(state.created[0].kind).toBe('bill');
    expect(state.parseBillCalls).toBe(1);
  });

  it('a PHOTO never classifies — the photographed-bill lane is untouched', async () => {
    const { deps, state } = makeDeps({
      updates: [
        {
          update_id: 1,
          message: {
            message_id: 106,
            chat: { id: 111 },
            photo: [
              { file_id: 'p-small' },
              { file_id: 'p-big', file_size: 5000 }
            ]
          }
        }
      ],
      pdfText: LEASE_TEXT
    });
    await scanTelegramInbox(deps);
    await _awaitParseQueue();
    expect(state.extractCalls).toEqual([]);
    expect(state.created[0].kind).toBe('bill');
  });

  it('extraction THROWING routes to the bill lane — a hostile PDF is never dropped', async () => {
    const { deps, state } = makeDeps({
      updates: [pdfMsg(1, 107)],
      extractThrows: true
    });
    await scanTelegramInbox(deps);
    await _awaitParseQueue();
    expect(state.created[0].kind).toBe('bill');
    expect(state.parseBillCalls).toBe(1);
  });

  it('the TICK extracts only the header; the WORKER extracts in full', async () => {
    // The tick's await is ahead of the ack and of the 'processing' row, and the
    // poller's re-entrancy guard means a long extraction there freezes every
    // realm's ingest with nothing visible anywhere. So the tick reads 2 pages to
    // route, and the full text is read again in the worker.
    const { deps, state } = makeDeps({
      updates: [pdfMsg(1, 120)],
      pdfText: LEASE_TEXT
    });
    await scanTelegramInbox(deps);
    await _awaitParseQueue();
    // the harness records `maxPages ?? null`: 2 on the tick, uncapped in the worker
    expect(state.extractCalls).toEqual([2, null]);
    // and the full parse still produced the payload
    expect(state.created[0].importDoc.parsed.tenants[0].taxId).toBe(
      '999000043'
    );
  });

  it('persists the mime type, defaulting a classified PDF to application/pdf', async () => {
    // A PDF sent as a document with no «.pdf» in its name was archived as
    // image/jpeg and later served as octet-stream, which the document-upload
    // middleware refuses — so the lease dialog silently failed to keep the
    // original.
    const { deps, state } = makeDeps({
      updates: [
        {
          update_id: 1,
          message: {
            message_id: 121,
            chat: { id: 111 },
            document: {
              file_id: 'd-121',
              // Telegram says PDF; the NAME carries no extension. The old
              // filename sniff therefore archived it as image/jpeg and served
              // it as octet-stream, which the upload middleware refuses.
              file_name: 'Μισθωτήριο',
              mime_type: 'application/pdf'
            }
          }
        }
      ],
      pdfText: LEASE_TEXT
    });
    await scanTelegramInbox(deps);
    await _awaitParseQueue();
    expect(state.created[0].kind).toBe('leaseImport');
    expect(state.created[0].sourceMimeType).toBe('application/pdf');
    expect(state.archives[0].contentType).toBe('application/pdf');
  });

  it('a document with NEITHER a .pdf name nor a PDF mime type is not classified', async () => {
    // Conservative on purpose: without one of the two signals we cannot know it
    // is a PDF, so it takes the bill lane (which sniffs the bytes itself).
    const { deps, state } = makeDeps({
      updates: [
        {
          update_id: 1,
          message: {
            message_id: 122,
            chat: { id: 111 },
            document: { file_id: 'd-122', file_name: 'σκαναρισμα' }
          }
        }
      ],
      pdfText: LEASE_TEXT
    });
    await scanTelegramInbox(deps);
    await _awaitParseQueue();
    expect(state.extractCalls).toEqual([]);
    expect(state.created[0].kind).toBe('bill');
  });

  it('the DI seams are optional in the TYPE only — an omitted one is the REAL thing', async () => {
    // WHY THIS TRAP MATTERS: `scanTelegramInbox` merges
    // `{..._defaultDeps(), ...overrides}`, so a seam a test does not inject is
    // the PRODUCTION implementation, not a no-op. A bill-lane test that sends a
    // `.pdf` and omits `extractPdfText` therefore ran real pdfjs on its fixture
    // buffer and timed out under load.
    //
    // HONEST LIMITATION, stated because two earlier versions of this test
    // overclaimed: this is a SOURCE anchor plus a shape check, NOT a behavioural
    // pin. Proving the merge behaviourally means letting a run reach a default
    // seam, and every default here is mongo or pdfjs — unavailable in this suite.
    // (The first version called a `_defaultDepsForTest` that does not exist, so
    // its assertions never executed; the second asserted only that
    // `_defaultDeps()` returns functions, which is true whether or not the merge
    // happens. Both were mutation-verified as useless AFTER being written, which
    // is the wrong order.)
    const mod = await import('../jobs/telegramInboxScanner.js');
    const defaults = mod._defaultDeps();
    for (const seam of [
      'extractPdfText',
      'parseLeaseText',
      'parseE9Text',
      'classifyLease'
    ]) {
      // Production really does supply each one — which is exactly what makes an
      // omitted seam dangerous rather than absent.
      expect(typeof defaults[seam]).toBe('function');
    }

    const src = fs.readFileSync(
      path.join(HERE, '../jobs/telegramInboxScanner.ts'),
      'utf8'
    );
    // SCOPE TO THE FUNCTION BODY. The doc comment on InboxScanDeps quotes the
    // merge expression verbatim to explain the trap, so a whole-file match is
    // satisfied by the comment alone — verified: deleting the real merge left
    // this test green. Same wrong-occurrence trap as anchoring on the first
    // `kind: 'voiceCommand'` (which was the query, not the create).
    const fnAt = src.indexOf('export async function scanTelegramInbox');
    expect(fnAt).toBeGreaterThan(-1);
    const body = src.slice(fnAt, src.indexOf('\n}', fnAt));
    expect(body).toMatch(/\{\s*\.\.\._defaultDeps\(\),\s*\.\.\.overrides\s*\}/);
    // and the corrected warning still stands somewhere in the file
    expect(src).toContain('Optional in the TYPE only');
  });

  it('classification failure is advisory: the lease row still lands, without a verdict', async () => {
    const { deps, state } = makeDeps({
      updates: [pdfMsg(1, 108)],
      pdfText: LEASE_TEXT
    });
    deps.classifyLease = async () => {
      throw new Error('mongo blip');
    };
    await scanTelegramInbox(deps);
    await _awaitParseQueue();
    const row = state.created[0];
    expect(row.status).toBe('pending');
    expect(row.parseError).toBeUndefined();
    expect(row.importDoc.summary.classification).toBeUndefined();
  });
});
