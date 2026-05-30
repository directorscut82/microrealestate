/**
 * Wave-26 round-3r: backfill `payment.allocation` on every existing
 * payment in mongo across all realms.
 *
 * Mirrors the auto-spread rule used by rentmanager.ts (oldest-debt-first):
 *   previousBalance -> rent -> expenses -> repairs -> vat -> extracharge
 *
 * Idempotent: payments that already carry an allocation array are
 * skipped. Safe to re-run.
 *
 * Run via:
 *   curl -sk -X POST "http://192.168.0.96:9000/api/endpoints/3/docker/containers/<mongo-cid>/exec" \
 *     -H "X-API-Key: $PTOKEN" -H "Content-Type: application/json" \
 *     -d '{"AttachStdout":true,"AttachStderr":true,"Cmd":["mongo","mongodb://localhost:27017/mredb","--quiet","--eval","load(\"/tmp/migrate.js\")"]}'
 *
 * For local dev:
 *   finch exec mre-mongo-1 mongo mredb --quiet --eval "$(cat scripts/migrate-payment-allocation.js)"
 */

(function () {
  'use strict';

  const AUTO_SPREAD_ORDER = [
    'previousBalance',
    'rent',
    'expenses',
    'repairs',
    'vat',
    'extracharge'
  ];

  function _round(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
  }

  function _sumAmounts(arr) {
    if (!Array.isArray(arr)) return 0;
    return arr.reduce(function (s, x) {
      return s + (Number(x && x.amount) || 0);
    }, 0);
  }

  function _computeOwedByCategory(rent) {
    const buildings = Array.isArray(rent && rent.buildingCharges)
      ? rent.buildingCharges
      : [];
    const repair = buildings
      .filter(function (c) { return c && c.type === 'repair'; })
      .reduce(function (s, c) { return s + (Number(c.amount) || 0); }, 0);
    const expenseBuildings = buildings
      .filter(function (c) { return c && c.type !== 'repair'; })
      .reduce(function (s, c) { return s + (Number(c.amount) || 0); }, 0);
    return {
      rent: _round((rent && rent.total && Number(rent.total.preTaxAmount)) || 0),
      expenses: _round(_sumAmounts(rent && rent.charges) + expenseBuildings),
      repairs: _round(repair),
      vat: _round(
        (rent && rent.total && Number(rent.total.vat)) ||
          _sumAmounts(rent && rent.vats)
      ),
      previousBalance: _round(
        Math.max(0, (rent && rent.total && Number(rent.total.balance)) || 0)
      ),
      extracharge: _round(_sumAmounts(rent && rent.debts))
    };
  }

  function _computeAutoSpread(amount, owed) {
    let remaining = _round(amount);
    const out = [];
    for (let i = 0; i < AUTO_SPREAD_ORDER.length; i++) {
      const cat = AUTO_SPREAD_ORDER[i];
      if (remaining <= 0) break;
      const due = Number(owed[cat]) || 0;
      if (due <= 0) continue;
      const apply = _round(Math.min(remaining, due));
      if (apply > 0) {
        out.push({ category: cat, amount: apply });
        remaining = _round(remaining - apply);
      }
    }
    return out;
  }

  let tenantsProcessed = 0;
  let paymentsUpdated = 0;
  let paymentsAlreadyAllocated = 0;

  db.occupants.find({}).forEach(function (tenant) {
    if (!Array.isArray(tenant.rents) || tenant.rents.length === 0) {
      return;
    }
    let mutated = false;

    tenant.rents.forEach(function (rent) {
      if (!Array.isArray(rent.payments) || rent.payments.length === 0) {
        return;
      }

      // Decrement runningOwed as each payment lands so a 2nd payment in
      // the same rent doesn't double-fill the same buckets.
      const runningOwed = _computeOwedByCategory(rent);

      rent.payments.forEach(function (payment) {
        if (
          Array.isArray(payment.allocation) &&
          payment.allocation.length > 0
        ) {
          // Already allocated. Still decrement runningOwed using the
          // existing allocation so subsequent payments without one see
          // the right remaining bucket.
          payment.allocation.forEach(function (entry) {
            const k = entry && entry.category;
            const a = Number(entry && entry.amount) || 0;
            if (k && runningOwed[k] != null) {
              runningOwed[k] = _round(Math.max(0, runningOwed[k] - a));
            }
          });
          paymentsAlreadyAllocated++;
          return;
        }
        const amt = Number(payment.amount) || 0;
        if (amt < 0.01) {
          return;
        }
        const alloc = _computeAutoSpread(amt, runningOwed);
        payment.allocation = alloc;
        alloc.forEach(function (entry) {
          if (runningOwed[entry.category] != null) {
            runningOwed[entry.category] = _round(
              Math.max(0, runningOwed[entry.category] - entry.amount)
            );
          }
        });
        paymentsUpdated++;
        mutated = true;
      });
    });

    if (mutated) {
      db.occupants.updateOne(
        { _id: tenant._id },
        { $set: { rents: tenant.rents } }
      );
      tenantsProcessed++;
    }
  });

  print(
    JSON.stringify({
      tenantsProcessed: tenantsProcessed,
      paymentsUpdated: paymentsUpdated,
      paymentsAlreadyAllocated: paymentsAlreadyAllocated
    })
  );
})();
