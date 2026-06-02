import * as rentcall from '../rentcall/index.js';
import * as utils from '../index.js';
import moment from 'moment';

export async function get(params, documentId = 'rentcall_reminder') {
  // Forward the actual reminder documentId so getRentsData can keep
  // rent.charges in the body (rent-call kind), not the invoice default.
  const data = await rentcall.get(params, documentId);

  const momentToday = moment();

  data.tenant.rents.forEach((rent) => {
    const momentTerm = moment(rent.term, 'YYYYMMDDHH');
    const endOfTerm = momentTerm.endOf(data.tenant.contract.lease.timeRange);
    if (momentToday.isAfter(endOfTerm, 'day')) {
      rent.documentDate = utils.avoidWeekend(endOfTerm).format('DD/MM/YYYY');
    } else {
      rent.documentDate = utils.avoidWeekend(momentToday).format('DD/MM/YYYY');
    }
  });

  return data;
}
