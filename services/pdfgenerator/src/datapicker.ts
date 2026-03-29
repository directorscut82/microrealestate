import path from 'path';
import { Service } from '@microrealestate/common';

export default async function (templateId: string, params: Record<string, string>) {
  const { DATA_DIRECTORY } = Service.getInstance().envConfig.getValues();
  const data = await import(path.join(DATA_DIRECTORY as string, templateId, 'index.js'));
  return await data.get(params);
}
