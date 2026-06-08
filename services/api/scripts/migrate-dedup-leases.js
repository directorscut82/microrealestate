/**
 * T3 — One-off cleanup: collapse 6 byte-identical "Μίσθωση 24 μηνών"
 * lease docs in realm 6a00d7ce323739077de89e58 down to 1.
 *
 * Background: the 6 leases were created by AADE imports BEFORE the
 * dedup guard at services/api/src/managers/leasemanager.ts:64-72.
 * Each is identical (numberOfTerms:24, timeRange:'months', active:true,
 * no description), each bound to one tenant.
 *
 * Plan:
 *   - Canonical lease = lowest _id timestamp in the duplicate set.
 *   - Re-point the 5 other tenants' `leaseId` to canonical (using
 *     find().forEach() + save() so dirty-write rules from V_T2.7 hold).
 *   - Delete the 5 duplicate lease docs.
 *
 * Run via Portainer docker exec against mre-mongo-1 on NAS:
 *   PT=$(cat .secrets/portainer-token)
 *   MCID=$(curl -s "http://192.168.0.96:9000/api/endpoints/3/docker/containers/json?all=true" \
 *     -H "X-API-Key: $PT" | jq -r '.[] | select(.Names[0] | test("mongo")) | .Id[0:12]')
 *   SCRIPT=$(cat services/api/scripts/migrate-dedup-leases.js)
 *   EID=$(curl -s -X POST "http://192.168.0.96:9000/api/endpoints/3/docker/containers/$MCID/exec" \
 *     -H "X-API-Key: $PT" -H 'Content-Type: application/json' \
 *     -d "$(jq -n --arg s "$SCRIPT" '{AttachStdout:true,AttachStderr:true,Tty:false,Cmd:["mongo","mongodb://localhost:27017/mredb","--quiet","--eval",$s]}')" \
 *     | jq -r .Id)
 *   curl -s -X POST "http://192.168.0.96:9000/api/endpoints/3/docker/exec/$EID/start" \
 *     -H "X-API-Key: $PT" -H 'Content-Type: application/json' -d '{"Detach":false,"Tty":false}'
 *
 * Idempotent: re-running after success is a no-op (the 5 dupes are gone
 * and the 5 tenants already point at the canonical).
 */

(function () {
  'use strict';

  var REALM_ID = '6a00d7ce323739077de89e58';
  var CANONICAL = '6a133170db0cd6aa8660a5fe';
  var DUPLICATES = [
    '6a133171db0cd6aa8660a630',
    '6a133172db0cd6aa8660a6fe',
    '6a133172db0cd6aa8660a732',
    '6a133173db0cd6aa8660a7ae',
    '6a133174db0cd6aa8660a82a'
  ];

  // Sanity: canonical must exist and match the expected fingerprint.
  var canonical = db.leases.findOne({ _id: ObjectId(CANONICAL) });
  if (!canonical) {
    print(JSON.stringify({ error: 'canonical lease missing', id: CANONICAL }));
    return;
  }
  if (
    String(canonical.realmId) !== REALM_ID ||
    canonical.numberOfTerms !== 24 ||
    canonical.timeRange !== 'months' ||
    canonical.name !== 'Μίσθωση 24 μηνών'
  ) {
    print(JSON.stringify({
      error: 'canonical fingerprint mismatch',
      id: CANONICAL,
      realmId: canonical.realmId,
      numberOfTerms: canonical.numberOfTerms,
      timeRange: canonical.timeRange,
      name: canonical.name
    }));
    return;
  }

  var tenantsRepointed = 0;
  var tenantsAlreadyOk = 0;
  var leasesDeleted = 0;
  var leasesNotFound = 0;

  // 1. Re-point tenants. Each duplicate is bound to at most 1 tenant in
  //    this realm, but loop defensively in case more accumulated.
  DUPLICATES.forEach(function (dupId) {
    db.occupants
      .find({ realmId: REALM_ID, leaseId: dupId })
      .forEach(function (t) {
        t.leaseId = CANONICAL;
        db.occupants.save(t);
        tenantsRepointed++;
      });
    // Belt-and-braces: also catch any tenants whose leaseId was stored
    // as ObjectId (the realm has string leaseId today, but a future
    // import path might write ObjectId).
    db.occupants
      .find({ realmId: REALM_ID, leaseId: ObjectId(dupId) })
      .forEach(function (t) {
        t.leaseId = CANONICAL;
        db.occupants.save(t);
        tenantsRepointed++;
      });
  });

  // 2. Verify nothing still references the dupes before deleting.
  var stillReferenced = [];
  DUPLICATES.forEach(function (dupId) {
    var n =
      db.occupants.find({ realmId: REALM_ID, leaseId: dupId }).count() +
      db.occupants
        .find({ realmId: REALM_ID, leaseId: ObjectId(dupId) })
        .count();
    if (n > 0) {
      stillReferenced.push({ leaseId: dupId, refs: n });
    }
  });
  if (stillReferenced.length > 0) {
    print(JSON.stringify({
      error: 'tenants still reference duplicates; aborting delete',
      stillReferenced: stillReferenced,
      tenantsRepointed: tenantsRepointed
    }));
    return;
  }

  // Count tenants already on canonical (idempotency check).
  tenantsAlreadyOk = db.occupants
    .find({ realmId: REALM_ID, leaseId: CANONICAL })
    .count();

  // 3. Delete the dupes. find().forEach() + remove() to avoid $-escapes.
  DUPLICATES.forEach(function (dupId) {
    var doc = db.leases.findOne({ _id: ObjectId(dupId) });
    if (!doc) {
      leasesNotFound++;
      return;
    }
    db.leases.remove({ _id: ObjectId(dupId) });
    leasesDeleted++;
  });

  // 4. Final shape.
  var finalLeaseCount = db.leases
    .find({ realmId: REALM_ID })
    .count();
  var final24mCount = db.leases
    .find({
      realmId: REALM_ID,
      name: 'Μίσθωση 24 μηνών'
    })
    .count();

  print(JSON.stringify({
    ok: true,
    canonical: CANONICAL,
    tenantsRepointed: tenantsRepointed,
    tenantsOnCanonical: tenantsAlreadyOk,
    leasesDeleted: leasesDeleted,
    leasesNotFound: leasesNotFound,
    leasesInRealmAfter: finalLeaseCount,
    leases24mAfter: final24mCount
  }));
})();
