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
              lean: async () =>
                inboxDocs.filter(
                  (d) =>
                    d.status === q.status &&
                    (!q.updatedDate || d.updatedDate < q.updatedDate.$lt)
                )
            })
          }),
          updateOne: async (filter, update) => {
            const row = inboxDocs.find(
              (d) => String(d._id) === String(filter._id)
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
      BillTerm: { billTermFitsExpense: () => ({ fits: true }) }
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
      const row = { _id: 'item-1', ...doc };
      state.created.push(row);
      state.receipts.push({ ...doc });
      return 'item-1';
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
