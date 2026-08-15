/* eslint-env node, jest */
/**
 * THE BOT↔LANDLORD PROTOCOL: ack now, parse later, one message that changes.
 *
 * WHAT IT USED TO BE. The poll tick did everything inline — download, OCR (up to ~50s per
 * page), archive, match, then create the row and send ONE message. Three consequences the
 * landlord actually felt:
 *   · up to 60s of poll wait plus the whole parse before the bot said anything at all;
 *   · the bell had nothing to show, because the row was created only afterwards — so
 *     pressing the notification mid-parse showed the previous state, and «not received»
 *     was indistinguishable from «still working». That is what made people re-send bills,
 *     which minted duplicate items to dismiss;
 *   · the single-flight guard meant one multi-page PDF blocked every other realm behind it.
 *
 * WHAT IT IS NOW. The tick acknowledges immediately, writes the row as 'processing', and
 * hands the parse to a bounded worker. The parse finishes the row and EDITS the ack into
 * the outcome.
 *
 * These tests pin the protocol, not the wording: when the ack is sent relative to the
 * parse, that the row is visible before the parse, that the queue is bounded, and that a
 * stalled row is released rather than left saying «reading…» forever.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { jest } from '@jest/globals';

// ESM suite (--experimental-vm-modules): `require` and `__dirname` are undefined.
const HERE = path.dirname(fileURLToPath(import.meta.url));

const FIXED_NOW = new Date('2026-08-15T09:00:00.000Z');
const REALM = {
  realmId: 'realm-1',
  realmName: 'Landlord',
  botToken: 'tok',
  adminChatId: '55'
};

let scanTelegramInbox;
let _awaitParseQueue;
let sweepStalledProcessing;
let inboxDocs;
/** Set by a test to mutate rows between the sweep's find and its write. */
let afterFind = null;

beforeAll(async () => {
  inboxDocs = [];
  await jest.unstable_mockModule('@microrealestate/common', () => {
    class ServiceError extends Error {
      constructor(message, statusCode) {
        super(message);
        this.statusCode = statusCode;
      }
    }
    return {
      Collections: {
        // The sweep runs against these two.
        InboxItem: {
          find: (q) => ({
            limit: () => ({
              lean: async () => {
                const res = inboxDocs.filter(
                  (d) =>
                    d.status === q.status &&
                    (!q.updatedDate || d.updatedDate < q.updatedDate.$lt)
                );
                // The seam that makes the find/write race reproducible: the sweep does two
                // round-trips, and a test can only exercise the WRITE's guard by changing
                // the row in between. Fires once, then disarms.
                if (afterFind) {
                  const h = afterFind;
                  afterFind = null;
                  h();
                }
                return res;
              }
            })
          }),
          updateOne: async (filter, update) => {
            // HONOURS THE WHOLE FILTER, not just _id. A mock that matches on _id alone is
            // more permissive than mongo, so a guard like `{_id, status:'processing'}`
            // cannot be distinguished from `{_id}` — the assertion that the guard exists
            // would pass with the guard deleted. Same class as the mock-factory `...real`
            // trap: the stub has to be able to say NO.
            const row = inboxDocs.find((d) =>
              Object.entries(filter).every(([k, v]) =>
                k === '_id' ? String(d._id) === String(v) : d[k] === v
              )
            );
            if (row) Object.assign(row, update.$set);
            return { matchedCount: row ? 1 : 0 };
          },
          create: async (doc) => ({ ...doc, _id: 'created-1' }),
          exists: async () => null,
          findOne: () => ({ lean: async () => null })
        },
        Realm: { find: () => ({ lean: async () => [] }) },
        Building: { find: () => ({ lean: async () => [] }), findOne: () => ({ lean: async () => null }) },
        TelegramOffset: {},
        Property: { find: () => ({ lean: async () => [] }) },
        Tenant: { find: () => ({ lean: async () => [] }) },
        Bill: { find: () => ({ lean: async () => [] }) }
      },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      ServiceError,
      Crypto: { encrypt: (v) => v, decrypt: (v) => v },
      Service: {
        getInstance: () => ({
          envConfig: { getValues: () => ({}) },
          createServiceToken: async () => 't'
        })
      },
      Middlewares: {},
      OwnerStatement: { LOIPOI_LABEL: 'ΛΟΙΠΟΙ' },
      BuildingProjection: {},
      ShareBasis: {},
      BillTerm: {
        billTermFitsExpense: () => ({ fits: true }),
        /**
         * MUST be here. Without it `parsed.proposedTerm = BillTerm.computeChargeTerm(bill)`
         * threw INSIDE the parse try-block, so every "successful parse" in this file was
         * silently taking the FAILURE branch — the rows reached 'pending' with a parseError
         * of «computeChargeTerm is not a function» and the assertions about status still
         * passed. The suite was pinning a degraded path and calling it the ack protocol.
         * `unstable_mockModule` replaces the WHOLE module, so every export the code under
         * test touches has to be present; a missing one is not a missing stub, it is a
         * different code path.
         */
        computeChargeTerm: (bill) => {
          const d = bill?.issueDate || bill?.periodEnd;
          if (!d) return undefined;
          const dt = d instanceof Date ? d : new Date(String(d));
          return Number(
            `${dt.getUTCFullYear()}${String(dt.getUTCMonth() + 1).padStart(2, '0')}0100`
          );
        }
      }
    };
  });
  const mod = await import('../jobs/telegramInboxScanner.js');
  scanTelegramInbox = mod.scanTelegramInbox;
  _awaitParseQueue = mod._awaitParseQueue;
  sweepStalledProcessing = mod.sweepStalledProcessing;
});

