import * as pdf from '../pdf.js';
import * as s3 from '../utils/s3.js';
import {
  Collections,
  Format,
  logger,
  Middlewares,
  OwnerStatement,
  Service,
  ServiceError
} from '@microrealestate/common';
import express from 'express';
import fs from 'fs-extra';
import Handlebars from 'handlebars';
import moment from 'moment';
import multer from 'multer';
import path from 'path';
import { sanitize } from '../utils/index.js';
import uploadMiddleware from '../utils/uploadmiddelware.js';

// Pipe a download stream to the response with a mid-transfer error handler.
// A .pipe(res) with no 'error' listener on the source will, if the stream
// errors after headers are sent (B2 connection drop, disk read fault), emit
// an unhandled 'error' event and CRASH the whole pdfgenerator process — the
// try/catch around .pipe() only catches synchronous construction errors, not
// async stream errors (ingress+error-path audit 2026-07). Here we destroy the
// response so the client sees a truncated transfer instead of a hung socket,
// and the process survives.
function safePipe(
  source: NodeJS.ReadableStream,
  res: express.Response,
  label: string
) {
  source.on('error', (err: Error) => {
    logger.error(`stream error while sending ${label}: ${err?.message || err}`);
    if (!res.headersSent) {
      res.status(502).end();
    } else {
      res.destroy(err);
    }
  });
  return source.pipe(res);
}

// MongoDB ObjectIds are 24-character lowercase hex strings. Validating
// before the Mongoose query prevents Mongoose's CastError from bubbling
// up as a 500 — and short-circuits any URL-encoded path-traversal in
// the :id slot.
const OBJECT_ID_RE = /^[a-fA-F0-9]{24}$/;
function assertValidObjectId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !OBJECT_ID_RE.test(value)) {
    throw new ServiceError(`invalid ${name}`, 422);
  }
  return value;
}

// Translate multer's MulterError class into a clean HTTP response. The
// previous handler bubbled the raw error to the express default 500
// handler, leaking the stack and using the wrong status code (413 is
// the correct response for a payload-too-large upload).
function handleUploadError(
  err: any,
  // express requires the 4-arg signature for error middlewares; req is unused
  // here but must remain in the signature for express to pick this handler up.
  _req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 422;
    return res.status(status).json({ status, message: err.message });
  }
  return next(err);
}

async function _getTempate(organization: any, templateId: string) {
  const template = await Collections.Template.findOne({
    _id: templateId,
    realmId: organization._id
  }).lean();

  return template;
}

async function _getTemplateValues(organization: any, tenantId: string, leaseId: string) {
  const tenant = await Collections.Tenant.findOne({
    _id: tenantId,
    realmId: organization._id
  })
    .populate('properties.propertyId')
    .lean();

  const lease = await Collections.Lease.findOne({
    _id: leaseId,
    realmId: organization._id
  }).lean();

  // compute rent, expenses and surface from properties
  const PropertyGlobals = (tenant as any).properties.reduce(
    (acc: any, { rent, expenses = [], property: { surface } }: any) => {
      acc.rentAmount += rent;
      acc.expensesAmount +=
        expenses.reduce((sum: number, { amount }: any) => {
          sum += amount;
          return sum;
        }, 0) || 0;
      acc.surface += surface;
      return acc;
    },
    { rentAmount: 0, expensesAmount: 0, vatAmount: 0, surface: 0 }
  );

  // manage legacy discount
  if ((tenant as any).discount) {
    PropertyGlobals.rentAmount -= (tenant as any).discount;
  }

  // manage vat
  if ((tenant as any).isVat && (tenant as any).vatRatio) {
    PropertyGlobals.vatAmount =
      Math.round(
        (PropertyGlobals.rentAmount + PropertyGlobals.expensesAmount) *
          (tenant as any).vatRatio *
          100
      ) / 100;
  }

  const landlordCompanyInfo = organization.companyInfo
    ? {
        ...organization.companyInfo,
        capital: organization.companyInfo.capital
          ? Format.formatCurrency(
              organization.locale,
              organization.currency,
              organization.companyInfo.capital
            )
          : ''
      }
    : null;

  moment.locale(organization.locale);
  const today = moment();
  const templateValues = {
    current: {
      date: today.format('LL'),
      day: today.format('D'),
      month: today.format('MMMM'),
      year: today.format('YYYY'),
      location: organization.addresses?.[0]?.city
    },

    landlord: {
      name: organization.name,
      contact: organization.contacts?.[0] || {},
      address: organization.addresses?.[0] || {},
      companyInfo: landlordCompanyInfo
    },

    tenant: {
      name: (tenant as any)?.name,

      companyInfo: {
        legalRepresentative: (tenant as any)?.manager,
        legalStructure: (tenant as any)?.legalForm,
        capital: (tenant as any)?.capital
          ? Format.formatCurrency(
              organization.locale,
              organization.currency,
              (tenant as any).capital
            )
          : '',
        ein: (tenant as any)?.siret,
        dos: (tenant as any)?.rcs
      },

      address: {
        street1: (tenant as any)?.street1,
        street2: (tenant as any)?.street2,
        zipCode: (tenant as any)?.zipCode,
        city: (tenant as any)?.city,
        state: (tenant as any)?.state,
        country: (tenant as any)?.country
      },

      contacts:
        (tenant as any)?.contacts.map(({ contact, email, phone }: any) => ({
          name: contact,
          email,
          phone
        })) || []
    },

    properties: {
      total: {
        surface: Format.formatNumber(
          organization.locale,
          PropertyGlobals.surface
        ),
        rentAmount: Format.formatCurrency(
          organization.locale,
          organization.currency,
          PropertyGlobals.rentAmount
        ),
        expensesAmount: Format.formatCurrency(
          organization.locale,
          organization.currency,
          PropertyGlobals.expensesAmount
        ),
        allInclusiveRentAmount: Format.formatCurrency(
          organization.locale,
          organization.currency,
          PropertyGlobals.rentAmount + PropertyGlobals.expensesAmount
        ),
        allInclusiveRentWithVATAmount: Format.formatCurrency(
          organization.locale,
          organization.currency,
          PropertyGlobals.rentAmount +
            PropertyGlobals.expensesAmount +
            PropertyGlobals.vatAmount
        )
      },
      list: (tenant as any)?.properties.map(
        ({
          propertyId: {
            name,
            description,
            type,
            surface,
            phone,
            address,
            digicode,
            price
          }
        }: any) => ({
          name,
          description,
          type,
          rent: Format.formatCurrency(
            organization.locale,
            organization.currency,
            price
          ),
          surface: Format.formatNumber(organization.locale, surface),
          phone,
          address,
          digicode
        })
      )
    },

    lease: {
      name: lease?.name,
      description: (lease as any)?.description,
      numberOfTerms: lease?.numberOfTerms,
      timeRange: lease?.timeRange,
      beginDate: moment((tenant as any).beginDate).format('LL'),
      endDate: moment((tenant as any).endDate).format('LL'),
      deposit: Format.formatCurrency(
        organization.locale,
        organization.currency,
        (tenant as any).guaranty || 0
      )
    }
  };
  return templateValues;
}

