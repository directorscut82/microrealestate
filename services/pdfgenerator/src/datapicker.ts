import path from 'path';
import { Service } from '@microrealestate/common';

export default async function (templateId: string, params: Record<string, string>) {
  const { DATA_DIRECTORY } = Service.getInstance().envConfig.getValues();
  const data = await import(path.join(DATA_DIRECTORY as string, templateId, 'index.js'));
  // Wave-26 round-3v: thread the templateId through so the shared
  // getRentsData() can decide whether to include rent.charges (rent-call)
  // or omit it (invoice/receipt). Each per-template index.js forwards
  // documentId into utils.getRentsData(params, documentId).
  return await data.get(params, templateId);
}
