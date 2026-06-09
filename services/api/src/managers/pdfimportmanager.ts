import { Collections, logger, ServiceError } from '@microrealestate/common';
import { Request, Response } from 'express';
import moment from 'moment';
import { parseGreekLease } from './greekleaseparser.js';

export type ImportClassificationKind =
  | 'new'
  | 'update'
  | 'extension'
  | 'review';

export interface ImportClassification {
  kind: ImportClassificationKind;
  matchedTenantId: string | null;
}

/**
 * Classify a parsed Greek lease PDF against existing tenants in the realm
 * so the import dialog can default the correct merge strategy.
 *
 *  - new       : no existing tenant matches the parsed primary or coTenant taxIds
 *  - extension : parsed primary taxId === existing primary taxId, the existing
 *                lease has a valid endDate, no terminationDate, and the parsed
 *                validityStart is within ~30d of the existing endDate while
 *                validityEnd extends past it (i.e. a renewal / continuation)
 *  - update    : parsed primary taxId matched on existing primary taxId but
 *                the extension proximity test failed (treat as in-place edit)
 *  - review    : parsed primary taxId matches ONLY a coTenant on an existing
 *                tenant (ambiguous — let the user decide)
 */
export async function classifyAgainstExisting(
  parsed: any,
  realmId: string
): Promise<ImportClassification> {
  const primaryTaxId: string | undefined = parsed?.tenants?.[0]?.taxId;
  if (!primaryTaxId) {
    return { kind: 'new', matchedTenantId: null };
  }

  // Build the set of taxIds we want to look up across both primary and
  // coTenant slots in a single query.
  const coTenantTaxIds: string[] = Array.isArray(parsed.tenants)
    ? parsed.tenants
        .map((t: any) => t?.taxId)
        .filter((id: any) => typeof id === 'string' && id.length > 0)
    : [];
  const allTaxIds = Array.from(new Set([primaryTaxId, ...coTenantTaxIds]));

  const matches: any[] = await Collections.Tenant.find({
    realmId,
    $or: [
      { taxId: { $in: allTaxIds } },
      { 'coTenants.taxId': { $in: allTaxIds } }
    ]
  }).lean();

  if (!matches.length) {
    return { kind: 'new', matchedTenantId: null };
  }

  // Prefer a primary-taxId match (kind=update or kind=extension). Otherwise
  // fall back to a coTenant-only match (kind=review).
  const primaryMatch = matches.find(
    (t: any) => typeof t.taxId === 'string' && t.taxId === primaryTaxId
  );

  if (primaryMatch) {
    const existingEnd = primaryMatch.endDate
      ? moment.utc(primaryMatch.endDate)
      : null;
    const validityStart = parsed.validityStart
      ? moment.utc(parsed.validityStart, 'DD/MM/YYYY', true)
      : null;
    const validityEnd = parsed.validityEnd
      ? moment.utc(parsed.validityEnd, 'DD/MM/YYYY', true)
      : null;

    const hasNoTermination = !primaryMatch.terminationDate;
    const isExtension =
      hasNoTermination &&
      existingEnd &&
      existingEnd.isValid() &&
      validityStart &&
      validityStart.isValid() &&
      validityEnd &&
      validityEnd.isValid() &&
      // parsed start is within 30 days BEFORE or any time AFTER the
      // existing end (>= -30 days)
      validityStart.diff(existingEnd, 'days') >= -30 &&
      validityEnd.isAfter(existingEnd);

    return {
      kind: isExtension ? 'extension' : 'update',
      matchedTenantId: String(primaryMatch._id)
    };
  }

  // No primary match — every match must be a coTenant-only hit.
  const coTenantOnlyMatch = matches.find((t: any) =>
    Array.isArray(t.coTenants) &&
    t.coTenants.some(
      (ct: any) => typeof ct?.taxId === 'string' && allTaxIds.includes(ct.taxId)
    )
  );
  if (coTenantOnlyMatch) {
    return {
      kind: 'review',
      matchedTenantId: String(coTenantOnlyMatch._id)
    };
  }

  return { kind: 'new', matchedTenantId: null };
}

async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(buffer);
  const doc = await getDocument({ data }).promise;
  let fullText = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    fullText +=
      content.items.map((item: any) => item.str).join(' ') +
      '\n--- PAGE BREAK ---\n';
  }
  return fullText;
}

export async function parseImportedPdf(
  req: Request,
  res: Response
): Promise<void> {
  const file = (req as any).file;
  if (!file) {
    res.sendStatus(422);
    return;
  }
  const realmId: string | undefined = (req as any).realm?._id;

  // pdfjs-dist throws "Invalid PDF structure" / "InvalidPDFException" on
  // corrupted or non-PDF input. Without this guard the rejection bubbles
  // up to the global error handler as an opaque 500. Translate to 422 so
  // the client knows the file is unprocessable rather than the server is
  // broken. Any ServiceError already raised inside parsing is rethrown
  // unchanged.
  try {
    const text = await extractTextFromPdf(file.buffer);
    const parsed = parseGreekLease(text);
    // P1.1 / M6: reject non-lease PDFs (e.g. E9 wealth declarations,
    // ΠΕΡΙΟΥΣΙΑΚΗ ΚΑΤΑΣΤΑΣΗ printouts, random Taxisnet receipts) at the
    // server boundary. parseGreekLease returns the empty default shape
    // for any input that lacks the AADE lease section markers; the
    // landlord dialog then crashes on `primaryTenant.name.split` and on
    // `prop.address?.street1` (optional chain on .address, not on prop).
    // 5/16 PDFs in the user's corpus took this path. Better to fail fast
    // here with a recognisable 422 than crash the dialog client-side.
    if (
      (!parsed.tenants || parsed.tenants.length === 0) &&
      (!parsed.properties || parsed.properties.length === 0)
    ) {
      throw new ServiceError(
        'PDF does not appear to be an AADE Taxisnet lease declaration',
        422
      );
    }
    // Classify against existing tenants so the dialog can default the
    // correct merge strategy (extend / replace / create-new / review).
    let classification: ImportClassification = {
      kind: 'new',
      matchedTenantId: null
    };
    if (realmId) {
      try {
        classification = await classifyAgainstExisting(parsed, realmId);
      } catch (cerr) {
        // Classification is advisory — never let a DB hiccup block the
        // parse response. The dialog can still proceed and the existing
        // client-side primary-taxId match will pick up the same tenant.
        const cmsg = cerr instanceof Error ? cerr.message : String(cerr);
        logger.warn(`PDF classification failed: ${cmsg}`);
      }
    }
    res.json({ ...parsed, classification });
  } catch (err) {
    if (err instanceof ServiceError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`PDF parse failed: ${message}`);
    throw new ServiceError(`Could not parse PDF: ${message}`, 422);
  }
}