// Substitute `{{path.to.field}}` markers in plain-text nodes with values
// from the template-values context. Missing fields render as empty strings
// (no crash) so authors can use optional fields safely. This complements
// the richtext template-node substitution below — without it, plain-text
// Handlebars markers typed directly into a paragraph were emitted verbatim.
function _resolveString(s: string, ctx: any): string {
  return s.replace(/\{\{([\w.[\]]+)\}\}/g, (_m, path: string) => {
    try {
      const segments = path.match(/[^.[\]]+/g) || [];
      let v: any = ctx;
      for (const seg of segments) v = v?.[seg];
      return v == null ? '' : String(v);
    } catch {
      return '';
    }
  });
}

function _resolveTemplates(element: any, templateValues: any): any {
  if (element.content) {
    element.content = element.content.map((childElement: any) =>
      _resolveTemplates(childElement, templateValues)
    );
  }

  // Plain text nodes — substitute any `{{...}}` markers in-place.
  if (element.type === 'text' && typeof element.text === 'string') {
    element.text = _resolveString(element.text, templateValues);
  }

  if (element.type === 'template') {
    element.type = 'text';
    element.text = Handlebars.compile(element.attrs.id)(templateValues) || ' ';
    // Keep HTML entities escaped — un-escaping &#x27; back to ' is a textbook
    // way to reintroduce XSS by allowing user-controlled apostrophes through
    // an attribute boundary in downstream renderers.
    delete element.attrs;
  }
  return element;
}