/** A deps set that records the ORDER of everything, which is what the protocol is about. */
function makeDeps({ parseDelayMs = 0, parseResult } = {}) {
  const events = [];
  const state = { created: [], receipts: [], updates: [], replies: [], edits: [] };
  const deps = {
    now: () => FIXED_NOW,
    findTelegramRealms: async () => [REALM],
    getOffset: async () => 0,
    setOffset: async () => {},
    getUpdates: async () => [
      {
        update_id: 42,
        message: {
          message_id: 1001,
          date: Math.floor(FIXED_NOW.getTime() / 1000),
          chat: { id: 55 },
          document: { file_id: 'f1', file_name: 'bill.pdf' }
        }
      }
    ],
    downloadFile: async () => {
      events.push('download');
      return { buffer: Buffer.from('x'), fileName: 'bill.pdf' };
    },
    parseBill: async () => {
      events.push('parse:start');
      if (parseDelayMs) await new Promise((r) => setTimeout(r, parseDelayMs));
      events.push('parse:end');
      return (
        parseResult || {
          success: true,
          bill: {
            provider: 'deh',
            billingId: '999935585',
            billingIdNormalized: '999935585',
            totalAmount: 120,
            periodEnd: new Date('2026-07-09T00:00:00Z'),
            issueDate: new Date('2026-07-12T00:00:00Z')
          },
          rawText: 'x'
        }
      );
    },
    findMatch: async () => null,
    hasInboxItem: async () => false,
    createInboxItem: async (doc) => {
      events.push(`create:${doc.status}`);
      // A UNIQUE id per row. The first version returned a hardcoded 'item-1', so with more
      // than one message every worker update landed on the FIRST row — 7 bills produced 1
      // finished row and 6 stuck in 'processing', which read as a queue defect. The queue
      // was fine; the stub was lying. Same shape as the telegramMessageId collision that
      // made an earlier seeder report success on a failed insert.
      const id = `item-${state.created.length + 1}`;
      const row = { _id: id, ...doc };
      state.created.push(row);
      state.receipts.push({ ...doc });
      return id;
    },
    updateInboxItem: async (id, patch) => {
      events.push(`update:${patch.status}`);
      state.updates.push({ id, patch });
      const row = state.created.find((c) => c._id === id);
      if (row) Object.assign(row, patch);
    },
    tryRecapture: async () => false,
    archiveSource: async () => null,
    sendReply: async (_t, _c, text) => {
      events.push('ack');
      state.replies.push(text);
      return 7001;
    },
    editReply: async (_t, _c, messageId, text) => {
      events.push('edit');
      state.edits.push({ messageId, text });
    }
  };
  return { deps, state, events };
}

