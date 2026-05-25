import {
  Collections,
  Crypto,
  logger,
  ServiceError
} from '@microrealestate/common';
import type { ServiceRequest, ServiceResponse } from '@microrealestate/types';
import {
  validateEnum,
  validateArrayMaxLength,
  validateStringField,
  validateFiniteNumber,
  LOCALES,
  CURRENCIES
} from '../validators.js';

// Wave-24 B8: a permissive RFC-5322-ish email regex. We don't need full
// 822/5322 grammar — most callers send well-formed addresses; this is
// defensive validation against `members[].email = "not-an-email"` which
// would otherwise persist verbatim and fail downstream auth flows.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Req = ServiceRequest<any, any, any>;
type Res = ServiceResponse;
type AnyRecord = Record<string, any>;

const SECRET_PLACEHOLDER = '**********';

// Map regional IETF tags accepted by the API onto the canonical short form
// downstream code keys on (i18n catalogues, moment.locale, accounting CSV).
// Without this, a realm saved with locale 'el-GR' would later fail i18n
// lookups that key on 'el'. 'en-US' / 'fr-FR' / 'pt-BR' / 'de-DE' / 'es-CO'
// already match catalogue keys exactly, so no remap is needed.
const LOCALE_ALIASES: Record<string, string> = {
  'el-GR': 'el'
};

function _normalizeLocale<T>(input: T): T {
  if (typeof input !== 'string') return input;
  return (LOCALE_ALIASES[input] ?? input) as T;
}

function _hasRequiredFields(realm: AnyRecord): void {
  // Wave-24 B9: distinguish "missing field" from "no administrator". Both
  // were collapsed into the same generic 'missing fields' message which
  // gave the user no signal which constraint failed.
  const baseFields = [
    { name: 'name', provided: !!realm.name },
    { name: 'members', provided: !!realm.members },
    { name: 'currency', provided: !!realm.currency },
    { name: 'locale', provided: !!realm.locale }
  ];
  for (const field of baseFields) {
    if (!field.provided) {
      logger.error(`missing landlord ${field.name}`);
      throw new ServiceError(`missing fields: ${field.name}`, 422);
    }
  }
  const hasAdmin =
    Array.isArray(realm.members) &&
    realm.members.some(
      ({ role }: AnyRecord) => role === 'administrator'
    );
  if (!hasAdmin) {
    logger.error('missing landlord member with administrator role');
    throw new ServiceError(
      'at least one administrator member is required',
      422
    );
  }
}

function _isNameAlreadyTaken(realm: AnyRecord, realms: AnyRecord[] = []): void {
  // Exclude the realm under edit from the duplicate check — comparing
  // against itself by name was producing false 409s when an admin renamed
  // the realm but kept the casing close to the original (or used the same
  // exact name). The check should only fire for OTHER realms.
  const candidate = String(realm.name || '').trim().toLowerCase();
  const selfId = realm._id ? String(realm._id) : null;
  const collision = realms.some((r: AnyRecord) => {
    if (selfId && String(r._id) === selfId) return false;
    return String(r.name || '').trim().toLowerCase() === candidate;
  });
  if (collision) {
    throw new ServiceError('landlord name already taken', 409);
  }
}

function _escapeSecrets(realm: AnyRecord): AnyRecord {
  if (realm.thirdParties?.gmail?.appPassword) {
    realm.thirdParties.gmail.appPassword = SECRET_PLACEHOLDER;
  }
  if (realm.thirdParties?.smtp?.password) {
    realm.thirdParties.smtp.password = SECRET_PLACEHOLDER;
  }
  if (realm.thirdParties?.mailgun?.apiKey) {
    realm.thirdParties.mailgun.apiKey = SECRET_PLACEHOLDER;
  }
  if (realm.thirdParties?.b2?.keyId) {
    realm.thirdParties.b2.keyId = SECRET_PLACEHOLDER;
  }
  if (realm.thirdParties?.b2?.applicationKey) {
    realm.thirdParties.b2.applicationKey = SECRET_PLACEHOLDER;
  }
  if (realm.thirdParties?.smsGateway?.password) {
    realm.thirdParties.smsGateway.password = SECRET_PLACEHOLDER;
  }
  for (const app of (realm.applications || [])) {
    app.clientSecret = SECRET_PLACEHOLDER;
  }
  return realm;
}

