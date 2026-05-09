import * as Contract from './contract.js';
import * as FD from './frontdata.js';
import {
  Collections,
  logger,
  Service,
  ServiceError
} from '@microrealestate/common';
import type { ReqNoParams, ReqWithId, ReqWithIdTerm, ReqWithYearMonth, Res } from '../types/requests.js';
import axios from 'axios';
import moment from 'moment';
import type { CollectionTypes } from '@microrealestate/types';
import {
  validateObjectId,
  validateFiniteNumber,
  validateArrayMaxLength
} from '../validators.js';

type AnyRecord = Record<string, any>;

async function _findOccupants(
  realm: CollectionTypes.Realm | null | undefined,
  tenantId?: string | null,
  startTerm?: number,
  endTerm?: number
): Promise<AnyRecord[]> {
  const filter: AnyRecord = {
    $query: {
      $and: [{ realmId: realm!._id }]
    }
  };
  if (tenantId) {
    filter['$query']['$and'].push({ _id: tenantId });
  }
  if (startTerm && endTerm) {
    filter['$query']['$and'].push({ 'rents.term': { $gte: startTerm } });
    filter['$query']['$and'].push({ 'rents.term': { $lte: endTerm } });
  } else if (startTerm) {
    filter['$query']['$and'].push({ 'rents.term': startTerm });
  }

  const dbTenants: AnyRecord[] = await Collections.Tenant.find(filter.$query)
    .sort({
      name: 1
    })
    .lean();

  return dbTenants.map((tenant) => {
    tenant._id = String(tenant._id);
    if (startTerm && endTerm) {
      tenant.rents = tenant.rents.filter(
        (rent: AnyRecord) => rent.term >= startTerm && rent.term <= endTerm
      );
    } else if (startTerm) {
      tenant.rents = tenant.rents.filter(
        (rent: AnyRecord) => rent.term === startTerm
      );
    }
    return tenant;
  });
}

async function _getEmailStatus(
  authorizationHeader: string | undefined,
  locale: string | undefined,
  realm: CollectionTypes.Realm | null | undefined,
  startTerm: number,
  endTerm?: number
): Promise<AnyRecord> {
  const { DEMO_MODE, EMAILER_URL } =
    Service.getInstance().envConfig.getValues();
  try {
    let emailEndPoint = `${EMAILER_URL}/status/${startTerm}`;
    if (endTerm) {
      emailEndPoint = `${EMAILER_URL}/status/${startTerm}/${endTerm}`;
    }
    const response = await axios.get(emailEndPoint, {
      headers: {
        authorization: authorizationHeader,
        organizationid: String(realm!._id),
        'Accept-Language': locale
      }
    });
    logger.debug(response.data);
    return response.data.reduce((acc: AnyRecord, status: AnyRecord) => {
      const data = {
        sentTo: status.sentTo,
        sentDate: status.sentDate
      };
      if (!acc[status.recordId]) {
        acc[status.recordId] = { [status.templateName]: [] };
      }
      let documents = acc[status.recordId][status.templateName];
      if (!documents) {
        documents = [];
        acc[status.recordId][status.templateName] = documents;
      }
      documents.push(data);
      return acc;
    }, {});
  } catch (error: any) {
    logger.error(`Failed to get email status: ${error.message || error}`);
    if (DEMO_MODE) {
      logger.info('email status fallback workflow activated in demo mode');
      return {};
    } else {
      throw new ServiceError(
        error.response?.data?.message || 'Failed to fetch email status',
        error.response?.status || 500
      );
    }
  }
}

