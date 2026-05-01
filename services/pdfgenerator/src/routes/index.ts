import { Middlewares, Service } from '@microrealestate/common';
import documents from './documents.js';
import express from 'express';
import templates from './templates.js';

export default function () {
  const apiRoutes = express.Router();
  const secret = Service.getInstance().envConfig.getValues().ACCESS_TOKEN_SECRET;
  apiRoutes.use(Middlewares.needAccessToken(secret) as express.RequestHandler);
  apiRoutes.use(Middlewares.checkOrganization() as express.RequestHandler);
  apiRoutes.use('/templates', templates());
  apiRoutes.use('/documents', documents());

  const routes = express.Router();
  routes.use('/pdfgenerator', apiRoutes);
  return routes;
}
