import {
  Collections,
  Crypto,
  logger,
  ServiceError
} from '@microrealestate/common';
import type { ServiceRequest, ServiceResponse } from '@microrealestate/types';
import { validateEnum, validateArrayMaxLength, LOCALES } from '../validators.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Req = ServiceRequest<any, any, any>;
type Res = ServiceResponse;
type AnyRecord = Record<string, any>;

const SECRET_PLACEHOLDER = '**********';

function _hasRequiredFields(realm: AnyRecord): void {
  [
    { name: 'name', provided: !!realm.name },
    { name: 'members', provided: !!realm.members },
    { name: 'currency', provided: !!realm.currency },
    {
      name: 'member with administator role',
      provided: !!realm.members.find(({ role }: AnyRecord) => role === 'administrator')
    },
    { name: 'locale', provided: !!realm.locale }
  ].forEach((field) => {
    if (!field.provided) {
      logger.error(`missing landlord ${field.name}`);
      throw new ServiceError('missing fields', 422);
    }
  });
}

function _isNameAlreadyTaken(realm: AnyRecord, realms: AnyRecord[] = []): void {
  if (
    realms
      .map(({ name }: AnyRecord) => name.trim().toLowerCase())
      .includes(realm.name.trim().toLowerCase())
  ) {
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
  for (const app of realm.applications) {
    app.clientSecret = SECRET_PLACEHOLDER;
  }
  return realm;
}

export async function add(req: Req, res: Res) {
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
  validateArrayMaxLength(req.body.members, 50, 'members');

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
  const updatedRealm: AnyRecord = { ...previousRealm.toObject(), ...req.body };

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

  const dbAccounts: AnyRecord[] = await Collections.Account.find().lean();
  const usernameMap = dbAccounts.reduce(
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
  res.json(_escapeSecrets(await previousRealm.save()));
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