async function _getRentsDataByTerm(
  authorizationHeader: string | undefined,
  locale: string | undefined,
  realm: CollectionTypes.Realm | null | undefined,
  currentDate: moment.Moment,
  frequency: moment.unitOfTime.StartOf
): Promise<AnyRecord> {
  const startTerm = Number(currentDate.startOf(frequency).format('YYYYMMDDHH'));
  const endTerm = Number(currentDate.endOf(frequency).format('YYYYMMDDHH'));

  const [dbOccupants, emailStatus = {}] = await Promise.all([
    _findOccupants(realm, null, startTerm, endTerm),
    _getEmailStatus(
      authorizationHeader,
      locale,
      realm,
      startTerm,
      endTerm
    ).catch((e) => logger.error(String(e)))
  ]);

  const rents = (dbOccupants as AnyRecord[]).reduce(
    (acc: AnyRecord[], occupant: AnyRecord) => {
      acc.push(
        ...occupant.rents
          .filter(
            (rent: AnyRecord) => rent.term >= startTerm && rent.term <= endTerm
          )
          .map((rent: AnyRecord) =>
            FD.toRentData(rent, occupant, (emailStatus as AnyRecord)?.[occupant._id])
          )
      );
      return acc;
    },
    []
  );

  const overview: AnyRecord = {
    countAll: 0,
    countPaid: 0,
    countPartiallyPaid: 0,
    countNotPaid: 0,
    totalToPay: 0,
    totalPaid: 0,
    totalNotPaid: 0
  };
  rents.reduce((acc: AnyRecord, rent: AnyRecord) => {
    if (rent.totalAmount <= 0 || rent.newBalance >= 0) {
      acc.countPaid++;
    } else if (rent.payment > 0) {
      acc.countPartiallyPaid++;
    } else {
      acc.countNotPaid++;
    }
    acc.countAll++;
    acc.totalToPay += rent.totalToPay;
    acc.totalPaid += rent.payment;
    acc.totalNotPaid -= rent.newBalance < 0 ? rent.newBalance : 0;
    return acc;
  }, overview);

  return { overview, rents };
}

export async function update(req: ReqNoParams, res: Res) {
  const realm = req.realm;
  const authorizationHeader = req.headers.authorization;
  const locale = req.headers['accept-language'] as string | undefined;
  const paymentData = req.body;

  validateObjectId(paymentData._id, 'tenant id');
  validateFiniteNumber(paymentData.year, 'year', { required: true, min: 2020, max: 2099 });
  validateFiniteNumber(paymentData.month, 'month', { required: true, min: 1, max: 12 });
  validateFiniteNumber(paymentData.promo, 'promo', { min: 0, max: 10000000 });
  validateFiniteNumber(paymentData.extracharge, 'extracharge', { min: 0, max: 10000000 });
  validateArrayMaxLength(paymentData.payments, 20, 'payments');

  const term = `${paymentData.year}${paymentData.month}0100`;

  res.json(
    await _updateByTerm(authorizationHeader, locale, realm, term, paymentData)
  );
}

export async function updateByTerm(req: ReqWithIdTerm, res: Res) {
  const realm = req.realm;
  const term = req.params.term;
  const authorizationHeader = req.headers.authorization;
  const locale = req.headers['accept-language'] as string | undefined;
  const paymentData = req.body;

  validateObjectId(paymentData._id, 'tenant id');
  if (!/^\d{10}$/.test(term)) {
    throw new ServiceError('Invalid term format', 422);
  }
  validateFiniteNumber(paymentData.promo, 'promo', { min: 0, max: 10000000 });
  validateFiniteNumber(paymentData.extracharge, 'extracharge', { min: 0, max: 10000000 });
  validateArrayMaxLength(paymentData.payments, 20, 'payments');

  res.json(
    await _updateByTerm(authorizationHeader, locale, realm, term, paymentData)
  );
}

async function _updateByTerm(
  authorizationHeader: string | undefined,
  locale: string | undefined,
  realm: CollectionTypes.Realm | null | undefined,
  term: string,
  paymentData: AnyRecord
): Promise<AnyRecord> {
  if (!paymentData.promo || Number(paymentData.promo) <= 0) {
    paymentData.promo = 0;
    paymentData.notepromo = null;
  }

  if (!paymentData.extracharge || Number(paymentData.extracharge) <= 0) {
    paymentData.extracharge = 0;
    paymentData.noteextracharge = null;
  }

  const occupantDoc: AnyRecord = (await Collections.Tenant.findOne({
    _id: paymentData._id,
    realmId: realm!._id
  }).lean()) as AnyRecord;

  if (!occupantDoc) {
    throw new ServiceError('Tenant not found', 404);
  }

  const occupant = occupantDoc;
  const documentVersion = occupant.__v;

  const contract: AnyRecord = {
    frequency: occupant.frequency || 'months',
    begin: occupant.beginDate,
    end: occupant.endDate,
    discount: occupant.discount || 0,
    vatRate: occupant.vatRatio,
    properties: occupant.properties,
    rents: occupant.rents
  };

  const settlements: AnyRecord = {
    payments: [],
    debts: [],
    discounts: [],
    description: ''
  };

  if (paymentData) {
    if (paymentData.payments && paymentData.payments.length) {
      settlements.payments = paymentData.payments
        .filter(({ amount }: AnyRecord) => amount && Number(amount) > 0)
        .map((payment: AnyRecord) => ({
          date: payment.date || '',
          amount: Number(payment.amount),
          type: payment.type || '',
          reference: payment.reference || '',
          description: payment.description || ''
        }));
    }

    if (paymentData.promo) {
      settlements.discounts.push({
        origin: 'settlement',
        description: paymentData.notepromo || '',
        amount:
          paymentData.promo *
          (contract.vatRate ? 1 / (1 + contract.vatRate) : 1)
      });
    }

    if (paymentData.extracharge) {
      settlements.debts.push({
        description: paymentData.noteextracharge || '',
        amount:
          paymentData.extracharge *
          (contract.vatRate ? 1 / (1 + contract.vatRate) : 1)
      });
    }

    if (paymentData.description) {
      settlements.description = paymentData.description;
    }
  }

  occupant.rents = Contract.payTerm(contract as any, term, settlements).rents;

  const emailStatus =
    (await _getEmailStatus(
      authorizationHeader,
      locale,
      realm,
      Number(term)
    ).catch((e) => logger.error(String(e)))) || {};

  const savedOccupant: AnyRecord = await Collections.Tenant.findOneAndUpdate(
    {
      _id: occupant._id,
      realmId: realm!._id,
      __v: documentVersion
    },
    { $set: { rents: occupant.rents }, $inc: { __v: 1 } },
    { new: true }
  ).lean();

  if (!savedOccupant) {
    throw new ServiceError(
      'Payment conflict: another update was made simultaneously. Please retry.',
      409
    );
  }

  const rent = savedOccupant.rents.filter(
    (rent: AnyRecord) => rent.term === Number(term)
  )[0];

  return FD.toRentData(
    rent,
    savedOccupant,
    (emailStatus as AnyRecord)?.[String(savedOccupant._id)]
  );
}