export default function () {
  /**
   * routes:
   * GET    /documents                         -> JSON
   * GET    /documents/:id                     -> JSON | pdf | image file
   * GET    /documents/:document/:id/:term     -> pdf file
   * POST   /documents/upload                  -> JSON
   * (input: FormData with pdf or image file)
   * POST   /documents                         -> JSON
   * (input: Document model)
   * PATCH  /documents                         -> JSON
   * input: Document model
   * DELETE /documents/:ids
   */
  const { UPLOADS_DIRECTORY } = Service.getInstance().envConfig.getValues();
  const documentsApi = express.Router();

  // Owner expense statement (Εκκαθαριστικό εξόδων ιδιοκτήτη) — the OWNER twin
  // of the tenant receipt. Distinct literal path because the owner identity is
  // an `ownerKey` (m:<id> or n:<name>|<taxId>, URL-encoded) NOT an ObjectId,
  // so it must not hit the tenant route's ObjectId validation. Registered
  // BEFORE the generic /:document/:id/:term so 'owner-statement' is matched
  // here. The data picker (data/owner_statement) re-validates the owner +
  // term and 404s on an empty statement.
  documentsApi.get(
    '/owner-statement/:ownerKey/:term',
    Middlewares.asyncWrapper(async (req, res) => {
      try {
        const realm = (req as any).realm;
        if (!realm?._id) {
          throw new ServiceError('organization required', 404);
        }
        const term = String(req.params.term);
        // Same term shape as the receipt route: YYYY or YYYYMMDDHH, or a
        // comma-separated list of up to 12 such terms.
        const TERM_RE = /^(\d{4}(\d{6})?)(,\d{4}(\d{6})?){0,11}$/;
        if (!TERM_RE.test(term)) {
          throw new ServiceError('invalid term format', 422);
        }
        const pdfFile = await pdf.generate('owner_statement', {
          ownerKey: req.params.ownerKey,
          term,
          realmId: String(realm._id)
        });
        return res.download(pdfFile);
      } catch (error) {
        if (error instanceof ServiceError) throw error;
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === 'EACCES' || code === 'ENOENT' || code === 'EROFS') {
          logger.error(
            `owner_statement PDF filesystem error (${code}): ${(error as Error).message}`
          );
          throw new ServiceError('PDF generation failed', 500);
        }
        // owner not found / no charges → 404 with the picker's message.
        throw new ServiceError(error as Error, 404);
      }
    })
  );

  documentsApi.get(
    '/:document/:id/:term',
    Middlewares.asyncWrapper(async (req, res) => {
      try {
        logger.debug(`generate pdf file for ${JSON.stringify(req.params)}`);
        const realm = (req as any).realm;
        if (!realm?._id) {
          throw new ServiceError('organization required', 404);
        }

        // Pre-flight: confirm the tenant exists in this realm AND has a
        // rent entry for the requested term. Without this, the renderer
        // happily produces a ~1KB blank PDF for terms outside the
        // contract window — a silent data integrity bug.
        const tenantId = req.params.id;
        const term = req.params.term;
        if (!OBJECT_ID_RE.test(String(tenantId))) {
          throw new ServiceError('invalid tenant id', 422);
        }
        // Accept either a full 10-digit YYYYMMDDHH term (single-month
        // invoice), a 4-digit YYYY year (year-of-invoices), OR a
        // comma-separated list of up to 12 such terms (Q4 multi-month
        // batch — used by the per-month picker in the landlord
        // accounting page to stitch multiple receipt sections into a
        // single PDF). The data layer at services/pdfgenerator/data/
        // index.js filters via OR-of-startsWith across the comma-split
        // sub-terms, so a 4-digit prefix still correctly selects every
        // rent in that year.
        const TERM_RE = /^(\d{4}(\d{6})?)(,\d{4}(\d{6})?){0,11}$/;
        if (!TERM_RE.test(String(term))) {
          throw new ServiceError('invalid term format', 422);
        }
        // Defense-in-depth: split on `,` and re-validate each sub-term
        // matches the single-term shape. The combined regex above
        // already enforces this, but a per-element check makes intent
        // explicit and protects against future regex regressions.
        const termStr = String(term);
        const subTerms = termStr.split(',');
        const SINGLE_TERM_RE = /^\d{4}(\d{6})?$/;
        for (const st of subTerms) {
          if (!SINGLE_TERM_RE.test(st)) {
            throw new ServiceError('invalid term format', 422);
          }
        }
        const tenant = await Collections.Tenant.findOne({
          _id: tenantId,
          realmId: String(realm._id)
        }).lean();
        if (!tenant) {
          throw new ServiceError('tenant not found', 404);
        }

        // CROSS-TENANT AUTHORIZATION. The realm scoping above is NOT sufficient when
        // the caller is a TENANT: needAccessToken accepts the tenant sessionToken
        // (middlewares.ts:135) and checkOrganization resolves the realm from the
        // CLIENT-SUPPLIED organizationid header for cookie requests, so a tenant could
        // swap the id in /documents/invoice/<id>/<term> and receive ANOTHER tenant's
        // invoice PDF — name, address, ΑΦΜ, rent and payment history.
        // The tenant sessionToken carries { email, role: 'tenant' }
        // (authenticator/routes/tenant.ts:162), so bind the requested tenant to that
        // email. A landlord principal (role administrator/renter, or an application
        // token) is unaffected: managing every tenant in the realm is the point.
        const principal = (req as any).user;
        if (principal?.role === 'tenant') {
          const sessionEmail = String(principal.email || '')
            .trim()
            .toLowerCase();
          const tenantEmails = ((tenant as any).contacts || [])
            .map((c: any) => String(c?.email || '').trim().toLowerCase())
            .filter(Boolean);
          if (!sessionEmail || !tenantEmails.includes(sessionEmail)) {
            // Log the ATTEMPT without the address itself — logs are shipped and this
            // is a real person's email.
            logger.warn(
              `tenant session denied documents for tenant ${tenantId} (session email does not match tenant contacts)`
            );
            throw new ServiceError('forbidden', 403);
          }
        }
        // Pre-flight: at least ONE sub-term must have a matching rent
        // across all rents. The data picker at pdfgenerator/data/
        // index.js uses `terms.some(t => String(rent.term).startsWith(t))`
        // when filtering, so an all-miss request would render an empty
        // PDF without this guard. We do NOT require every sub-term to
        // match — partial matches still produce a useful multi-section
        // PDF for the months that exist.
        const rents = (tenant as any).rents || [];
        const hasTerm = rents.some((r: any) =>
          subTerms.some((st) => String(r.term).startsWith(st))
        );
        if (!hasTerm) {
          throw new ServiceError('rent not found for term', 404);
        }

        // Pass the caller's realmId into the data picker so the underlying
        // Tenant.findOne is realm-scoped — without this, anyone with a valid
        // session in any org could fetch any tenant's PDF by id.
        const pdfFile = await pdf.generate(req.params.document, {
          ...req.params,
          realmId: String(realm._id)
        });
        return res.download(pdfFile);
      } catch (error) {
        // Preserve explicit ServiceError status codes; only fall back to 404
        // for unexpected errors from the PDF pipeline.
        if (error instanceof ServiceError) {
          throw error;
        }
        // Wave-20 F4: filesystem permission/missing errors are infra
        // failures (500), not "not found" (404). Treating EACCES/ENOENT
        // as 404 misled the user into thinking their data was missing
        // when the container couldn't write the PDF. Strip the absolute
        // path from the message so we don't leak internal layout.
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === 'EACCES' || code === 'ENOENT' || code === 'EROFS') {
          logger.error(
            `PDF generation filesystem error (${code}): ${(error as Error).message}`
          );
          throw new ServiceError('PDF generation failed', 500);
        }
        throw new ServiceError(error as Error, 404);
      }
    })
  );

  documentsApi.get(
    '/',
    Middlewares.asyncWrapper(async (req, res) => {
      const organizationId = (req as any).realm?._id;
      if (!organizationId) {
        throw new ServiceError('organization not resolved', 400);
      }

      // Optional per-entity filters (?tenantId= / ?buildingId= / ?ownerKey=)
      // so the tenant/building/owner document panels fetch only their own
      // rows. No filter → the whole realm (legacy behavior).
      const filter: Record<string, any> = { realmId: organizationId };
      if (req.query.tenantId) filter.tenantId = String(req.query.tenantId);
      if (req.query.buildingId)
        filter.buildingId = String(req.query.buildingId);
      if (req.query.ownerKey) filter.ownerKey = String(req.query.ownerKey);

      const documentsFound = await Collections.Document.find(filter);
      if (!documentsFound) {
        throw new ServiceError('document not found', 404);
      }

      return res.status(200).json(documentsFound);
    })
  );

  // Storage reconcile: diff the realm's B2 objects against every stored key
  // reference (Document.url + building repairs' invoiceDocumentId) and
  // delete orphaned objects / report records whose bytes are missing. Called
  // by the api's database-restore (best-effort) and available standalone.
  // Restore only rewrites MONGO — after restoring an older backup, files
  // uploaded after that backup become invisible orphans in B2, and records
  // resurrected for since-deleted files point at nothing. This closes both.
  documentsApi.post(
    '/reconcile-storage',
    Middlewares.asyncWrapper(async (req, res) => {
      const realm = (req as any).realm;
      if (!realm?._id) {
        throw new ServiceError('organization not resolved', 400);
      }
      // D2 (audit-2026-07): this endpoint version-DELETES B2 objects. It must
      // be administrator-only — a `renter` (read-only for money) or `tenant`
      // must never be able to destroy a realm's stored files. The restore
      // path (the primary caller) is itself admin-gated and forwards the
      // administrator's own token, so the legitimate flow is unaffected.
      if ((req as any).user?.role !== 'administrator') {
        throw new ServiceError('Administrator access required', 403);
      }
      const b2Config = realm.thirdParties?.b2;
      if (!s3.isEnabled(b2Config)) {
        return res.json({
          enabled: false,
          orphansDeleted: [],
          missingFiles: []
        });
      }

      // 1. Every key the DATABASE believes exists for this realm.
      const referenced = new Set<string>();
      const docs: any[] = await Collections.Document.find(
        { realmId: realm._id, type: 'file', url: { $exists: true, $ne: '' } },
        { url: 1, name: 1 }
      ).lean();
      for (const d of docs) referenced.add(String(d.url));
      // Repair invoices store a raw key on the building, not a Document row.
      const buildings: any[] = await Collections.Building.find(
        { realmId: realm._id },
        { 'repairs.invoiceDocumentId': 1 }
      ).lean();
      for (const b of buildings) {
        for (const r of b.repairs || []) {
          if (r.invoiceDocumentId) referenced.add(String(r.invoiceDocumentId));
        }
      }

      // D7 (audit-2026-07): the Bill schema carries three file-URL fields
      // (pdfUrl / paymentProofUrl / irisCodeUrl). They are data-URIs today
      // ("move to B2 later" TODO), so they will never match a B2 key — but the
      // MOMENT bill PDFs move to B2, a reconcile that did not know about them
      // would classify every bill file as an orphan and delete it. Reference
      // them now so this is future-proof. (Data-URIs simply don't collide with
      // the realm's `<name>-<id>/…` key prefix, so adding them is a no-op until
      // then.) Keep this in sync with any new B2-backed URL field on any model.
      const bills: any[] = await Collections.Bill.find(
        { realmId: realm._id },
        { pdfUrl: 1, paymentProofUrl: 1, irisCodeUrl: 1 }
      ).lean();
      for (const bill of bills) {
        for (const u of [bill.pdfUrl, bill.paymentProofUrl, bill.irisCodeUrl]) {
          if (u) referenced.add(String(u));
        }
      }

      // InboxItem.sourcePdfUrl is a REAL B2 object key (the archived source of
      // a Telegram-ingested bill, set at ingest — Slice 5), unlike the bill
      // data-URIs above. A PENDING inbox item lives up to 30 days before the
      // landlord confirms/dismisses it, so its archived source is a live,
      // otherwise-unreferenced key: without this the reconcile would classify
      // it as an orphan and DELETE the only copy of the incoming bill before
      // it is ever confirmed (ingress+error-path audit 2026-07).
      // Scope to status:'pending' ONLY (Step-7 F3): a CONFIRMED item's source is
      // already referenced via the Bill's pdfUrl (confirm carries sourcePdfUrl
      // onto Bill.pdfUrl), and a DISMISSED item's source is genuinely reclaimable
      // — protecting all statuses would permanently pin dismissed sources (their
      // rows never expire; the TTL index only reaps pending) and leak B2 forever.
      const inboxItems: any[] = await Collections.InboxItem.find(
        {
          realmId: realm._id,
          status: 'pending',
          sourcePdfUrl: { $exists: true, $ne: '' }
        },
        { sourcePdfUrl: 1 }
      ).lean();
      for (const it of inboxItems) {
        if (it.sourcePdfUrl) referenced.add(String(it.sourcePdfUrl));
      }

      // 2. Every object B2 actually holds under this realm's prefix (with its
      // last-modified time — see the D3 age guard below).
      const prefix = `${sanitize(realm.name)}-${sanitize(realm._id)}/`;
      const liveObjects = await s3.listObjects(b2Config, prefix);
      const liveKeys = liveObjects.map((o) => o.key);

      // 3a. Orphans: in B2, not referenced → delete (all versions).
      const dryRun = req.body?.dryRun === true;
      // D3 (audit-2026-07): TOCTOU guard. An upload writes its bytes to B2 a
      // moment before POST /documents creates the matching Document row. A
      // reconcile that runs inside that window (or during a multi-file bulk
      // import) would see the fresh bytes as an orphan and delete them, then
      // the create points at dead bytes. Never delete an object modified
      // within this safety margin — a genuinely orphaned file is still an
      // orphan on the next run, but an in-flight upload is protected.
      const RECENT_UPLOAD_GRACE_MS = 10 * 60 * 1000; // 10 minutes
      const nowMs = Date.now();
      const lastModifiedByKey = new Map(
        liveObjects.map((o) => [o.key, o.lastModified])
      );
      const orphans = liveKeys.filter((k) => !referenced.has(k));
      const orphansDeleted: string[] = [];
      const orphansSkippedRecent: string[] = [];
      for (const key of orphans) {
        const lm = lastModifiedByKey.get(key);
        // D3 (audit-2026-07): fail CLOSED. Protect an object from deletion when
        // it is recent OR when we cannot determine its age. AWS/B2 always
        // return LastModified, but a non-conformant S3 backend might omit it —
        // in that case treat the object as too-risky-to-delete rather than
        // fail-open (which would re-expose the in-flight-upload TOCTOU).
        const ageMs = lm ? nowMs - new Date(lm).getTime() : null;
        const isRecent = ageMs === null || ageMs < RECENT_UPLOAD_GRACE_MS;
        if (isRecent) {
          // Too fresh (or undateable) to safely classify as an orphan — could
          // be an in-flight upload whose Document row has not been written yet.
          // Report it so a real orphan isn't silently ignored forever, but
          // never delete it.
          orphansSkippedRecent.push(key);
          continue;
        }
        if (!dryRun) {
          try {
            const versions = await s3.listFileVersions(b2Config, key);
            await s3.deleteFiles(
              b2Config,
              versions.length ? versions : [{ url: key }]
            );
          } catch (err) {
            logger.warn(
              `reconcile: failed to delete orphan ${key}: ${(err as Error)?.message || err}`
            );
            continue;
          }
        }
        orphansDeleted.push(key);
      }

      // 3b. Missing: referenced by a record, absent from B2 → report only
      // (we cannot invent bytes; the operator decides what to do).
      const liveSet = new Set(liveKeys);
      const missingFiles = docs
        .filter((d) => !liveSet.has(String(d.url)))
        .map((d) => ({ documentId: String(d._id), name: d.name, url: d.url }));

      logger.info(
        `reconcile-storage (${realm._id}): ${orphansDeleted.length} orphan(s) ${dryRun ? 'found (dry-run)' : 'deleted'}, ${orphansSkippedRecent.length} skipped (too recent), ${missingFiles.length} record(s) missing bytes`
      );
      return res.json({
        enabled: true,
        dryRun,
        orphansDeleted,
        orphansSkippedRecent,
        missingFiles
      });
    })
  );

  // Direct-key download: returns the file persisted at the given storage
  // key. Used by repair-invoice retrieval (RepairList stores the upload's
  // returned key as `repair.invoiceDocumentId` and does NOT open a
  // Document collection record). Realm scoping is enforced by checking
  // the key starts with the realm's `<orgName>-<orgId>/` prefix —
  // /documents/upload writes every key under that prefix
  // (uploadmiddelware.ts:62-73), so any key outside it could not have
  // been produced by this realm.
  documentsApi.get(
    '/by-key',
    Middlewares.asyncWrapper(async (req, res) => {
      const realm = (req as any).realm;
      if (!realm?._id) {
        throw new ServiceError('organization required', 404);
      }
      const rawKey = req.query?.key;
      if (typeof rawKey !== 'string' || !rawKey.length) {
        throw new ServiceError('key required', 422);
      }
      // Reject control chars, backslashes, leading slashes, and any `..`
      // segment before doing path resolution. The path.resolve check
      // below is the second line of defence.
      // eslint-disable-next-line no-control-regex
      // eslint-disable-next-line no-control-regex
      if (/\\|^\/+|(^|\/)\.\.(\/|$)|[ -]/.test(rawKey)) {
        throw new ServiceError('invalid key', 422);
      }
      const expectedPrefix = `${sanitize(realm.name)}-${sanitize(realm._id)}/`;
      if (!rawKey.startsWith(expectedPrefix)) {
        // Either tampered key or a legacy upload from a different
        // realm — refuse without leaking which case.
        throw new ServiceError('forbidden', 403);
      }

      const { UPLOADS_DIRECTORY } = Service.getInstance().envConfig.getValues();
      const uploadsRoot = path.resolve(UPLOADS_DIRECTORY as string);
      const filePath = path.resolve(uploadsRoot, rawKey);
      if (
        filePath !== uploadsRoot &&
        !filePath.startsWith(uploadsRoot + path.sep)
      ) {
        throw new ServiceError('forbidden', 403);
      }

      const baseName = path.basename(rawKey).replace(/[\r\n"]/g, '');
      const asciiFallback = baseName.replace(/[^A-Za-z0-9._-]/g, '_');
      const utf8Encoded = encodeURIComponent(baseName);
      // Inline (not attachment) so the browser can preview PDFs/images
      // when the user clicks "View invoice"; downloads still work via
      // right-click → Save As.
      const contentDisposition = `inline; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`;

      const ext = path.extname(rawKey).toLowerCase().replace(/^\./, '');
      const mimeMap: Record<string, string> = {
        pdf: 'application/pdf',
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        jpe: 'image/jpeg',
        gif: 'image/gif'
      };
      const mimeType = mimeMap[ext] || 'application/octet-stream';

      // Local-disk path first
      if (fs.existsSync(filePath)) {
        res.setHeader('Content-Type', mimeType);
        res.setHeader('Content-Disposition', contentDisposition);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        return safePipe(fs.createReadStream(filePath), res, rawKey);
      }
      // S3/B2 fallback
      if (s3.isEnabled(realm?.thirdParties?.b2)) {
        try {
          res.setHeader('Content-Type', mimeType);
          res.setHeader('Content-Disposition', contentDisposition);
          res.setHeader('X-Content-Type-Options', 'nosniff');
          return safePipe(
            s3.downloadFile(realm.thirdParties.b2, rawKey),
            res,
            rawKey
          );
        } catch (err) {
          logger.error(
            `cannot download ${rawKey} from s3: ${
              (err as Error)?.message || err
            }`
          );
          throw new ServiceError('cannot download file', 404);
        }
      }
      throw new ServiceError('file not found', 404);
    })
  );

  // Direct-key delete: removes a file persisted via /documents/upload.
  // Used to clean up repair invoices when the user clicks "Remove" on
  // the upload widget OR cancels the dialog before save (F4-repair).
  // Same realm-prefix guard as the GET — keys outside the realm's
  // `<orgName>-<orgId>/` prefix are rejected. Returns 204 even if the
  // file is already gone (idempotent), so a Cancel handler can fire
  // unconditionally without race-related 404s.
  documentsApi.delete(
    '/by-key',
    Middlewares.asyncWrapper(async (req, res) => {
      const realm = (req as any).realm;
      if (!realm?._id) {
        throw new ServiceError('organization required', 404);
      }
      const rawKey = req.query?.key;
      if (typeof rawKey !== 'string' || !rawKey.length) {
        throw new ServiceError('key required', 422);
      }
      // eslint-disable-next-line no-control-regex
      if (/[\\ -]|^\/+|(^|\/)\.\.(\/|$)/.test(rawKey)) {
        throw new ServiceError('invalid key', 422);
      }
      const expectedPrefix = `${sanitize(realm.name)}-${sanitize(realm._id)}/`;
      if (!rawKey.startsWith(expectedPrefix)) {
        throw new ServiceError('forbidden', 403);
      }
      const { UPLOADS_DIRECTORY } = Service.getInstance().envConfig.getValues();
      const uploadsRoot = path.resolve(UPLOADS_DIRECTORY as string);
      const filePath = path.resolve(uploadsRoot, rawKey);
      if (
        filePath !== uploadsRoot &&
        !filePath.startsWith(uploadsRoot + path.sep)
      ) {
        throw new ServiceError('forbidden', 403);
      }
      try {
        if (fs.existsSync(filePath)) {
          await fs.remove(filePath);
        }
      } catch (err) {
        logger.warn(
          `delete /by-key: filesystem remove failed for ${rawKey}: ${
            (err as Error)?.message || err
          }`
        );
      }
      // S3/B2 best-effort cleanup. The B2 bucket keeps ALL versions; a
      // version-less delete only writes a delete marker and the old bytes
      // linger forever. Enumerate the key's versions and delete each one.
      if (s3.isEnabled(realm?.thirdParties?.b2)) {
        try {
          const versions = await s3.listFileVersions(
            realm.thirdParties.b2,
            rawKey
          );
          await s3.deleteFiles(
            realm.thirdParties.b2,
            versions.length ? versions : [{ url: rawKey }]
          );
        } catch (err) {
          logger.warn(
            `delete /by-key: s3 remove failed for ${rawKey}: ${
              (err as Error)?.message || err
            }`
          );
        }
      }
      return res.status(204).send();
    })
  );

  documentsApi.get(
    '/:id',
    Middlewares.asyncWrapper(async (req, res) => {
      // Validate the id BEFORE the Mongoose query. URL-encoded `..`
      // sequences would otherwise reach Mongoose, throw CastError, and
      // bubble out as an opaque 500 with a stack trace.
      const documentId = assertValidObjectId(req.params.id, 'document id');

      const documentFound = await Collections.Document.findOne({
        _id: documentId,
        realmId: (req as any).realm._id
      });

      if (!documentFound) {
        logger.warn(`document ${documentId} not found`);
        throw new ServiceError('document not found', 404);
      }

      if (documentFound.type === 'text') {
        return res.status(200).json(documentFound);
      }

      if (documentFound.type === 'file') {
        if (!(documentFound as any)?.url) {
          logger.warn('document url required');
          throw new ServiceError('missing fields', 422);
        }

        const url: string = (documentFound as any).url;

        // Robust path traversal check: resolve the absolute path and confirm
        // it stays inside UPLOADS_DIRECTORY. The previous `indexOf('..')`
        // string match missed URL-encoded variants like `%2e%2e` and
        // mixed-separator attempts. `path.resolve` decodes `..` segments
        // so any escape attempt resolves outside the uploads root.
        const uploadsRoot = path.resolve(UPLOADS_DIRECTORY as string);
        const filePath = path.resolve(uploadsRoot, url);
        if (
          filePath !== uploadsRoot &&
          !filePath.startsWith(uploadsRoot + path.sep)
        ) {
          logger.warn(`document url ${url} escapes uploads root`);
          throw new ServiceError('forbidden', 403);
        }

        // figure out mime + filename for safe download response
        const mimeType =
          (documentFound as any).mimeType || 'application/octet-stream';
        // Preserve the original (possibly non-ASCII) filename for the user
        // via RFC 5987 `filename*=UTF-8''<encoded>`, while keeping a sanitized
        // ASCII fallback in `filename=` for legacy clients. Strip CR/LF/quotes
        // from both to prevent header-injection.
        const originalName = (
          (documentFound as any).name || path.basename(url)
        )
          .toString()
          .replace(/[\r\n"]/g, '');
        const asciiFallback = originalName.replace(/[^A-Za-z0-9._-]/g, '_');
        const utf8Encoded = encodeURIComponent(originalName);
        const contentDisposition = `attachment; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`;

        // first try to download from file system
        if (fs.existsSync(filePath)) {
          try {
            res.setHeader('Content-Type', mimeType);
            res.setHeader('Content-Disposition', contentDisposition);
            res.setHeader('X-Content-Type-Options', 'nosniff');
            return safePipe(fs.createReadStream(filePath), res, url);
          } catch (error) {
            logger.error(
              `cannot download file ${url} from file system`,
              error
            );
            throw new ServiceError('cannot download file', 404);
          }
        }

        // otherwise download from s3
        if (s3.isEnabled((req as any).realm?.thirdParties?.b2)) {
          try {
            res.setHeader('Content-Type', mimeType);
            res.setHeader('Content-Disposition', contentDisposition);
            res.setHeader('X-Content-Type-Options', 'nosniff');
            return safePipe(
              s3.downloadFile((req as any).realm.thirdParties.b2, url),
              res,
              url
            );
          } catch (error) {
            logger.error(`cannot download file ${url} from s3`, error);
            throw new ServiceError('cannot download file', 404);
          }
        }
      }

      logger.error(`document ${documentId} not found`);
      throw new ServiceError('document not found', 404);
    })
  );

  documentsApi.post(
    '/upload',
    uploadMiddleware(),
    handleUploadError,
    Middlewares.asyncWrapper(async (req, res) => {
      // Build the storage key without a leading slash — joining ['', 'file']
      // produced '/file', which path.resolve later treats as an absolute path
      // and resolves OUTSIDE UPLOADS_DIRECTORY, breaking both file lookup and
      // the cleanup sweep's "is this referenced?" check.
      const dirPart = String(req.body.s3Dir || '').replace(/^\/+|\/+$/g, '');
      const filePart = String(req.body.fileName || '').replace(/^\/+/, '');
      const key = dirPart ? `${dirPart}/${filePart}` : filePart;
      // Optional-chain so a realm without thirdParties (or without b2) does
      // not crash the route — previously this threw on `.b2` of undefined.
      const b2Config = (req as any).realm?.thirdParties?.b2;
      // Always clean up the temp upload, regardless of which storage path
      // we take or whether it errored. The previous code only removed the
      // file inside the s3 branch which leaked uploads when s3 was disabled
      // and on uncaught failures.
      //
      // Edge case for local-disk uploads: multer.diskStorage already writes
      // the file directly into UPLOADS_DIRECTORY (see uploadmiddelware.ts),
      // so the "temp" path IS the final destination. The earlier code did
      // a self-copy with fs.copyFileSync(src, src) and then removed it in
      // the finally block — i.e. it deleted the just-uploaded file. Track
      // whether the file is already at its destination to skip both the
      // copy and the cleanup in that case.
      let isAlreadyAtDestination = false;
      try {
        if (s3.isEnabled(b2Config)) {
          try {
            const data = await s3.uploadFile(b2Config, {
              file: (req as any).file!,
              fileName: req.body.fileName,
              url: key
            });
            return res.status(201).send(data);
          } catch (error) {
            throw new ServiceError(error as Error, 500);
          }
        } else {
          // Local-disk fallback: when S3/B2 is not configured, persist the
          // upload to UPLOADS_DIRECTORY so the document is actually
          // retrievable later. The previous code returned 201 with the key
          // but threw the temp file away in the finally block — a silent
          // data-loss bug for self-hosted deployments without object
          // storage.
          const file = (req as any).file;
          if (file?.path) {
            const orgPath = String(req.body.s3Dir || '');
            const targetPath = path.join(
              UPLOADS_DIRECTORY as string,
              orgPath,
              req.body.fileName
            );
            // Defense-in-depth: confirm the resolved target stays inside
            // UPLOADS_DIRECTORY. sanitizePath in uploadmiddelware already
            // strips traversal but a double-check costs nothing.
            const uploadsRoot = path.resolve(UPLOADS_DIRECTORY as string);
            const resolvedTarget = path.resolve(targetPath);
            if (
              resolvedTarget !== uploadsRoot &&
              !resolvedTarget.startsWith(uploadsRoot + path.sep)
            ) {
              throw new ServiceError('invalid upload path', 422);
            }
            isAlreadyAtDestination =
              path.resolve(file.path) === resolvedTarget;
            if (!isAlreadyAtDestination) {
              fs.mkdirSync(path.dirname(resolvedTarget), { recursive: true });
              fs.copyFileSync(file.path, resolvedTarget);
            }
          }
          return res.status(201).send({
            fileName: req.body.fileName,
            key
          });
        }
      } finally {
        try {
          if (
            !isAlreadyAtDestination &&
            (req as any).file?.path &&
            fs.existsSync((req as any).file.path)
          ) {
            fs.removeSync((req as any).file.path);
          }
        } catch (err) {
          // best-effort cleanup
        }
      }
    })
  );

  documentsApi.post(
    '/',
    Middlewares.asyncWrapper(async (req, res) => {
      const dataSet = req.body || {};

      // Entity resolution: a document belongs to exactly ONE of tenant /
      // building / owner. Tenant docs keep requiring leaseId (unchanged
      // legacy contract); building/owner docs carry neither.
      const entityCount = [
        dataSet.tenantId,
        dataSet.buildingId,
        dataSet.ownerKey
      ].filter(Boolean).length;
      if (entityCount !== 1) {
        logger.error('document requires exactly one of tenantId/buildingId/ownerKey');
        throw new ServiceError('missing fields', 422);
      }
      if (dataSet.tenantId && !dataSet.leaseId) {
        logger.error('missing lease Id to generate document');
        throw new ServiceError('missing fields', 422);
      }

      // Cross-realm guard: the entity ids came from the request body and
      // must be confirmed to belong to the authenticated realm. Without
      // this an attacker could mint a document referencing an entity from
      // a different realm — the create succeeds because realmId on the
      // doc itself is set from req.realm but the relationship rows would
      // dangle.
      const realmId = (req as any).realm._id;
      if (dataSet.tenantId) {
        const _tenantExists = await Collections.Tenant.exists({
          _id: dataSet.tenantId,
          realmId
        });
        if (!_tenantExists) {
          throw new ServiceError(
            'tenant not found in this organization',
            404
          );
        }
        const _leaseExists = await Collections.Lease.exists({
          _id: dataSet.leaseId,
          realmId
        });
        if (!_leaseExists) {
          throw new ServiceError(
            'lease not found in this organization',
            404
          );
        }
      }
      if (dataSet.buildingId) {
        const _buildingExists = await Collections.Building.exists({
          _id: dataSet.buildingId,
          realmId
        });
        if (!_buildingExists) {
          throw new ServiceError(
            'building not found in this organization',
            404
          );
        }
      }
      if (dataSet.ownerKey) {
        // Owners are embedded in buildings — verify the key resolves to at
        // least one unit owner in this realm (same canonical key the owners
        // pages use). Loipoi placeholders are not real entities.
        if (String(dataSet.ownerKey).startsWith('loipoi:')) {
          throw new ServiceError('cannot attach documents to a placeholder owner', 422);
        }
        const buildings: any[] = await Collections.Building.find(
          { realmId },
          { 'units.owners': 1 }
        ).lean();
        const found = buildings.some((b: any) =>
          (b.units || []).some((u: any) =>
            (u.owners || []).some(
              (o: any) => OwnerStatement.ownerKeyOf(o) === dataSet.ownerKey
            )
          )
        );
        if (!found) {
          throw new ServiceError(
            'owner not found in this organization',
            404
          );
        }
      }

      let template: any;
      if (dataSet.templateId) {
        template = await _getTempate((req as any).realm, dataSet.templateId);
        if (!template) {
          throw new ServiceError('template not found', 404);
        }
      }

      // Documents of type='file' do not need a template — they are direct
      // uploads (PDFs, images, etc). Only require type or templateId for
      // non-file documents. Without this branch the schema's required:true
      // on templateId would 500 every legitimate file upload.
      const incomingType = dataSet.type || template?.type;
      if (!incomingType) {
        throw new ServiceError('type or templateId required', 422);
      }
      if (incomingType !== 'file' && !dataSet.templateId && !template) {
        throw new ServiceError('templateId required for non-file documents', 422);
      }

      // A template with hasExpiryDate=true declares that this document expires.
      // Persisting it with NO expiryDate makes it count as PERMANENTLY
      // satisfying the requirement — occupantmanager's filesToUpload scan reads
      // a missing expiryDate as never-expires (`expiryDate ? … : true`), so the
      // expired scan never resurfaces as missing. Require the date the template
      // asked for. Scoped to a resolved fileDescriptor template, so the
      // template-less direct uploads (E9 / lease-PDF import, DocumentsPanel)
      // are unaffected.
      //
      // Deliberately NOT rejecting a PAST expiryDate: back-filing an
      // already-expired scan for the record is a legitimate workflow. The
      // landlord UI warns at entry instead.
      if (
        template &&
        template.type === 'fileDescriptor' &&
        template.hasExpiryDate === true
      ) {
        if (!dataSet.expiryDate) {
          throw new ServiceError(
            'expiryDate is required for this document template',
            422
          );
        }
      }
      // An unparseable expiryDate would reach the Date-typed schema field and
      // surface as an opaque Mongoose CastError 500. Validate explicitly.
      if (dataSet.expiryDate) {
        const _expiry = moment.utc(
          String(dataSet.expiryDate),
          ['YYYY-MM-DD', 'DD/MM/YYYY', moment.ISO_8601],
          true
        );
        if (!_expiry.isValid()) {
          throw new ServiceError(
            `expiryDate is not a valid date: ${String(dataSet.expiryDate)}`,
            422
          );
        }
      }

      const documentToCreate: any = {
        realmId: (req as any).realm._id,
        ...(dataSet.tenantId
          ? { tenantId: dataSet.tenantId, leaseId: dataSet.leaseId }
          : {}),
        ...(dataSet.buildingId ? { buildingId: dataSet.buildingId } : {}),
        ...(dataSet.ownerKey ? { ownerKey: dataSet.ownerKey } : {}),
        templateId: dataSet.templateId,
        type: dataSet.type || template.type,
        name: dataSet.name || template.name,
        description: dataSet.description || ''
      };

      if (documentToCreate.type === 'text') {
        documentToCreate.contents = '';
        documentToCreate.html = '';
        if (template) {
          const templateValues = await _getTemplateValues(
            (req as any).realm,
            dataSet.tenantId,
            dataSet.leaseId
          );

          documentToCreate.contents = _resolveTemplates(
            template.contents,
            templateValues
          );
        }
      }

      if (documentToCreate.type === 'file') {
        documentToCreate.mimeType = dataSet.mimeType || '';
        documentToCreate.expiryDate = dataSet.expiryDate || '';
        documentToCreate.url = dataSet.url || '';
        if (dataSet.versionId) {
          documentToCreate.versionId = dataSet.versionId;
        }
      }

      const createdDocument =
        await Collections.Document.create(documentToCreate);
      return res.status(201).json(createdDocument);
    })
  );

  documentsApi.patch(
    '/',
    Middlewares.asyncWrapper(async (req, res) => {
      const organizationId = (req as any).realm?._id;
      if (!organizationId) {
        throw new ServiceError('organization not resolved', 400);
      }
      if (!req.body._id) {
        logger.error('document id is missing');
        throw new ServiceError('missing fields', 422);
      }

      const incoming = req.body || {};

      // Trust the STORED type, not the incoming payload — otherwise a caller
      // can claim type='text' and slip through this guard while updating a
      // 'file' document. Fetch the doc first, scoped to the caller's realm.
      const stored = await Collections.Document.findOne({
        _id: incoming._id,
        realmId: organizationId
      });
      if (!stored) {
        throw new ServiceError('document not found', 404);
      }
      // 'text' documents accept full content edits; 'file' documents accept
      // METADATA-only edits (rename/description — the stored bytes and key
      // are immutable). Everything else stays 405.
      const storedType = (stored as any).type;
      if (storedType !== 'text' && storedType !== 'file') {
        throw new ServiceError('document cannot be modified', 405);
      }

      // Allowlist editable fields explicitly. Spreading the entire body let
      // a client overwrite realmId, type, tenantId, etc.
      const editable =
        storedType === 'text'
          ? (['name', 'description', 'contents', 'html'] as const)
          : (['name', 'description'] as const);
      const update: Record<string, unknown> = {};
      for (const field of editable) {
        if (Object.prototype.hasOwnProperty.call(incoming, field)) {
          update[field] = incoming[field];
        }
      }

      // Optimistic lock on Mongoose's __v. Without this, two tabs editing
      // the same template HTML simultaneously would both succeed and the
      // second write silently overwrites the first. Pass __v in the
      // filter; on mismatch findOneAndUpdate returns null and we raise a
      // 409 so the client can refresh and retry. The client also bumps
      // __v on every save so concurrent saves don't both think they hold
      // the latest version.
      const incomingV = Number((incoming as any).__v);
      const filter: Record<string, unknown> = {
        _id: incoming._id,
        realmId: organizationId
      };
      if (Number.isInteger(incomingV)) filter.__v = incomingV;

      const updatedDocument = await Collections.Document.findOneAndUpdate(
        filter,
        { $set: update, $inc: { __v: 1 } },
        { new: true }
      );

      if (!updatedDocument) {
        // Distinguish "not found" from "version mismatch". If the doc
        // still exists under our realm, this is a 409; otherwise a 404.
        const stillThere = await Collections.Document.exists({
          _id: incoming._id,
          realmId: organizationId
        });
        if (stillThere) {
          throw new ServiceError(
            'Document was edited elsewhere. Reload and try again.',
            409
          );
        }
        throw new ServiceError('document not found', 404);
      }

      return res.status(201).json(updatedDocument);
    })
  );

  documentsApi.delete(
    '/:ids',
    Middlewares.asyncWrapper(async (req, res) => {
      const organizationId = (req as any).realm?._id;
      if (!organizationId) {
        throw new ServiceError('organization not resolved', 400);
      }
      const documentIds = req.params.ids.split(',');

      // Wave-24 B12: cap bulk delete to prevent megaqueries.
      if (documentIds.length > 50) {
        throw new ServiceError(
          'document ids exceeds maximum of 50 items',
          422
        );
      }

      // Validate every id BEFORE the Mongoose query — without this a malformed
      // id (or a NoSQL probe) would surface as a CastError 500 inside $in.
      documentIds.forEach((id) => assertValidObjectId(id, 'document id'));

      // fetch documents
      const documents = await Collections.Document.find({
        _id: { $in: documentIds },
        realmId: organizationId
      });

      // delete documents from file systems
      // The previous `indexOf('..')` check missed URL-encoded variants
      // (`%2e%2e`) and mixed-separator escapes. Use the same path.resolve
      // guard the GET handler uses: resolve to absolute, then verify the
      // result stays inside UPLOADS_DIRECTORY. Drop anything that escapes.
      const uploadsRoot = path.resolve(UPLOADS_DIRECTORY as string);
      documents.forEach((doc: any) => {
        if (doc.type !== 'file') {
          return;
        }
        // Match the cleanup sweep — strip leading slash so a stored URL like
        // '/orgid/file.pdf' resolves under uploadsRoot rather than at the
        // filesystem root.
        const cleanUrl = String(doc.url || '').replace(/^\/+/, '');
        const resolved = path.resolve(uploadsRoot, cleanUrl);
        if (
          resolved !== uploadsRoot &&
          !resolved.startsWith(uploadsRoot + path.sep)
        ) {
          logger.warn(
            `refusing to delete file outside uploads root: ${doc.url}`
          );
          return;
        }
        if (fs.existsSync(resolved)) {
          fs.unlinkSync(resolved);
        }
      });

      // Delete S3 files BEFORE Mongo. If S3 fails, the documents stay
      // in Mongo with their URLs intact and the user gets a 502 — they
      // can retry without orphaned files. The reverse order (Mongo
      // first, then fire-and-forget S3) leaks storage every time S3 is
      // briefly unreachable, since the user has no way to find the
      // orphaned files once the Mongo records are gone.
      if (s3.isEnabled((req as any).realm.thirdParties?.b2)) {
        const urlsIds = documents
          .filter((doc: any) => doc.type === 'file')
          .map(({ url, versionId }: any) => ({ url, versionId }));

        if (urlsIds.length > 0) {
          try {
            await s3.deleteFiles(
              (req as any).realm.thirdParties.b2,
              urlsIds
            );
          } catch (err) {
            logger.error('error deleting files from s3', err);
            throw new ServiceError(
              'Failed to delete files from object storage. The document records have been kept; please retry.',
              502
            );
          }
        }
      }

      // delete documents from mongo
      const result = await Collections.Document.deleteMany({
        _id: { $in: documentIds },
        realmId: organizationId
      });

      if (!result.acknowledged) {
        throw new ServiceError('document not found', 404);
      }

      return res.sendStatus(204);
    })
  );

  return documentsApi;
}
