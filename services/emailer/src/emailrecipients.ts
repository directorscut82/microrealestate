import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function build(
  locale: string,
  templateName: string,
  recordId: string,
  params: Record<string, any>,
  data: any
): Promise<any[]> {
  const recipientsPackagePath = path.join(
    __dirname,
    'emailparts',
    'recipients',
    templateName,
    'index.js'
  );
  if (!fs.existsSync(recipientsPackagePath)) {
    return [];
  }

  const recipients = await import(recipientsPackagePath);
  return await recipients.get(recordId, params, data);
}