describe('the ack comes BEFORE the parse, not after it', () => {
  it('acknowledges and creates a visible row before OCR starts', async () => {
    const { deps, state, events } = makeDeps();
    await scanTelegramInbox(deps);
    // The tick must be DONE before the parse even begins — that is what "background" means.
    expect(events.indexOf('ack')).toBeLessThan(events.indexOf('parse:start'));
    expect(events.indexOf('create:processing')).toBeLessThan(
      events.indexOf('parse:start')
    );
    // The landlord hears something immediately, and it is not the result.
    expect(state.replies[0]).toMatch(/Ελήφθη/);
    expect(state.receipts[0].status).toBe('processing');

    await _awaitParseQueue();
    // …and the SAME message becomes the outcome.
    expect(state.edits).toHaveLength(1);
    expect(state.edits[0].messageId).toBe(7001);
    expect(state.created[0].status).toBe('pending');
    // NO parseError. Asserting only the status let a broken mock send every one of these
    // tests down the failure branch unnoticed for as long as the file existed.
    expect(state.created[0].parseError).toBeFalsy();
    expect(state.created[0].parsed?.totalAmount).toBe(120);
  });

  it('the poll tick returns without waiting for a slow parse', async () => {
    // The regression that matters: if the tick ever awaits the parse again, one 3-page PDF
    // blocks every other message behind it. 300ms stands in for ~50s per page.
    const { deps, events } = makeDeps({ parseDelayMs: 300 });
    const started = Date.now();
    await scanTelegramInbox(deps);
    const tickMs = Date.now() - started;
    expect(events).not.toContain('parse:end'); // still running
    expect(tickMs).toBeLessThan(250); // did not wait for it
    await _awaitParseQueue();
    expect(events).toContain('parse:end');
  });

  it('a row is left in a terminal state even when the parse throws', async () => {
    // A 'processing' row that never resolves renders as «reading…» forever — progress that
    // is really failure, the absent-representation shape. It must land somewhere the
    // landlord can act on.
    const { deps, state } = makeDeps();
    deps.parseBill = async () => {
      throw new Error('OCR exploded');
    };
    await scanTelegramInbox(deps);
    await _awaitParseQueue();
    expect(state.created[0].status).toBe('pending');
    expect(state.created[0].parseError).toBeTruthy();
    // And the landlord is told, on the message they are watching.
    expect(state.edits[0].text).toMatch(/απέτυχε|χειροκίνητ/);
  });
});

describe('the stall sweep', () => {
  it('releases a processing row older than the threshold', async () => {
    inboxDocs = [
      {
        _id: 'stuck-1',
        status: 'processing',
        updatedDate: new Date(FIXED_NOW.getTime() - 20 * 60 * 1000)
      }
    ];
    const released = await sweepStalledProcessing(FIXED_NOW);
    expect(released).toBe(1);
    expect(inboxDocs[0].status).toBe('pending');
    // With a REASON. Silently flipping it to pending would leave an empty card with no
    // explanation of why there is nothing to confirm.
    expect(inboxDocs[0].parseError).toMatch(/διακόπηκε/);
  });

  it('leaves a RECENT processing row alone — a slow parse is not a dead one', async () => {
    inboxDocs = [
      {
        _id: 'live-1',
        status: 'processing',
        updatedDate: new Date(FIXED_NOW.getTime() - 60 * 1000)
      }
    ];
    expect(await sweepStalledProcessing(FIXED_NOW)).toBe(0);
    expect(inboxDocs[0].status).toBe('processing');
  });

  it('ignores rows that already reached a terminal state', async () => {
    inboxDocs = [
      { _id: 'a', status: 'pending', updatedDate: new Date(0) },
      { _id: 'b', status: 'dismissed', updatedDate: new Date(0) },
      { _id: 'c', status: 'confirmed', updatedDate: new Date(0) }
    ];
    expect(await sweepStalledProcessing(FIXED_NOW)).toBe(0);
  });
});