export async function add(req: Req, res: Res) {
  // Force-inject the caller as the sole administrator member. Without this,
  // an authenticated user could POST { members: [{ email: 'victim@x' }] }
  // and create a "phantom" realm owned by someone else (or themselves +
  // unwanted observers).
  const callerEmail = (req.user as AnyRecord)?.email;
  if (!callerEmail) {
    throw new ServiceError('authenticated user required to create realm', 401);
  }
  req.body.members = [
    {
      email: callerEmail,
      role: 'administrator',
      registered: true
    }
  ];

  // Name validation (trim, length cap, non-empty) — mirror update().
  req.body.name = validateStringField(req.body.name, 'name', {
    min: 1,
    max: 200,
    required: true
  });

  // Locale validation — update() already does this; add() previously only
  // failed via Mongoose schema validation as a generic 500.
  if (req.body.locale !== undefined) {
    validateEnum(req.body.locale, LOCALES, 'locale');
    req.body.locale = _normalizeLocale(req.body.locale);
  }

  const newRealm: any = new Collections.Realm(req.body);

  _hasRequiredFields(newRealm);
  _isNameAlreadyTaken(newRealm, req.realms);

  if (newRealm.thirdParties?.gmail?.appPassword) {
    newRealm.thirdParties.gmail.appPassword = Crypto.encrypt(
      newRealm.thirdParties.gmail.appPassword
    );
  }

  if (newRealm.thirdParties?.smtp?.password) {
    newRealm.thirdParties.smtp.password = Crypto.encrypt(
      newRealm.thirdParties.smtp.password
    );
  }

  if (newRealm.thirdParties?.mailgun?.apiKey) {
    newRealm.thirdParties.mailgun.apiKey = Crypto.encrypt(
      newRealm.thirdParties.mailgun.apiKey
    );
  }

  if (newRealm.thirdParties?.b2?.applicationKey) {
    newRealm.thirdParties.b2.applicationKey = Crypto.encrypt(
      newRealm.thirdParties.b2.applicationKey
    );
  }

  if (newRealm.thirdParties?.b2?.keyId) {
    newRealm.thirdParties.b2.keyId = Crypto.encrypt(
      newRealm.thirdParties.b2.keyId
    );
  }

  if (newRealm.thirdParties?.smsGateway?.password) {
    newRealm.thirdParties.smsGateway.password = Crypto.encrypt(
      newRealm.thirdParties.smsGateway.password
    );
  }

  res.json(_escapeSecrets(await newRealm.save()));
}

