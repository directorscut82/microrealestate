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
  // tenant.name is user-controlled and previously flowed straight into
  // a filesystem path. Inputs like `<script>`, `..`, or `/` either
  // crashed the FS write or escaped the temp dir. Defense in depth:
  //   1. Strip path-unsafe + control chars first (defends FS layer).
  //   2. Allow only ASCII alphanum + ._- + Greek code blocks
  //      (Ͱ-Ͽ, ἀ-῿) + whitespace, replace everything else with `_`.
  //   3. Collapse runs of whitespace to a single underscore so the
  //      resulting filename never contains spaces.
  // The 100-char cap defends against the 255-byte filesystem limit
  // on common volumes.
  const sanitize = (s: any) =>
    String(s || 'unknown')
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .replace(/[^A-Za-z0-9._\-Ͱ-Ͽἀ-῿\s]/g, '_')
      .replace(/\s+/g, '_')
      .slice(0, 100);
  const filename = `${sanitize(i18n.__(templateName))}-${sanitize(tenant.name)}-${sanitize(billingRef)}.pdf`;
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