describe('the surfaces agree that processing exists', () => {
  const read = (rel) => fs.readFileSync(path.resolve(HERE, rel), 'utf8');

  it('the schema allows it, the bell renders it, the list returns it', () => {
    expect(read('../../../common/src/collections/inboxItem.ts')).toContain(
      "'processing'"
    );
    const bell = read('../../../../webapps/landlord/src/components/InboxBell.js');
    expect(bell).toContain("item.status === 'processing'");
    // BEFORE the parseError branch and the normal card, or a row with no parsed amount
    // renders as an empty confirmable bill.
    expect(bell.indexOf("item.status === 'processing'")).toBeLessThan(
      bell.indexOf('if (item.parseError)')
    );
    const mgr = read('../managers/inboxmanager.ts');
    expect(mgr).toContain("$in: ['processing', 'pending']");
  });

  it('confirm refuses a processing row with a reason, not «not found»', () => {
    const mgr = read('../managers/inboxmanager.ts');
    expect(mgr).toContain('διαβάζεται ακόμα');
  });
});

describe('the queue cap is BACKPRESSURE, never extra concurrency', () => {
  /**
   * FOUND BY THE FULL REVIEW, gate 1, in code I had just shipped.
   *
   * The cap exists because each queued job retains the file's buffer and the OCR is this
   * container's documented OOM risk. The first version responded to hitting the cap with
   * `void _runParseJob(job)` — un-awaited — so the one moment memory was under pressure was
   * the one moment a SECOND concurrent OCR started. Exactly backwards, and the docstring
   * claimed it ran "inline on the tick", which un-awaited code does not.
   */
  it('never runs two parses at once, even past the cap', async () => {
    let concurrent = 0;
    let peak = 0;
    const { deps } = makeDeps();
    deps.parseBill = async () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, 25));
      concurrent--;
      return {
        success: true,
        bill: {
          provider: 'deh',
          billingId: '999935585',
          billingIdNormalized: '999935585',
          totalAmount: 120,
          periodEnd: new Date('2026-07-09T00:00:00Z'),
          issueDate: new Date('2026-07-12T00:00:00Z')
        },
        rawText: 'x'
      };
    };
    // More messages than the cap, each a distinct update so none is deduped.
    let n = 0;
    deps.getUpdates = async () => {
      if (n++) return [];
      return Array.from({ length: 9 }, (_, i) => ({
        update_id: 100 + i,
        message: {
          message_id: 2000 + i,
          date: Math.floor(FIXED_NOW.getTime() / 1000),
          chat: { id: 55 },
          document: { file_id: `f${i}`, file_name: `bill-${i}.pdf` }
        }
      }));
    };
    await scanTelegramInbox(deps);
    await _awaitParseQueue();
    // THE assertion. 9 bills, cap 4, and never more than one OCR in flight.
    expect({ peak }).toEqual({ peak: 1 });
  });

  it('queues every bill past the cap rather than dropping any', async () => {
    const { deps, state } = makeDeps();
    let n = 0;
    deps.getUpdates = async () => {
      if (n++) return [];
      return Array.from({ length: 7 }, (_, i) => ({
        update_id: 200 + i,
        message: {
          message_id: 3000 + i,
          date: Math.floor(FIXED_NOW.getTime() / 1000),
          chat: { id: 55 },
          document: { file_id: `g${i}`, file_name: `bill-${i}.pdf` }
        }
      }));
    };
    await scanTelegramInbox(deps);
    await _awaitParseQueue();
    // Backpressure must not silently discard: 7 in, 7 rows, 7 finished.
    expect({
      rows: state.created.length,
      statuses: state.created.map((r) => r.status)
    }).toEqual({
      rows: 7,
      statuses: Array(7).fill('pending')
    });
  });

  it('the cap path does not fire an un-awaited job', () => {
    // Source-level, because the concurrency assertion above can be satisfied by luck on a
    // fast machine while the shape is still wrong.
    const src = fs.readFileSync(
      path.resolve(HERE, '../jobs/telegramInboxScanner.ts'),
      'utf8'
    );
    // Strip comments first: this file DOCUMENTS the old broken shape by name, and matching
    // raw source flagged the explanation instead of the code. A source assertion has to look
    // at code, or it fails on its own changelog.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    expect(code).not.toMatch(/void _runParseJob\(/);
    expect(code).toMatch(/await enqueueParse\(/);
  });
});

