import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { Service } from '@microrealestate/common';

export default function (
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
    fs.mkdirSync(fileDir);
  }
  const filePath = path.join(fileDir, filename);
  const wStream = fs.createWriteStream(filePath);

  return axios
    .get(uri, {
      responseType: 'stream',
      headers: {
        authorization: authorizationHeader,
        organizationid: organizationId
      }
    })
    .then((response) => {
      return new Promise<string>((resolve, reject) => {
        let isErrorOccured = false;
        wStream.on('error', (error) => {
          isErrorOccured = true;
          wStream.close();
          reject(error);
        });
        wStream.on('close', () => {
          if (!isErrorOccured) {
            resolve(filePath);
          }
        });
        response.data.pipe(wStream);
      });
    });
}
