import fetchPDF from './fetchpdf.js';
import fs from 'fs';
import i18n from 'i18n';
import moment from 'moment';

export async function build(
  authorizationHeader: string | undefined,
  locale: string,
  organizationId: string,
  templateName: string,
  recordId: string,
  params: Record<string, any>,
  { tenant }: { tenant: any }
) {
  if (
    ![
      'invoice',
      'rentcall',
      'rentcall_last_reminder',
      'rentcall_reminder'
    ].includes(templateName)
  ) {
    return {
      attachment: []
    };
  }

  i18n.setLocale(locale);
  const billingRef = `${moment(params.term, 'YYYYMMDDHH')
    .locale(locale)
    .format('MM_YY')}_${tenant.reference}`;
  const filename = `${i18n.__(templateName)}-${tenant.name}-${billingRef}.pdf`;
  const filePath = await fetchPDF(
    authorizationHeader,
    organizationId,
    templateName,
    recordId,
    params,
    filename
  );
  const data = fs.readFileSync(filePath);
  return {
    attachment: [
      {
        filename,
        data
      }
    ]
  };
}