describe('the sweep must not reap work that is still alive', () => {
  /**
   * FOUND BY GATE 8 on code I had just shipped, and it is a two-stage failure.
   *
   * `updatedDate` is written once, at receipt, and never heartbeated — so it measures how
   * long ago the bill ARRIVED, not how long the work has been silent. Bills queued behind
   * a 3-page PDF (~50s per page plus download) can sit longer than STALE_PROCESSING_MS
   * before their parse even STARTS. The sweep then released a live job, and because the
   * released row is no longer 'processing', `_updateInboxItem`'s guard made the finish a
   * no-op: the bill was read CORRECTLY, the result was thrown away, and the landlord was
   * told the reading had been interrupted and to enter it by hand.
   *
   * The fix is ownership, not a longer timeout: this process knows exactly which rows it
   * is holding, so the sweep asks instead of guessing from a clock.
   */
  it('leaves a queued row alone however long it has been waiting', async () => {
    const { deps, state } = makeDeps({ parseDelayMs: 120 });
    // Two bills. The second waits behind the first, and BOTH carry an arrival time older
    // than the stale threshold — the situation a slow queue produces on its own.
    let n = 0;
    deps.getUpdates = async () => {
      if (n++) return [];
      return [0, 1].map((i) => ({
        update_id: 700 + i,
        message: {
          message_id: 7100 + i,
          date: Math.floor(FIXED_NOW.getTime() / 1000),
          chat: { id: 55 },
          document: { file_id: `q${i}`, file_name: `bill-${i}.pdf` }
        }
      }));
    };
    const scanning = scanTelegramInbox(deps);
    await scanning;
    // Mirror both rows into the collection the sweep reads, aged well past the cutoff.
    inboxDocs = state.created.map((r) => ({
      _id: r._id,
      status: 'processing',
      updatedDate: new Date(FIXED_NOW.getTime() - 40 * 60 * 1000)
    }));
    // The sweep runs on the same 60s interval as the poll, so this is the ordinary case.
    const released = await sweepStalledProcessing(FIXED_NOW);
    expect({ released, statuses: inboxDocs.map((d) => d.status) }).toEqual({
      released: 0,
      statuses: ['processing', 'processing']
    });
    await _awaitParseQueue();
    // …and both parses land, which is the consequence that actually matters: with the
    // timestamp-only sweep the second row's result was discarded.
    expect(state.created.map((r) => r.status)).toEqual(['pending', 'pending']);
    expect(state.created.every((r) => !r.parseError)).toBe(true);
  });

  it('releases the row once the worker is done with it', async () => {
    // Ownership must be given back, or the row becomes permanently un-sweepable — the same
    // «reading…» forever this mechanism exists to prevent, just with a different cause.
    const { deps, state } = makeDeps();
    await scanTelegramInbox(deps);
    await _awaitParseQueue();
    inboxDocs = [
      {
        _id: state.created[0]._id,
        status: 'processing', // as if a later crash left it here
        updatedDate: new Date(FIXED_NOW.getTime() - 40 * 60 * 1000)
      }
    ];
    expect(await sweepStalledProcessing(FIXED_NOW)).toBe(1);
  });

  it('gives ownership back even when the parse THROWS', async () => {
    const { deps, state } = makeDeps();
    deps.parseBill = async () => {
      throw new Error('OCR exploded');
    };
    await scanTelegramInbox(deps);
    await _awaitParseQueue();
    inboxDocs = [
      {
        _id: state.created[0]._id,
        status: 'processing',
        updatedDate: new Date(FIXED_NOW.getTime() - 40 * 60 * 1000)
      }
    ];
    expect(await sweepStalledProcessing(FIXED_NOW)).toBe(1);
  });

  it('does not overwrite a row that finished between the find and the write', async () => {
    // The find and the write are separate round-trips, and the worker can complete in
    // between. Without `status:'processing'` in the WRITE filter the sweep stamps «η
    // ανάγνωση διακόπηκε» onto a row that parsed perfectly — and the bell tests parseError
    // BEFORE it renders the normal card, so a correctly read bill becomes an error card
    // with no confirm button and the landlord cannot post the δαπάνη at all.
    inboxDocs = [
      {
        _id: 'raced-1',
        status: 'processing',
        updatedDate: new Date(FIXED_NOW.getTime() - 40 * 60 * 1000)
      }
    ];
    // The row finishes AFTER the sweep has already selected it.
    afterFind = () => {
      inboxDocs[0].status = 'pending';
      inboxDocs[0].parsed = { totalAmount: 89.94 };
    };
    const released = await sweepStalledProcessing(FIXED_NOW);
    expect({
      released,
      status: inboxDocs[0].status,
      parseError: inboxDocs[0].parseError,
      total: inboxDocs[0].parsed?.totalAmount
    }).toEqual({
      released: 0,
      status: 'pending',
      parseError: undefined,
      total: 89.94
    });
  });
});