export async function update(req: Req, res: Res) {
  const gmailAppPasswordUpdated =
    !!req.body.thirdParties?.gmail?.appPasswordUpdated;
  validateEnum(req.body.locale, LOCALES, 'locale');
  req.body.locale = _normalizeLocale(req.body.locale);
  // Wave-21 C29-B1: validate currency against ISO-4217 subset. Letting an
  // arbitrary string through here causes Intl.NumberFormat to throw a
  // RangeError when the accounting CSV tries to format amounts with it,
  // surfacing as a generic 500 to the user.
  if (req.body.currency !== undefined) {
    validateEnum(req.body.currency, CURRENCIES, 'currency');
  }
  validateArrayMaxLength(req.body.members, 50, 'members');

  // Wave-24 A8: companyInfo.capital was reaching Mongoose unvalidated.
  // "abc" → schema cast error 500 + "headers already sent" log because the
  // error fires after .save() partially serializes a response.
  if (req.body.companyInfo?.capital !== undefined && req.body.companyInfo.capital !== '') {
    validateFiniteNumber(req.body.companyInfo.capital, 'companyInfo.capital', {
      min: 0,
      max: 1e15
    });
  }

  // Wave-24 B8: members[].email was accepted as any string ("not-an-email").
  // Validate before the dedup pass so a bad email surfaces the field name.
  if (Array.isArray(req.body.members)) {
    for (let i = 0; i < req.body.members.length; i++) {
      const m = req.body.members[i];
      if (m?.email !== undefined && m.email !== null && m.email !== '') {
        if (typeof m.email !== 'string' || !EMAIL_RE.test(m.email.trim())) {
          throw new ServiceError(
            `members[${i}].email is not a valid email`,
            422
          );
        }
      }
    }
  }

  // Wave-21 C29-B2: dedupe members by email (case-insensitive). Without
  // this, a payload [{X,admin},{X,admin}] persists both rows, polluting
  // the access list. Conflicting roles resolve to administrator > renter.
  if (Array.isArray(req.body.members)) {
    const ROLE_RANK: Record<string, number> = {
      administrator: 2,
      renter: 1,
      tenant: 0
    };
    const byEmail = new Map<string, AnyRecord>();
    for (const member of req.body.members as AnyRecord[]) {
      if (!member?.email || typeof member.email !== 'string') continue;
      const key = member.email.trim().toLowerCase();
      if (!key) continue;
      const existing = byEmail.get(key);
      if (!existing) {
        byEmail.set(key, { ...member, email: member.email.trim() });
        continue;
      }
      const existingRank = ROLE_RANK[String(existing.role || '')] ?? -1;
      const incomingRank = ROLE_RANK[String(member.role || '')] ?? -1;
      if (incomingRank > existingRank) {
        byEmail.set(key, { ...member, email: member.email.trim() });
      }
    }
    req.body.members = Array.from(byEmail.values());
  }
  if (req.body.name !== undefined) {
    req.body.name = validateStringField(req.body.name, 'name', {
      min: 1,
      max: 200,
      required: true
    });
  }

  // Type-guard the `selected` flag on every third-party provider before the
  // deep-merge below. Without this a payload like
  // `thirdParties.smsGateway.selected = "true"` (string) or {$ne:false} would
  // be persisted verbatim and downstream `if (selected)` checks would behave
  // unexpectedly across services that read this config.
  const PROVIDERS = ['gmail', 'smtp', 'mailgun', 'b2', 'smsGateway'] as const;
  for (const p of PROVIDERS) {
    const sel = req.body.thirdParties?.[p]?.selected;
    if (sel !== undefined && typeof sel !== 'boolean') {
      throw new ServiceError(
        `thirdParties.${p}.selected must be a boolean`,
        422
      );
    }
  }

  const smtpPasswordUpdated = !!req.body.thirdParties?.smtp?.passwordUpdated;
  const mailgunApiKeyUpdated = !!req.body.thirdParties?.mailgun?.apiKeyUpdated;
  const b2KeyIdUpdated = !!req.body.thirdParties?.b2?.keyIdUpdated;
  const b2ApplicationKeyUpdated =
    !!req.body.thirdParties?.b2?.applicationKeyUpdated;

  if (req.realm!._id !== req.body?._id) {
    throw new ServiceError(
      'only current selected organization can be updated',
      403
    );
  }

  if ((req.user as AnyRecord).role !== 'administrator') {
    throw new ServiceError(
      'only administrator member can update the organization',
      403
    );
  }

  const previousRealm: any = await Collections.Realm.findOne({
    _id: req.body._id
  });

  if (!previousRealm) {
    throw new ServiceError('organization not found', 404);
  }

  // Deep-merge thirdParties so a PATCH that touches a single provider does
  // not wipe configuration for the others. Previously a body containing
  // only `thirdParties.gmail = {...}` would replace the whole subtree and
  // erase smtp/mailgun/b2/smsGateway settings that the user never touched.
  const previousObj = previousRealm.toObject();
  const updatedRealm: AnyRecord = {
    ...previousObj,
    ...req.body,
    thirdParties: req.body.thirdParties
      ? { ...(previousObj.thirdParties || {}), ...req.body.thirdParties }
      : previousObj.thirdParties
  };

  _hasRequiredFields(updatedRealm);
  if (
    updatedRealm.name.trim().toLowerCase() !==
    req.realm!.name.trim().toLowerCase()
  ) {
    _isNameAlreadyTaken(updatedRealm, req.realms);
  }

  if (req.body.thirdParties?.gmail) {
    logger.debug('realm update with Gmail third party emailer');
    if (gmailAppPasswordUpdated) {
      updatedRealm.thirdParties.gmail.appPassword = Crypto.encrypt(
        req.body.thirdParties.gmail.appPassword
      );
    } else {
      updatedRealm.thirdParties.gmail.appPassword =
        previousRealm.thirdParties.gmail?.appPassword;
    }
  }

  if (req.body.thirdParties?.smtp) {
    logger.debug('realm update with SMTP third party emailer');
    if (smtpPasswordUpdated) {
      updatedRealm.thirdParties.smtp.password = Crypto.encrypt(
        req.body.thirdParties.smtp.password
      );
    } else {
      updatedRealm.thirdParties.smtp.password =
        previousRealm.thirdParties.smtp.password;
    }
  }

  if (req.body.thirdParties?.mailgun) {
    logger.debug('realm update with Mailgun third party emailer');
    if (mailgunApiKeyUpdated) {
      updatedRealm.thirdParties.mailgun.apiKey = Crypto.encrypt(
        req.body.thirdParties.mailgun.apiKey
      );
    } else {
      updatedRealm.thirdParties.mailgun.apiKey =
        previousRealm.thirdParties.mailgun.apiKey;
    }
  }

  if (req.body.thirdParties?.b2) {
    if (b2KeyIdUpdated) {
      updatedRealm.thirdParties.b2.keyId = Crypto.encrypt(
        req.body.thirdParties.b2.keyId
      );
    } else {
      updatedRealm.thirdParties.b2.keyId = previousRealm.thirdParties.b2.keyId;
    }

    if (b2ApplicationKeyUpdated) {
      updatedRealm.thirdParties.b2.applicationKey = Crypto.encrypt(
        req.body.thirdParties.b2.applicationKey
      );
    } else {
      updatedRealm.thirdParties.b2.applicationKey =
        previousRealm.thirdParties.b2.applicationKey;
    }
  }

  if (req.body.thirdParties?.smsGateway) {
    const smsPasswordUpdated = !!req.body.thirdParties.smsGateway.passwordUpdated;
    const previousSmsPassword = previousRealm.thirdParties?.smsGateway?.password;
    if (smsPasswordUpdated || !previousSmsPassword) {
      updatedRealm.thirdParties.smsGateway.password = Crypto.encrypt(
        req.body.thirdParties.smsGateway.password
      );
    } else {
      updatedRealm.thirdParties.smsGateway.password = previousSmsPassword;
    }
  }

  // Only fetch accounts that match realm member emails (not ALL accounts)
  const memberEmails = updatedRealm.members.map((m: AnyRecord) => m.email).filter(Boolean);
  const dbAccounts: AnyRecord[] = await Collections.Account.find({
    email: { $in: memberEmails }
  }, { email: 1, firstname: 1, lastname: 1 }).lean();
  const usernameMap = (dbAccounts as AnyRecord[]).reduce(
    (acc: AnyRecord, { email, firstname, lastname }: AnyRecord) => {
      acc[email] = `${firstname} ${lastname}`;
      return acc;
    },
    {}
  );

  updatedRealm.members.forEach((member: AnyRecord) => {
    const name = usernameMap[member.email];
    member.name = name || '';
    member.registered = !!name;
  });

  const prevAppcredzMap: AnyRecord = {};
  req.realm!.applications.reduce((acc: AnyRecord, app: AnyRecord) => {
    acc[app.clientId] = app;
    return acc;
  }, prevAppcredzMap);

  updatedRealm.applications = updatedRealm.applications.map((app: AnyRecord) => {
    if (prevAppcredzMap[app.clientId]) {
      return prevAppcredzMap[app.clientId];
    }
    return app;
  });

  previousRealm.set(updatedRealm);
  // Mongoose throws VersionError when the document was modified between
  // findOne and save (optimistic concurrency control on __v). Surface that
  // as a 409 instead of leaking it as a generic 500.
  try {
    res.json(_escapeSecrets(await previousRealm.save()));
  } catch (err: any) {
    if (err && err.name === 'VersionError') {
      throw new ServiceError(
        'Realm was modified concurrently. Please retry.',
        409
      );
    }
    throw err;
  }
}

