/* eslint-env node, jest */
// Telegram inbox poller (Slice 4) — offset advance + routing logic, driven
// entirely through the dependency-injection hooks (same pattern as
// leaseExpiryScanner.test.js): no network, no mongo, no WASM.
import {
  _awaitParseQueue,
  scanTelegramInbox,
  _clearRetries
} from '../jobs/telegramInboxScanner.js';

const FIXED_NOW = new Date('2026-07-25T12:00:00.000Z');

const REALM = {
  realmId: 'realm-1',
  realmName: 'Landlord',
  botToken: 'TESTTOKEN',
  adminChatId: '111'
};

function photoMsg(updateId, messageId, chatId = 111) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      chat: { id: chatId },
      photo: [
        { file_id: `small-${messageId}` },
        { file_id: `big-${messageId}` }
      ]
    }
  };
}

function textMsg(updateId, messageId, chatId = 111) {
  return {
    update_id: updateId,
    message: { message_id: messageId, chat: { id: chatId } }
  };
}

function makeDeps({
  updates = [],
  initialOffset = 0,
  parseResult,
  downloadResult,
  hasItem = false,
  matchResult = null
} = {}) {
  const state = {
    offsets: { [REALM.realmId]: initialOffset },
    setOffsetCalls: [],
    getUpdatesCalls: [],
    created: [],
    replies: [],
    updates: [],
    edits: [],
    rows: {},
    receipts: [],
    downloads: [],
    archives: []
  };
  const deps = {
    now: () => FIXED_NOW,
    findTelegramRealms: async () => [REALM],
    getOffset: async (realmId) => state.offsets[realmId] || 0,
    setOffset: async (realmId, lastUpdateId) => {
      state.offsets[realmId] = lastUpdateId;
      state.setOffsetCalls.push({ realmId, lastUpdateId });
    },
    getUpdates: async (botToken, offset) => {
      state.getUpdatesCalls.push({ botToken, offset });
      return updates;
    },
    downloadFile: async (botToken, fileId) => {
      state.downloads.push(fileId);
      return downloadResult !== undefined
        ? downloadResult
        : { buffer: Buffer.from('fake-image'), fileName: 'bill.jpg' };
    },
    parseBill: async () =>
      parseResult !== undefined
        ? parseResult
        : {
            success: true,
            bill: {
              provider: 'deh',
              billingId: '9 99935585-03 2',
              billingIdNormalized: '999935585032',
              totalAmount: 186.21,
              periodStart: new Date('2026-02-25'),
              periodEnd: new Date('2026-03-23'),
              rfCode: 'RF33999000000000000000001'
            }
          },
    findMatch: async () => matchResult,
    hasInboxItem: async () => hasItem,
    // TWO-PHASE now. The tick creates a 'processing' row and returns its id; the
    // background parse updates that row. The stub models both so a test can assert the
    // state the LANDLORD ends up seeing, not just the first write.
    createInboxItem: async (doc) => {
      const id = `item-${state.created.length + 1}`;
      // `created` is the LIVE row: the background parse updates it, so assertions about
      // the finished item read naturally. `receipts` is an immutable snapshot of what
      // RECEIPT wrote — needed because the parse mutates the live row, which would
      // otherwise make «status was 'processing' when it arrived» untestable.
      const row = { _id: id, ...doc };
      state.created.push(row);
      state.rows[id] = row;
      state.receipts.push({ ...doc });
      return id;
    },
    updateInboxItem: async (id, patch) => {
      state.updates.push({ id, patch });
      if (state.rows[id]) Object.assign(state.rows[id], patch);
    },
    editReply: async (botToken, chatId, messageId, text) => {
      state.edits.push({ messageId, text });
    },
    archiveSource: async (realm, billLikeId, fileName, buffer) => {
      state.archives.push({ billLikeId, fileName, bytes: buffer?.length });
      // default: pretend B2 is on and returns a key
      return `${realm.realmName}-${realm.realmId}/bills/${billLikeId}/${fileName}`;
    },
    // Tier-2: default OFF (returns false → normal ingest). Tests that exercise
    // recapture override this.
    tryRecapture: async () => false,
    sendReply: async (_botToken, chatId, text) => {
      state.replies.push({ chatId, text });
      // Return an id: the ack's id is what the parse edits into the result.
      return 5000 + state.replies.length;
    }
  };
  return { deps, state };
}