export async function rentsOfOccupant(req: ReqWithId, res: Res) {
  const realm = req.realm;
  const { id } = req.params;
  const term = Number(moment.utc().format('YYYYMMDDHH'));

  const dbOccupants = await _findOccupants(realm, id);
  if (!dbOccupants.length) {
    return res.sendStatus(404);
  }

  const dbOccupant = dbOccupants[0];
  const rentsToReturn = dbOccupant.rents.map((currentRent: AnyRecord) => {
    const rent: AnyRecord = FD.toRentData(currentRent);
    if (currentRent.term === term) {
      rent.active = 'active';
    }
    rent.vatRatio = dbOccupant.vatRatio;
    return rent;
  });

  res.json({
    occupant: FD.toOccupantData(dbOccupant),
    rents: rentsToReturn
  });
}

export async function rentOfOccupantByTerm(req: ReqWithIdTerm, res: Res) {
  const realm = req.realm;
  const { id, term } = req.params;

  res.json(
    await _rentOfOccupant(
      req.headers.authorization,
      req.headers['accept-language'] as string | undefined,
      realm,
      id,
      term
    )
  );
}

async function _rentOfOccupant(
  authorizationHeader: string | undefined,
  locale: string | undefined,
  realm: CollectionTypes.Realm | null | undefined,
  tenantId: string,
  term: string
): Promise<AnyRecord> {
  const [dbOccupants = [], emailStatus = {}] = await Promise.all([
    _findOccupants(realm, tenantId, Number(term)).catch((e) => {
      logger.error(`Failed to find occupants: ${e}`);
      return [];
    }),
    _getEmailStatus(authorizationHeader, locale, realm, Number(term)).catch((e) => {
      logger.error(`Failed to get email status: ${e}`);
      return {};
    })
  ]);

  if (!(dbOccupants as AnyRecord[]).length) {
    throw new ServiceError('tenant not found', 404);
  }
  const dbOccupant = (dbOccupants as AnyRecord[])[0];

  if (!dbOccupant.rents.length) {
    throw new ServiceError('rent not found', 404);
  }
  const rent: AnyRecord = FD.toRentData(
    dbOccupant.rents[0],
    dbOccupant,
    (emailStatus as AnyRecord)?.[dbOccupant._id]
  );
  if (rent.term === Number(moment.utc().format('YYYYMMDDHH'))) {
    rent.active = 'active';
  }
  rent.vatRatio = dbOccupant.vatRatio;

  return rent;
}

export async function all(req: ReqWithYearMonth, res: Res) {
  const realm = req.realm;

  let currentDate = moment.utc().startOf('month');
  if (req.params.year && req.params.month) {
    currentDate = moment.utc(`${req.params.month}/${req.params.year}`, 'MM/YYYY');
  }

  res.json(
    await _getRentsDataByTerm(
      req.headers.authorization,
      req.headers['accept-language'] as string | undefined,
      realm,
      currentDate,
      'months'
    )
  );
}
