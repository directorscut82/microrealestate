import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _dataDir = path.join(__dirname, 'emailparts', 'data');

export async function build(
  templateName: string,
  recordId: string,
  params: Record<string, any>
): Promise<any> {
  let dataPackagePath = path.join(_dataDir, templateName, 'index.js');
  if (!fs.existsSync(dataPackagePath)) {
    dataPackagePath = path.join(_dataDir, templateName, 'index.ts');
  }

  if (!fs.existsSync(dataPackagePath)) {
    return {};
  }

  const data = await import(dataPackagePath);
  return await data.get(recordId, params);
}