describe('telegramInboxScanner — scanTelegramInbox', () => {
  beforeEach(() => {
    _clearRetries(); // poison-retry counters are module-level; reset per case
  });

  it('polls from lastUpdateId+1', async () => {
    const { deps, state } = makeDeps({ initialOffset: 41, updates: [] });
    await scanTelegramInbox(deps);
    await _awaitParseQueue();
    expect(state.getUpdatesCalls).toEqual([
      { botToken: 'TESTTOKEN', offset: 42 }
    ]);
  });

  it('ingests a photo message from the admin chat and advances the offset', async () => {
    const { deps, state } = makeDeps({ updates: [photoMsg(42, 1001)] });
    const r = await scanTelegramInbox(deps);
    // The parse is fire-and-forget now, so wait for it before asserting what it wrote.
    await _awaitParseQueue();
    expect(r.ingested).toBe(1);
    expect(state.created).toHaveLength(1);
    const item = state.created[0];
    expect(item.realmId).toBe('realm-1');
    expect(item.source).toBe('telegram');
    // TWO PHASES, both asserted. At RECEIPT the row is 'processing' so the bell has
    // something to show before a 50s parse finishes; once the parse lands it becomes
    // 'pending' and confirmable. Before this protocol the row appeared only after OCR, so
    // the landlord could not tell «not received» from «still working».
    expect(state.receipts[0].status).toBe('processing');
    expect(item.status).toBe('pending');
    expect(item.telegramMessageId).toBe(1001);
    expect(item.parsed.billingIdNormalized).toBe('999935585032');
    expect(item.parsed.totalAmount).toBe(186.21);
    // proposedTerm derived from periodEnd (2026-03) → 2026030100
    expect(item.parsed.proposedTerm).toBe(2026030100);
    expect(state.offsets['realm-1']).toBe(42);
  });

  it('downloads the LARGEST photo rendition (last array entry)', async () => {
    const { deps, state } = makeDeps({ updates: [photoMsg(42, 1001)] });
    await scanTelegramInbox(deps);
    await _awaitParseQueue();
    expect(state.downloads).toEqual(['big-1001']);
  });

  it('ignores messages from chats other than adminChatId (no reply, no item)', async () => {
    const { deps, state } = makeDeps({
      updates: [photoMsg(42, 1001, 999)]
    });
    const r = await scanTelegramInbox(deps);
    // The parse is fire-and-forget now, so wait for it before asserting what it wrote.
    await _awaitParseQueue();
    expect(r.ingested).toBe(0);
    expect(r.skipped).toBe(1);
    expect(state.created).toHaveLength(0);
    expect(state.replies).toHaveLength(0);
    // offset STILL advances past the foreign message
    expect(state.offsets['realm-1']).toBe(42);
  });

  it('skips text-only messages but advances the offset', async () => {
    const { deps, state } = makeDeps({ updates: [textMsg(42, 1001)] });
    const r = await scanTelegramInbox(deps);
    // The parse is fire-and-forget now, so wait for it before asserting what it wrote.
    await _awaitParseQueue();
    expect(r.skipped).toBe(1);
    expect(state.created).toHaveLength(0);
    expect(state.offsets['realm-1']).toBe(42);
  });

  it('a parse FAILURE still creates an InboxItem carrying parseError', async () => {
    const { deps, state } = makeDeps({
      updates: [photoMsg(42, 1001)],
      parseResult: { success: false, error: 'Δεν αναγνωρίστηκε ο πάροχος' }
    });
    const r = await scanTelegramInbox(deps);
    // The parse is fire-and-forget now, so wait for it before asserting what it wrote.
    await _awaitParseQueue();
    expect(r.ingested).toBe(1);
    expect(state.created[0].parseError).toBe('Δεν αναγνωρίστηκε ο πάροχος');
    // TWO MESSAGES' WORTH OF INFORMATION, ONE MESSAGE ON SCREEN. reply[0] is the ack sent
    // at receipt; the outcome arrives as an EDIT of that same message, so the landlord is
    // not left with an ack above a result and no clue which is current.
    expect(state.replies[0].text).toContain('Ελήφθη');
    expect(state.edits).toHaveLength(1);
    expect(state.edits[0].messageId).toBe(5001); // the ack's own id
    expect(state.edits[0].text).toContain('δεν διαβάστηκε');
  });

  it('a parse THROW is contained: item created with parseError, no crash', async () => {
    const { deps, state } = makeDeps({ updates: [photoMsg(42, 1001)] });
    deps.parseBill = async () => {
      throw new Error('Image too large to OCR');
    };
    const r = await scanTelegramInbox(deps);
    // The parse is fire-and-forget now, so wait for it before asserting what it wrote.
    await _awaitParseQueue();
    expect(r.ingested).toBe(1);
    expect(state.created[0].parseError).toBe('Image too large to OCR');
  });

  it('dedups on telegramMessageId (already-ingested message is skipped)', async () => {
    const { deps, state } = makeDeps({
      updates: [photoMsg(42, 1001)],
      hasItem: true
    });
    const r = await scanTelegramInbox(deps);
    // The parse is fire-and-forget now, so wait for it before asserting what it wrote.
    await _awaitParseQueue();
    expect(r.skipped).toBe(1);
    expect(state.created).toHaveLength(0);
    expect(state.offsets['realm-1']).toBe(42);
  });

  it('a refused download (too big) replies with guidance and advances offset', async () => {
    const { deps, state } = makeDeps({
      updates: [photoMsg(42, 1001)],
      downloadResult: null
    });
    const r = await scanTelegramInbox(deps);
    // The parse is fire-and-forget now, so wait for it before asserting what it wrote.
    await _awaitParseQueue();
    expect(r.skipped).toBe(1);
    expect(state.created).toHaveLength(0);
    expect(state.replies[0].text).toContain('6MB');
    expect(state.offsets['realm-1']).toBe(42);
  });

  it('a transient failure HOLDS the offset (retry next tick — bill not lost)', async () => {
    // update 1001 fails, 1002 would succeed. Contiguous-prefix commit: we stop
    // at the first failure and do NOT advance, so BOTH replay next tick. This
    // is the fix for the offset-advance-before-handle bug: a mongo blip must
    // never silently drop a bill.
    const { deps, state } = makeDeps({
      updates: [photoMsg(42, 1001), photoMsg(43, 1002)]
    });
    let call = 0;
    deps.createInboxItem = async (doc) => {
      call++;
      if (call === 1) throw new Error('mongo down');
      state.created.push(doc);
    };
    const r = await scanTelegramInbox(deps);
    // The parse is fire-and-forget now, so wait for it before asserting what it wrote.
    await _awaitParseQueue();
    expect(r.errors).toBe(1);
    expect(r.ingested).toBe(0); // 1002 not reached (we stopped at 1001)
    expect(state.setOffsetCalls).toHaveLength(0); // offset UNCHANGED → retry
    expect(state.offsets['realm-1']).toBe(0);
  });

  it('advances the offset for updates BEFORE the failing one (partial commit)', async () => {
    // 1001 succeeds, 1002 fails → commit through 1001 only; 1002+ retry.
    const { deps, state } = makeDeps({
      updates: [photoMsg(42, 1001), photoMsg(43, 1002)]
    });
    let call = 0;
    deps.createInboxItem = async (doc) => {
      call++;
      if (call === 2) throw new Error('mongo down');
      state.created.push(doc);
    };
    const r = await scanTelegramInbox(deps);
    // The parse is fire-and-forget now, so wait for it before asserting what it wrote.
    await _awaitParseQueue();
    expect(r.ingested).toBe(1); // 1001 made it
    expect(r.errors).toBe(1); // 1002 failed
    expect(state.offsets['realm-1']).toBe(42); // committed through 1001 only
  });

  it('a POISON update is skipped after the retry budget, recording a placeholder (queue not wedged)', async () => {
    // A genuinely poison update: HANDLING fails on every tick (here the file
    // download throws) but mongo is healthy so the placeholder write succeeds.
    // After MAX_UPDATE_RETRIES (5) the poller records a VISIBLE placeholder
    // InboxItem and advances past it — the landlord sees "a message arrived
    // that couldn't be processed" rather than silence, and the queue isn't
    // wedged forever (ingress+error-path audit 2026-07).
    let last = 0;
    let lastState;
    for (let tick = 1; tick <= 5; tick++) {
      const { deps, state } = makeDeps({
        updates: [photoMsg(42, 1001)],
        initialOffset: last
      });
      // Handling fails (download throws) — NOT the mongo write.
      deps.downloadFile = async () => {
        throw new Error('permanently bad file');
      };
      // eslint-disable-next-line no-await-in-loop
      const r = await scanTelegramInbox(deps);
    // The parse is fire-and-forget now, so wait for it before asserting what it wrote.
    await _awaitParseQueue();
      expect(r.errors).toBe(1);
      if (tick < 5) {
        expect(state.setOffsetCalls).toHaveLength(0); // held for retry
        expect(state.created).toHaveLength(0); // no placeholder yet
      } else {
        expect(state.offsets['realm-1']).toBe(42); // 5th → skipped past
        last = state.offsets['realm-1'];
        lastState = state;
      }
    }
    // The skip recorded a visible placeholder with a parseError, keyed to the
    // message so the dedup index still holds.
    expect(lastState.created).toHaveLength(1);
    expect(lastState.created[0].telegramMessageId).toBe(1001);
    expect(lastState.created[0].parseError).toBeTruthy();
    expect(lastState.created[0].status).toBe('pending');
  });

  it('a persistently-failing mongo write is TRANSIENT — offset never advances (bill preserved)', async () => {
    // If the mongo write itself keeps failing, that is infra-down (transient),
    // NOT a poison message. Advancing the offset would permanently drop the
    // bill after only ~5min of outage. So even past the retry budget the poller
    // must hold the offset and keep retrying (ingress+error-path audit 2026-07).
    for (let tick = 1; tick <= 7; tick++) {
      const { deps, state } = makeDeps({
        updates: [photoMsg(42, 1001)],
        initialOffset: 0
      });
      // BOTH the ingest write and the placeholder write fail → mongo is down.
      deps.createInboxItem = async () => {
        throw new Error('mongo down');
      };
      // eslint-disable-next-line no-await-in-loop
      const r = await scanTelegramInbox(deps);
    // The parse is fire-and-forget now, so wait for it before asserting what it wrote.
    await _awaitParseQueue();
      expect(r.errors).toBe(1);
      expect(state.setOffsetCalls).toHaveLength(0); // never advances
      expect(state.offsets['realm-1']).toBe(0); // bill preserved for next tick
    }
  });

  it('a realm-level getUpdates failure does NOT advance the offset (retry next tick)', async () => {
    const { deps, state } = makeDeps({ initialOffset: 41 });
    deps.getUpdates = async () => {
      throw new Error('network');
    };
    const r = await scanTelegramInbox(deps);
    // The parse is fire-and-forget now, so wait for it before asserting what it wrote.
    await _awaitParseQueue();
    expect(r.errors).toBe(1);
    expect(state.setOffsetCalls).toHaveLength(0);
    expect(state.offsets['realm-1']).toBe(41);
  });

  it('attaches suggestedMatch when a building expense matches the billingId', async () => {
    const match = {
      buildingId: 'b1',
      buildingName: 'ΟΔΟΣ ΗΤΑ 24',
      expenseId: 'e1',
      expenseName: 'ΔΕΗ κοινοχρήστων'
    };
    const { deps, state } = makeDeps({
      updates: [photoMsg(42, 1001)],
      matchResult: match
    });
    await scanTelegramInbox(deps);
    await _awaitParseQueue();
    expect(state.created[0].suggestedMatch).toEqual(match);
  });

  it('empty poll: no offset write, no items', async () => {
    const { deps, state } = makeDeps({ updates: [], initialOffset: 7 });
    const r = await scanTelegramInbox(deps);
    // The parse is fire-and-forget now, so wait for it before asserting what it wrote.
    await _awaitParseQueue();
    expect(r.updates).toBe(0);
    expect(state.setOffsetCalls).toHaveLength(0);
    expect(state.offsets['realm-1']).toBe(7);
  });

  // ── Slice 5: B2 source archival at ingest ──────────────────────────────
  it('archives the source buffer at ingest and stores the key on sourcePdfUrl', async () => {
    const { deps, state } = makeDeps({ updates: [photoMsg(42, 1001)] });
    await scanTelegramInbox(deps);
    await _awaitParseQueue();
    expect(state.archives).toHaveLength(1);
    expect(state.archives[0].billLikeId).toBe('tg-1001');
    expect(state.archives[0].bytes).toBeGreaterThan(0);
    expect(state.created[0].sourcePdfUrl).toBe(
      'Landlord-realm-1/bills/tg-1001/photo-1001.jpg'
    );
  });

  it('an archive failure (returns null) still ingests — sourcePdfUrl undefined', async () => {
    const { deps, state } = makeDeps({ updates: [photoMsg(42, 1001)] });
    deps.archiveSource = async () => null; // B2 off or upload failed
    const r = await scanTelegramInbox(deps);
    // The parse is fire-and-forget now, so wait for it before asserting what it wrote.
    await _awaitParseQueue();
    expect(r.ingested).toBe(1);
    expect(state.created[0].sourcePdfUrl).toBeUndefined();
  });

  it('does not archive when there is no file (text-only message)', async () => {
    const { deps, state } = makeDeps({ updates: [textMsg(42, 1001)] });
    await scanTelegramInbox(deps);
    await _awaitParseQueue();
    expect(state.archives).toHaveLength(0);
  });

  // ── Tier-2: an admin-chat photo is consumed by an active recapture session
  // instead of being ingested as a new bill.
  it('recapture RECOVERED: no InboxItem, offset advances, success ack', async () => {
    const { deps, state } = makeDeps({ updates: [photoMsg(42, 1001)] });
    let recaptureCalls = 0;
    deps.tryRecapture = async (_realm, buffer) => {
      recaptureCalls++;
      expect(buffer.length).toBeGreaterThan(0);
      return 'recovered'; // consumed + a valid key was read
    };
    await scanTelegramInbox(deps);
    await _awaitParseQueue();
    expect(recaptureCalls).toBe(1);
    expect(state.created).toHaveLength(0); // NOT ingested as a bill
    expect(state.archives).toHaveLength(0); // not archived either
    expect(state.offsets['realm-1']).toBe(42); // consumed → offset advances
    // sender gets the "code updated" ack
    expect(state.replies.some((x) => /ενημερώθηκε/.test(x.text))).toBe(true);
  });

  it('recapture FAILED (re-shot unreadable): consumed, but ACCURATE reply — no false success', async () => {
    const { deps, state } = makeDeps({ updates: [photoMsg(42, 1001)] });
    deps.tryRecapture = async () => 'failed'; // it WAS the re-shot, but no valid key
    await scanTelegramInbox(deps);
    await _awaitParseQueue();
    expect(state.created).toHaveLength(0); // still not ingested as a bill
    expect(state.offsets['realm-1']).toBe(42); // consumed → offset advances
    // must NOT claim the code was updated…
    expect(state.replies.some((x) => /ενημερώθηκε/.test(x.text))).toBe(false);
    // …and must tell the user it wasn't legible
    expect(state.replies.some((x) => /δεν διαβάστηκε καθαρά/.test(x.text))).toBe(
      true
    );
  });

  it('recapture OFF (returns false) → normal ingest still happens', async () => {
    const { deps, state } = makeDeps({ updates: [photoMsg(42, 1001)] });
    deps.tryRecapture = async () => false;
    const r = await scanTelegramInbox(deps);
    // The parse is fire-and-forget now, so wait for it before asserting what it wrote.
    await _awaitParseQueue();
    expect(r.ingested).toBe(1);
    expect(state.created).toHaveLength(1);
  });
});
