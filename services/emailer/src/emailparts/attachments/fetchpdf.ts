import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { Service } from '@microrealestate/common';

export default async function (
  authorizationHeader: string | undefined,
  organizationId: string,
  templateName: string,
  recordId: string,
  params: Record<string, any>,
  filename: string
): Promise<string> {
  const { PDFGENERATOR_URL, TEMPORARY_DIRECTORY } =
    Service.getInstance().envConfig.getValues();
  const uri = `${PDFGENERATOR_URL}/documents/${templateName}/${recordId}/${params.term}`;
  const fileDir = path.join(TEMPORARY_DIRECTORY as string, templateName);
  if (!fs.existsSync(fileDir)) {
    fs.mkdirSync(fileDir, { recursive: true });
  }
  const filePath = path.join(fileDir, filename);

  // Stream pipe gave us a "close" event on any HTTP outcome — including
  // an HTML error page that Mongoose then handed off as a "PDF". Switch
  // to arraybuffer + magic-byte sniff so we fail fast and loud on the
  // upstream instead of mailing a fake PDF to the customer.
  const response = await axios.get(uri, {
    responseType: 'arraybuffer',
    timeout: 30000,
    // Don't let axios throw on 4xx/5xx — we want to surface a clear error.
    validateStatus: () => true,
    headers: {
      authorization: authorizationHeader,
      organizationid: organizationId
    }
  });

  if (response.status !== 200) {
    throw new Error(`PDF fetch HTTP ${response.status} for ${uri}`);
  }
  const buf = Buffer.from(response.data);
  if (buf.length < 4 || buf.slice(0, 4).toString() !== '%PDF') {
    throw new Error(`fetched file is not a valid PDF (${uri})`);
  }
  fs.writeFileSync(filePath, buf);
  return filePath;
}
