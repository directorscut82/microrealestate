import * as PdfEngine from './engine/chromeheadless.js';
import { logger, Service } from '@microrealestate/common';
import dataPicker from './datapicker.js';
import ejs from 'ejs';
import fs from 'fs';
import { Mutex } from 'async-mutex';
import path from 'path';
import templateFunctions from './utils/templatefunctions.js';

const mutex = new Mutex();

const settings: Record<string, any> = {
  'view engine': ejs.renderFile,
  'pdf engine': PdfEngine
};

export function set(key: string, value: unknown) {
  settings[key] = value;
}

export async function start() {
  const { TEMPORARY_DIRECTORY, PDF_DIRECTORY } =
    Service.getInstance().envConfig.getValues();

  if (!fs.existsSync(PDF_DIRECTORY as string)) {
    fs.mkdirSync(PDF_DIRECTORY as string);
  }
  if (!fs.existsSync(TEMPORARY_DIRECTORY as string)) {
    fs.mkdirSync(TEMPORARY_DIRECTORY as string);
  }
  await settings['pdf engine'].start();
}

export async function exit() {
  const { TEMPORARY_DIRECTORY } = Service.getInstance().envConfig.getValues();
  fs.rmSync(TEMPORARY_DIRECTORY as string);
  await settings['pdf engine'].exit();
}

export async function generate(documentId: string, params: Record<string, string>): Promise<string> {
  const { TEMPLATES_DIRECTORY } = Service.getInstance().envConfig.getValues();

  const templateFile = path.join(TEMPLATES_DIRECTORY as string, `${documentId}.ejs`);
  if (!fs.existsSync(templateFile)) {
    logger.error(
      `cannot generate file for a not existing template ${templateFile}`
    );
    throw new Error(
      `cannot generate file for a not existing template ${templateFile}`
    );
  }

  return await mutex.runExclusive(async () => {
    const data = await dataPicker(documentId, params);
    const html = await settings['view engine'](
      templateFile,
      {
        ...data,
        _: templateFunctions({
          locale: data.landlord.locale,
          currency: data.landlord.currency
        })
      },
      { root: TEMPLATES_DIRECTORY }
    );

    return await settings['pdf engine'].generate(
      documentId,
      html,
      data.fileName
    );
  });
}
