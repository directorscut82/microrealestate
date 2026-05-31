import {
  Collections,
  logger,
  Middlewares,
  Service,
  ServiceError
} from '@microrealestate/common';
import express, { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';

// Wave-24 A9+B12: ObjectId guard + bulk-delete cap. We intentionally avoid a
// shared validators import so pdfgenerator has no api-package dependency.
const OBJECT_ID_RE = /^[a-fA-F0-9]{24}$/;
function _assertObjectId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !OBJECT_ID_RE.test(value)) {
    throw new ServiceError(`invalid ${name}`, 422);
  }
  return value;
}
const MAX_BULK_DELETE = 50;

/**
 * route: /templates
 */
const _checkTemplateParameters = ({
  name,
  type,
  hasExpiryDate,
  contents,
  html
}: Record<string, any>): string[] => {
  const errors: string[] = [];
  if (!name) {
    errors.push('template name is missing');
  }
  if (!type) {
    errors.push('template type is missing');
  }
  if (type === 'text') {
    if (!contents) {
      errors.push('template content is missing');
    }
    if (!html) {
      errors.push('template html is missing');
    }
  } else if (type === 'fileDescriptor') {
    if (hasExpiryDate === undefined) {
      errors.push('template hasExpiryDate is missing');
    }
  }
  return errors;
};

export default function () {
  const { TEMPLATES_DIRECTORY } = Service.getInstance().envConfig.getValues();
  const FIELDS = JSON.parse(
    fs.readFileSync(path.join(TEMPLATES_DIRECTORY as string, 'fields.json'), 'utf-8')
  );
  const templatesApi = express.Router();

  templatesApi.get('/fields', (req: Request, res: Response) => {
    res.status(200).json(FIELDS);
  });

  templatesApi.get(
    '/',
    Middlewares.asyncWrapper(async (req, res) => {
      const organizationId = (req as any).realm?._id;
      if (!organizationId) {
        throw new ServiceError('organization not resolved', 400);
      }

      const templatesFound = await Collections.Template.find({
        realmId: organizationId
      });
      if (!templatesFound) {
        throw new ServiceError('templates not found', 404);
      }

      res.status(200).json(templatesFound);
    })
  );

  templatesApi.get(
    '/:id',
    Middlewares.asyncWrapper(async (req, res) => {
      const templateId = req.params.id;

      if (!templateId) {
        logger.error('missing template id field');
        throw new ServiceError('missing fields', 422);
      }

      const templateFound = await Collections.Template.findOne({
        _id: templateId,
        realmId: (req as any).realm._id
      });

      if (!templateFound) {
        throw new ServiceError('template not found', 404);
      }

      res.status(200).json(templateFound);
    })
  );

  templatesApi.post(
    '/',
    Middlewares.asyncWrapper(async (req, res) => {
      const organizationId = (req as any).realm?._id;
      if (!organizationId) {
        throw new ServiceError('organization not resolved', 400);
      }

      const errors = _checkTemplateParameters(req.body);
      if (errors.length) {
        logger.error(errors.join('\n'));
        throw new ServiceError('missing fields', 422);
      }

      const {
        name,
        type,
        description = '',
        hasExpiryDate,
        contents,
        html,
        linkedResourceIds,
        required,
        requiredOnceContractTerminated
      } = req.body || {};
      const createdTemplate = await Collections.Template.create({
        realmId: organizationId,
        name,
        type,
        description,
        hasExpiryDate,
        contents,
        html,
        linkedResourceIds,
        required,
        requiredOnceContractTerminated
      });

      res.status(201).json(createdTemplate);
    })
  );

  templatesApi.patch(
    '/',
    Middlewares.asyncWrapper(async (req, res) => {
      // Use the realm validated by checkOrganization middleware, NOT
      // the raw header. The middleware already proved the caller is
      // authorised for this realm; trusting the header directly mixes
      // raw transport input with authorisation state.
      const realmId = (req as any).realm?._id;
      if (!realmId) {
        throw new ServiceError('organization not resolved', 400);
      }

      let errors = _checkTemplateParameters(req.body);
      if (!req.body._id) {
        errors = ['template id is missing', ...errors];
      }
      if (errors.length) {
        logger.error(errors.join('\n'));
        throw new ServiceError('missing fields', 422);
      }

      const template = req.body || {};
      _assertObjectId(template._id, 'template id');

      // Wave-24 A9: findOneAndReplace silently wipes any field the caller
      // forgot to include in the PATCH body (linkedResourceIds, html, etc.).
      // Switch to findOneAndUpdate({$set: ...}) and strip server-owned
      // identity fields from the $set payload to avoid Mongo's "Updating
      // the path '_id' would create a conflict" error.
      // eslint-disable-next-line no-unused-vars
      const { _id, __v, realmId: _realmId, ...rest } = template as any;
      const updatedTemplate = await Collections.Template.findOneAndUpdate(
        {
          _id: template._id,
          realmId
        },
        { $set: rest },
        { new: true }
      );

      if (!updatedTemplate) {
        throw new ServiceError('template not found', 404);
      }

      res.status(201).json(updatedTemplate);
    })
  );

  templatesApi.delete(
    '/:ids',
    Middlewares.asyncWrapper(async (req, res) => {
      const organizationId = (req as any).realm?._id;
      if (!organizationId) {
        throw new ServiceError('organization not resolved', 400);
      }
      const templateIds = req.params.ids.split(',');
      // Wave-24 B12: cap bulk delete + validate every id.
      if (templateIds.length > MAX_BULK_DELETE) {
        throw new ServiceError(
          `template ids exceeds maximum of ${MAX_BULK_DELETE} items`,
          422
        );
      }
      templateIds.forEach((id) => _assertObjectId(id, 'template id'));
      const result = await Collections.Template.deleteMany({
        _id: { $in: templateIds },
        realmId: organizationId
      });

      if (!result.acknowledged) {
        throw new ServiceError('template not found', 404);
      }

      res.sendStatus(204);
    })
  );

  return templatesApi;
}