export function one(req: Req, res: Res) {
  const realmId = req.params.id;
  if (!realmId) {
    logger.error('missing landlord id');
    throw new ServiceError('missing fields', 422);
  }

  const realm = req.realms.find(({ _id }: AnyRecord) => _id.toString() === realmId);
  if (!realm) {
    throw new ServiceError('landlord not found', 404);
  }

  res.json(_escapeSecrets(realm));
}

export function all(req: Req, res: Res) {
  res.json(req.realms.map((realm: AnyRecord) => _escapeSecrets(realm)));
}

export async function leaveRealm(req: Req, res: Res) {
  const realm = req.realm;
  if (!realm) {
    throw new ServiceError('organization not found', 404);
  }
  const email = (req.user as AnyRecord)?.email;
  if (!email) {
    throw new ServiceError('authenticated user required', 401);
  }

  // Pull the caller from the realm's members list.
  const updated: any = await Collections.Realm.findOneAndUpdate(
    { _id: realm._id, 'members.email': email },
    { $pull: { members: { email } } },
    { new: true }
  );

  if (!updated) {
    // Either the realm vanished or the caller wasn't a member of it.
    throw new ServiceError('not a member of this organization', 404);
  }

  // If pulling the caller would leave the realm without any administrators,
  // refuse and restore the membership. The check happens AFTER the pull so
  // we can read `updated.members` directly — the alternative (read first,
  // then pull) opens a TOCTOU race.
  const remainingAdmins = (updated.members || []).filter(
    (m: AnyRecord) => m.role === 'administrator'
  );
  if (remainingAdmins.length === 0) {
    await Collections.Realm.updateOne(
      { _id: realm._id },
      {
        $push: {
          members: {
            email,
            role: 'administrator',
            registered: true
          }
        }
      }
    );
    throw new ServiceError(
      'Cannot leave: you are the only administrator. Promote another member first.',
      422
    );
  }

  logger.info(`User ${email} left realm ${realm._id} (${realm.name})`);
  res.sendStatus(204);
}