describe('the ack must not describe a row that no longer says that', () => {
  it('does not promise «εκκρεμεί επιβεβαίωση» when the update was discarded', async () => {
    // The landlord dismissed the item from the bell while the OCR was running, so
    // `_updateInboxItem` correctly refuses (the human's decision beats the background job).
    // The ack was still edited to «Ελήφθη ο λογαριασμός (120€) — εκκρεμεί επιβεβαίωση στις
    // ειδοποιήσεις», sending them to a notification that does not exist, quoting a figure
    // no surface in the app agrees with.
    const { deps, state } = makeDeps();
    deps.updateInboxItem = async () => false; // the row is gone from under us
    await scanTelegramInbox(deps);
    await _awaitParseQueue();
    expect(state.edits).toHaveLength(1);
    expect(state.edits[0].text).toMatch(/ακυρώθηκε/);
    expect(state.edits[0].text).not.toMatch(/εκκρεμεί επιβεβαίωση/);
  });

  it('still says the normal thing when the update DID land', async () => {
    // The no-regression half: the ordinary path must be untouched.
    const { deps, state } = makeDeps();
    await scanTelegramInbox(deps);
    await _awaitParseQueue();
    expect(state.edits[0].text).toMatch(/εκκρεμεί επιβεβαίωση/);
    expect(state.edits[0].text).not.toMatch(/ακυρώθηκε/);
  });

  it('a parse that THREW and lost its row says so too', async () => {
    const { deps, state } = makeDeps();
    deps.parseBill = async () => {
      throw new Error('OCR exploded');
    };
    deps.updateInboxItem = async () => false;
    await scanTelegramInbox(deps);
    await _awaitParseQueue();
    expect(state.edits[0].text).toMatch(/ακυρώθηκε/);
    // …and it must not send them to the notifications either.
    expect(state.edits[0].text).not.toMatch(/στις ειδοποιήσεις/);
  });
});

describe('the startup sweep does what its comment says', () => {
  it('releases a row that has been processing for only a minute', async () => {
    /**
     * At startup nothing is in flight, so a row still marked 'processing' was left there by
     * the process that died — stalled by definition, whatever its age. The call site has
     * always said it releases these «before the first poll rather than after 15 minutes»,
     * but it passed no cutoff override, so a row updated shortly before the crash sat at
     * «το διαβάζω τώρα…» for the rest of the quarter hour. A comment describing behaviour
     * the code does not have is worse than no comment.
     */
    inboxDocs = [
      {
        _id: 'fresh-crash',
        status: 'processing',
        updatedDate: new Date(FIXED_NOW.getTime() - 60 * 1000)
      }
    ];
    expect(await sweepStalledProcessing(FIXED_NOW, 0)).toBe(1);
    expect(inboxDocs[0].status).toBe('pending');
  });

  it('the periodic sweep keeps its age cutoff', async () => {
    // staleMs 0 is for startup ONLY. If the interval used it, every parse would be reaped
    // the moment it began — and after the ownership fix that would be silent, because the
    // owned-row check would be doing all the work.
    inboxDocs = [
      {
        _id: 'live-2',
        status: 'processing',
        updatedDate: new Date(FIXED_NOW.getTime() - 60 * 1000)
      }
    ];
    expect(await sweepStalledProcessing(FIXED_NOW)).toBe(0);
  });

  it('the startup call site passes the override', () => {
    const src = fs.readFileSync(
      path.resolve(HERE, '../jobs/telegramInboxScanner.ts'),
      'utf8'
    );
    expect(src).toMatch(/sweepStalledProcessing\(new Date\(\), 0\)/);
  });
});
