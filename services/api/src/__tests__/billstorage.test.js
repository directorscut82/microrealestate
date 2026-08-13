/* eslint-env node, jest */
// billstorage — B2 archival helpers (Slice 5). Tests the pure pieces
// (isEnabled gate + realm-scoped key convention). The AWS putObject wrapper is
// exercised through the poller/confirm integration paths with a mocked hook.
import { jest } from '@jest/globals';

// crypto.decrypt is only reached by _initS3 (not by isEnabled/billObjectKey),
// so a light mock keeps this suite free of the real cipher env.
jest.unstable_mockModule('@microrealestate/common', () => ({
  Crypto: { decrypt: (v) => `dec(${v})` },
      // billmanager + telegramInboxScanner now take the charge month and the
      // bill-term fit from the shared rule, so this factory must provide it.
      // unstable_mockModule replaces the WHOLE module: an export the graph consumes
      // but the factory omits is `undefined` at call time, which surfaces as a
      // TypeError deep inside rather than a resolution error.
      BillTerm: {
        billTermFitsExpense: () => ({ fits: true }),
        billTermIsOutsideExpense: () => false,
        computeChargeTerm: (b) => {
          const d = new Date(b?.issueDate || b?.periodEnd);
          return Number.isFinite(d.getTime())
            ? d.getUTCFullYear() * 1000000 + (d.getUTCMonth() + 1) * 10000 + 100
            : undefined;
        }
      },
  logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
}));

const { isEnabled, billObjectKey } = await import('../managers/billstorage.js');

describe('billstorage.isEnabled', () => {
  const full = {
    keyId: 'k',
    applicationKey: 'a',
    endpoint: 'e',
    bucket: 'b'
  };
  it('true when all four fields present', () => {
    expect(isEnabled(full)).toBe(true);
  });
  it('false when any field missing', () => {
    for (const f of ['keyId', 'applicationKey', 'endpoint', 'bucket']) {
      expect(isEnabled({ ...full, [f]: '' })).toBe(false);
    }
  });
  it('false for undefined/null', () => {
    expect(isEnabled(undefined)).toBe(false);
    expect(isEnabled(null)).toBe(false);
  });
});

describe('billstorage.billObjectKey', () => {
  it('produces a key under the realm prefix the by-key download route enforces', () => {
    const key = billObjectKey(
      'Landlord',
      '6a00d7ce323739077de89e58',
      'billid1',
      'iris-qr.png'
    );
    // documents.ts by-key route: `${sanitize(realm.name)}-${sanitize(realm._id)}/`
    expect(key).toBe(
      'Landlord-6a00d7ce323739077de89e58/bills/billid1/iris-qr.png'
    );
    expect(key.startsWith('Landlord-6a00d7ce323739077de89e58/')).toBe(true);
  });

  it('sanitizes each segment (no path traversal / separators leak through)', () => {
    const key = billObjectKey('a/b', 'r../x', 'id/../y', 'e vil.pdf');
    // sanitize-filename strips slashes/dots-traversal from each segment
    expect(key).not.toMatch(/\.\.\//);
    expect(key).not.toContain('a/b'); // realm name slash removed
    // structure preserved: prefix / bills / id / file
    expect(key.split('/').filter(Boolean).length).toBeGreaterThanOrEqual(4);
    expect(key).toContain('/bills/');
  });
});
