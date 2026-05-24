import * as pdf from '../pdf.js';
import * as s3 from '../utils/s3.js';
import {
  Collections,
  Format,
  logger,
  Middlewares,
  Service,
  ServiceError
} from '@microrealestate/common';
import express from 'express';
import fs from 'fs-extra';
import Handlebars from 'handlebars';
import moment from 'moment';
import multer from 'multer';
import path from 'path';
import uploadMiddleware from '../utils/uploadmiddelware.js';

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
  req: express.Request,
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

function _resolveTemplates(element: any, templateValues: any): any {
  if (element.content) {
    element.content = element.content.map((childElement: any) =>
      _resolveTemplates(childElement, templateValues)
    );
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

  documentsApi.get(
    '/:document/:id/:term',
    Middlewares.asyncWrapper(async (req, res) => {
      try {
        logger.debug(`generate pdf file for ${JSON.stringify(req.params)}`);
        const realm = (req as any).realm;
        if (!realm?._id) {
          throw new ServiceError('organization required', 404);
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
        throw new ServiceError(error as Error, 404);
      }
    })
  );

  documentsApi.get(
    '/',
    Middlewares.asyncWrapper(async (req, res) => {
      const organizationId = req.headers.organizationid;

      const documentsFound = await Collections.Document.find({
        realmId: organizationId
      });
      if (!documentsFound) {
        throw new ServiceError('document not found', 404);
      }

      return res.status(200).json(documentsFound);
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
          logger.error('document url required');
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
          logger.error(`document url ${url} escapes uploads root`);
          throw new ServiceError('forbidden', 403);
        }

        // figure out mime + filename for safe download response
        const mimeType =
          (documentFound as any).mimeType || 'application/octet-stream';
        const safeName = path
          .basename(url)
          .replace(/[\r\n"]/g, '')
          .replace(/[^A-Za-z0-9._-]/g, '_');

        // first try to download from file system
        if (fs.existsSync(filePath)) {
          try {
            res.setHeader('Content-Type', mimeType);
            res.setHeader(
              'Content-Disposition',
              `attachment; filename="${safeName}"`
            );
            res.setHeader('X-Content-Type-Options', 'nosniff');
            return fs.createReadStream(filePath).pipe(res);
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
            res.setHeader(
              'Content-Disposition',
              `attachment; filename="${safeName}"`
            );
            res.setHeader('X-Content-Type-Options', 'nosniff');
            return s3
              .downloadFile((req as any).realm.thirdParties.b2, url)
              .pipe(res);
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
      const key = [req.body.s3Dir, req.body.fileName].join('/');
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

      if (!dataSet.tenantId) {
        logger.error('missing tenant Id to generate document');
        throw new ServiceError('missing fields', 422);
      }

      if (!dataSet.leaseId) {
        logger.error('missing lease Id to generate document');
        throw new ServiceError('missing fields', 422);
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

      const documentToCreate: any = {
        realmId: (req as any).realm._id,
        tenantId: dataSet.tenantId,
        leaseId: dataSet.leaseId,
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
      const organizationId = req.headers.organizationid;
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
      if ((stored as any).type !== 'text') {
        throw new ServiceError('document cannot be modified', 405);
      }

      // Allowlist editable fields explicitly. Spreading the entire body let
      // a client overwrite realmId, type, tenantId, etc.
      const update: Record<string, unknown> = {};
      for (const field of ['name', 'description', 'contents', 'html'] as const) {
        if (Object.prototype.hasOwnProperty.call(incoming, field)) {
          update[field] = incoming[field];
        }
      }

      const updatedDocument = await Collections.Document.findOneAndUpdate(
        {
          _id: incoming._id,
          realmId: organizationId
        },
        { $set: update },
        { new: true }
      );

      if (!updatedDocument) {
        throw new ServiceError('document not found', 404);
      }

      return res.status(201).json(updatedDocument);
    })
  );

  documentsApi.delete(
    '/:ids',
    Middlewares.asyncWrapper(async (req, res) => {
      const organizationId = req.headers.organizationid;
      const documentIds = req.params.ids.split(',');

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
        const resolved = path.resolve(uploadsRoot, doc.url);
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

      // delete document from s3
      if (s3.isEnabled((req as any).realm.thirdParties?.b2)) {
        const urlsIds = documents
          .filter((doc: any) => doc.type === 'file')
          .map(({ url, versionId }: any) => ({ url, versionId }));

        s3.deleteFiles((req as any).realm.thirdParties.b2, urlsIds).catch((err) => {
          logger.error('error deleting files from s3', err);
        });
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