export async function remove(req: Req, res: Res) {
  // Only an administrator may delete a realm. Without this check, any
  // authenticated user (including a renter on another realm) can call
  // DELETE /realms/:id and erase data.
  if ((req.user as AnyRecord)?.role !== 'administrator') {
    throw new ServiceError('forbidden', 403);
  }

  const realmId = req.params.id;
  if (!realmId) {
    throw new ServiceError('missing realm id', 422);
  }

  const realm = req.realms.find(
    ({ _id }: AnyRecord) => _id.toString() === realmId
  );
  if (!realm) {
    throw new ServiceError('organization not found', 404);
  }

  const tenantCount = await Collections.Tenant.countDocuments({ realmId });
  const propertyCount = await Collections.Property.countDocuments({ realmId });
  const leaseCount = await Collections.Lease.countDocuments({ realmId });
  const buildingCount = await Collections.Building.countDocuments({ realmId });

  const blockers: string[] = [];
  if (tenantCount > 0) blockers.push(`${tenantCount} tenant(s)`);
  if (propertyCount > 0) blockers.push(`${propertyCount} property/ies`);
  if (leaseCount > 0) blockers.push(`${leaseCount} lease(s)`);
  if (buildingCount > 0) blockers.push(`${buildingCount} building(s)`);

  if (blockers.length > 0) {
    throw new ServiceError(
      `Cannot delete organization: ${blockers.join(', ')} still exist. Remove them first.`,
      422
    );
  }

  await Collections.Template.deleteMany({ realmId });
  await Collections.Document.deleteMany({ realmId });
  await Collections.Email.deleteMany({ realmId });
  // Bills outlive tenants/properties (they may exist before any tenant is
  // attached), so we cascade-delete them here before the realm itself.
  await Collections.Bill.deleteMany({ realmId });
  await Collections.Realm.deleteOne({ _id: realmId });

  logger.info(`Realm ${realmId} (${realm.name}) deleted by ${(req.user as AnyRecord)?.email}`);

  res.sendStatus(204);
}
