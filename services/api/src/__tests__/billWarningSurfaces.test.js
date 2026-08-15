/* eslint-env node, jest */
/**
 * THE PARSER'S CROSS-CHECKS HAVE TO REACH A HUMAN — on both lanes, in their language.
 *
 * The ΕΥΔΑΠ parser runs several internal consistency checks (the six breakdown lines must
 * sum to ΜΕΡΙΚΟ ΣΥΝΟΛΟ; the tier m³ must sum to ΚΑΤΑΝΑΛΩΣΗ; the 41-digit payment string
 * must corroborate the amount and the due date; two printings of the same field must
 * agree) and emits a stable code for each disagreement. Every one of them means the same
 * thing to the landlord: THE AMOUNT ON THIS CARD MIGHT BE A MISREAD.
 *
 * They reached the Telegram lane and not the upload dialog, which is backwards — the
 * dialog is the only lane where the operator can still correct the figure before
 * confirming, so the signal was shown exactly where nothing could be done about it and
 * hidden where something could. Same absent-representation shape as a clamp: the check
 * ran, disagreed, and left no trace on the surface that mattered.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.resolve(HERE, rel), 'utf8');
const LOCALES = ['de-DE', 'el', 'en', 'es-CO', 'fr-FR', 'pt-BR'];
const dialog = read(
  '../../../../webapps/landlord/src/components/buildings/BillImportDialog.js'
);

/** Every code the parsers can emit, taken from the parser sources rather than a list. */
const emittedCodes = () => {
  const src =
    read('../managers/billparser/eydap.ts') + read('../managers/billparser/deh.ts');
  return [
    ...new Set(
      [...src.matchAll(/warnings\.push\(\s*'([a-z0-9-]+)'/g)].map((m) => m[1])
    )
  ].sort();
};

describe('the codes the parser emits and the codes a surface explains', () => {
  it('the parser emits the codes this suite thinks it does', () => {
    // Derived from source, so a NEW code added to the parser lands here as a failure
    // instead of silently becoming a warning nobody renders.
    expect(emittedCodes()).toEqual([
      'breakdown-does-not-sum-to-subtotal',
      'breakdown-exceeds-subtotal',
      'consumption-from-tiers-only',
      'payment-string-does-not-corroborate',
      'period-disagrees',
      'prior-balance-included-in-payable',
      'registry-number-disagrees',
      'subtotal-derived-from-breakdown',
      'subtotal-label-overridden-by-breakdown-sum',
      'subtotal-not-read-payable-charged',
      'tier-amounts-do-not-sum-to-charges',
      'tiers-do-not-sum-to-consumption'
    ]);
  });

  it('every code that means «the amount may be wrong» is explained on BOTH lanes', async () => {
    // CALLS the mapper instead of grepping for the code string. The grep version passed
    // with the `case` label renamed, because the same string also appears in the supersede
    // set a few lines below — a source assertion that matches ANY occurrence proves only
    // that the file mentions the code, not that a landlord is told anything.
    const { _parserWarningMessage } = await import(
      '../jobs/telegramInboxScanner.js'
    );
    const bill = { totalAmount: 289.94, chargeableAmount: 89.94 };
    // 'consumption-from-tiers-only' is excluded on purpose: it reports that the stub
    // reading was missing and the consumption came from the tier lines instead. It says
    // nothing about the AMOUNT, so surfacing it would be noise — and noise is what trains
    // an operator to dismiss the row that matters.
    const moneyRelevant = emittedCodes().filter(
      (c) => c !== 'consumption-from-tiers-only'
    );
    for (const code of moneyRelevant) {
      expect({
        code,
        telegram: typeof _parserWarningMessage(code, bill) === 'string'
      }).toEqual({ code, telegram: true });
      // The dialog renders 'prior-balance-included-in-payable' through `hasArrears`, with
      // the two actual figures, rather than through the code map.
      const inDialog =
        dialog.includes(`'${code}'`) ||
        (code === 'prior-balance-included-in-payable' &&
          dialog.includes('const hasArrears ='));
      expect({ code, dialog: inDialog }).toEqual({ code, dialog: true });
    }
  });
});

describe('the dialog’s messages exist in all six locales', () => {
  /**
   * A `t()` key missing from a locale renders the KEY — i.e. English — and the realm this
   * app actually runs in is `el`. Greek text on a Greek screen is not something to take on
   * trust: grep every key in every file.
   */
  // Taken from the byCode map itself. The first version matched a PREFIX (`'The …'`),
  // which silently skipped «This bill prints no subtotal…» — and that was the very key a
  // mutation left untranslated without failing anything. A list of things to check must be
  // derived from the thing being checked.
  const byCodeBlock = dialog.slice(
    dialog.indexOf('const byCode = {'),
    dialog.indexOf('const codes = (parsed?.warnings')
  );
  const messages = [
    ...new Set(
      [...byCodeBlock.matchAll(/^\s+'([^']{20,})',?$/gm)].map((m) => m[1])
    )
  ];

  it('the supersede rule is applied on BOTH lanes, not just one', () => {
    // The override message says «they disagreed AND the itemised sum was used», which
    // makes the plain «does not add up» row a weaker duplicate. If only one lane
    // suppressed it, the two doors would describe the same bill differently.
    const scanner = read('../jobs/telegramInboxScanner.ts');
    for (const [lane, src] of [
      ['dialog', dialog],
      ['scanner', scanner]
    ]) {
      expect({
        lane,
        supersedes: src.includes(
          "? new Set(['breakdown-does-not-sum-to-subtotal'])"
        )
      }).toEqual({ lane, supersedes: true });
    }
  });

  it('found the message strings to check', () => {
    // Without this the regex could match nothing and the loop below would assert zero
    // times — a green test proving only that it ran.
    expect(messages.length).toBeGreaterThanOrEqual(8);
  });

  for (const loc of LOCALES) {
    it(`${loc} has every one of them`, () => {
      const dict = JSON.parse(
        read(`../../../../webapps/landlord/locales/${loc}/common.json`)
      );
      const missing = messages.filter((m) => !(m in dict));
      expect({ loc, missing }).toEqual({ loc, missing: [] });
      // …and translated, not copied. `en` is the exception by definition.
      if (loc !== 'en') {
        const untranslated = messages.filter((m) => dict[m] === m);
        expect({ loc, untranslated }).toEqual({ loc, untranslated: [] });
      }
    });
  }

  it('the Greek ones are actually Greek', () => {
    // The failure mode a key-presence check cannot see: a key present with an English
    // value. `el` is the realm's locale, so this is the one that reaches the landlord.
    const dict = JSON.parse(
      read('../../../../webapps/landlord/locales/el/common.json')
    );
    for (const m of messages) {
      expect({ m, greek: /[Ͱ-Ͽἀ-῿]/.test(dict[m]) }).toEqual({
        m,
        greek: true
      });
    }
  });
});

describe('the dialog renders them where they can be acted on', () => {
  it('they gate the amber block and render inside it', () => {
    expect(dialog).toContain('parserWarnings.length > 0 ||');
    expect(dialog).toContain('parserWarnings.map((message) => (');
    // Inside the ONE consolidated block, not a new box: the amber block exists because a
    // separate alert per condition read as a pile of alarms rather than one bill.
    const blockAt = dialog.indexOf('space-y-2 rounded-md border border-amber-200');
    expect(blockAt).toBeGreaterThan(-1);
    expect(dialog.indexOf('parserWarnings.map')).toBeGreaterThan(blockAt);
  });

  it('is NOT a hook — it sits below the parse-fail early return', () => {
    /**
     * The first version used useMemo, which lint caught: the early return for a failed
     * parse is above this line, so the hook is conditional and on a batch mixing a failed
     * and a successful parse React's hook order changes between renders. The file already
     * documents this trap for `formatNumber`; I walked into it anyway.
     */
    const at = dialog.indexOf('const parserWarnings =');
    expect(at).toBeGreaterThan(-1);
    expect(dialog.slice(at, at + 60)).not.toContain('useMemo');
    expect(dialog.indexOf('if (!result.success)')).toBeLessThan(at);
  });

  it('two codes with the same sentence print it once', () => {
    // The tier pair and the disagreement pair share a message; printing it twice reads as
    // two separate problems with the bill.
    expect(dialog).toContain('...new Set(');
  });
});

describe('chargeableAmount is bounded before it can be charged', () => {
  const billmanager = read('../managers/billmanager.ts');

  it('is validated at all — it is the figure the tenants pay', () => {
    // totalAmount had a positivity guard and an upper bound from the start;
    // chargeableAmount had neither, and it is the one that reaches
    // bridgeChargeToStatement. NaN was the worst case: it propagates through the
    // allocation into monthlyCharges and every money surface renders NaN, because
    // nothing downstream compares it to anything.
    expect(billmanager).toContain('Bill chargeableAmount must be a non-negative number');
    expect(billmanager).toContain('Bill chargeableAmount is implausibly large');
    const at = billmanager.indexOf('const _ca = Number(chargeableAmount);');
    expect(at).toBeGreaterThan(-1);
    const block = billmanager.slice(at, at + 400);
    expect(block).toContain('!Number.isFinite(_ca)');
    expect(block).toContain('_ca < 0');
    expect(block).toContain('1_000_000');
  });

  it('allows ZERO, and does not cap against totalAmount', () => {
    const at = billmanager.indexOf('const _ca = Number(chargeableAmount);');
    const block = billmanager.slice(at, at + 400);
    // `_ca <= 0.005` would reject a real nil-charge period and force the operator to
    // invent a figure; `_ca > _ta` would silently under-charge the tenants in the CREDIT
    // case, where the landlord owes less than this period cost because an earlier
    // overpayment absorbed part of it.
    expect(block).not.toContain('_ca <= 0.005');
    expect(block).not.toMatch(/_ca\s*>\s*_ta/);
  });

  it('runs BEFORE the value is persisted or charged', () => {
    const guard = billmanager.indexOf('Bill chargeableAmount must be a non-negative');
    const persist = billmanager.indexOf('chargeableAmount:\n            chargeableAmount');
    expect(guard).toBeGreaterThan(-1);
    expect(persist).toBeGreaterThan(guard);
  });
});

describe('a message that says the figure was SUBSTITUTED must name the figure', () => {
  /**
   * FOUND ON THE RENDERED GREEK CARD, after the phantom-arrears row was correctly removed.
   *
   * The card then read «το τυπωμένο μερικό σύνολο διαφωνεί … χρησιμοποιήθηκε το άθροισμα
   * των γραμμών» and 89,94 appeared NOWHERE on it — the arrears row had been the only
   * place stating what the tenants are charged. So the landlord was told a substitution had
   * happened and left unable to see WHAT was substituted: the fact present, the number
   * absent. Removing a false row exposed a missing one.
   */
  const SUBSTITUTION_CODES = [
    'subtotal-label-overridden-by-breakdown-sum',
    'subtotal-derived-from-breakdown'
  ];

  it('the dialog messages carry the placeholder and the dialog fills it', () => {
    for (const code of SUBSTITUTION_CODES) {
      const at = dialog.indexOf(`'${code}':`);
      expect({ code, found: at > -1 }).toEqual({ code, found: true });
      const msg = dialog.slice(at, dialog.indexOf('\n', dialog.indexOf("',", at)));
      expect({ code, namesFigure: msg.includes('{{current}}') }).toEqual({
        code,
        namesFigure: true
      });
    }
    // …and the value is actually supplied, or next-translate renders the raw «{{current}}».
    expect(dialog).toContain(
      'current: formatNumber(Number(parsed?.chargeableAmount))'
    );
  });

  it('every locale keeps the placeholder — dropping it prints a sentence with a hole', () => {
    const messages = SUBSTITUTION_CODES.map((code) => {
      const at = dialog.indexOf(`'${code}':`);
      const m = dialog.slice(at).match(/'([^']*\{\{current\}\}[^']*)'/);
      return m[1];
    });
    for (const loc of LOCALES) {
      const dict = JSON.parse(
        read(`../../../../webapps/landlord/locales/${loc}/common.json`)
      );
      for (const msg of messages) {
        expect({ loc, msg: msg.slice(0, 30), ok: (dict[msg] || '').includes('{{current}}') }).toEqual(
          { loc, msg: msg.slice(0, 30), ok: true }
        );
      }
    }
  });

  it('the Telegram lane names it too — there the amount is read-only', async () => {
    const { _parserWarningMessage } = await import(
      '../jobs/telegramInboxScanner.js'
    );
    const bill = { totalAmount: 109.94, chargeableAmount: 89.94 };
    for (const code of SUBSTITUTION_CODES) {
      const msg = _parserWarningMessage(code, bill);
      expect({ code, namesFigure: /89[.,]94/.test(msg) }).toEqual({
        code,
        namesFigure: true
      });
    }
  });

  it('the prior-balance message states the REPORTED balance', async () => {
    const { _parserWarningMessage } = await import(
      '../jobs/telegramInboxScanner.js'
    );
    // A real balance alongside an override: the document says 200,00 and subtracting the
    // two amounts says 220,00. The message must say what the document says.
    const msg = _parserWarningMessage('prior-balance-included-in-payable', {
      totalAmount: 289.94,
      chargeableAmount: 69.94,
      priorBalance: 200
    });
    expect(msg).toContain('200.00');
    expect(msg).not.toContain('220.00');
  });
});
