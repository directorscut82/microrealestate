// nanoid@5 is ESM-ONLY. `occupantmanager.ts` imports { customAlphabet } from it,
// so every suite that touches the tenant path died with
// "SyntaxError: Cannot use import statement outside a module" — 194 tests across
// 23 suites, i.e. the whole tenant/repair/owner surface. Same class as the
// winston / express-winston / jsonwebtoken mocks beside this file: author the mock
// as .cjs (always CommonJS regardless of the package's `type: module`) and
// redirect the bare specifier in jest.config.js so the real ESM build never loads.
//
// The mock must behave like the real thing for the ONE use site: customAlphabet
// returns a generator that yields a string of `size` chars from `alphabet`. Tests
// that assert on a tenant `reference` need it deterministic-shaped (right length,
// right alphabet), not random — so count deterministically per generator.
function customAlphabet(alphabet, size = 21) {
  let counter = 0;
  return (overrideSize) => {
    const n = Number(overrideSize) || size;
    const chars = String(alphabet || '0123456789');
    counter += 1;
    let out = '';
    // Deterministic sweep over the alphabet, seeded by the call counter, so two
    // calls never collide (a duplicate `reference` would violate a real uniqueness
    // expectation) while staying stable across runs.
    for (let i = 0; i < n; i++) {
      out += chars[(counter * 31 + i * 7) % chars.length];
    }
    return out;
  };
}

const nanoid = (size = 21) =>
  customAlphabet('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_', size)();

module.exports = { customAlphabet, nanoid, urlAlphabet: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_' };
