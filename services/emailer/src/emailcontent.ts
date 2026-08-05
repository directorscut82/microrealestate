import ejs from 'ejs';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';
import { Service } from '@microrealestate/common';
import templateFunctions from './utils/templatefunctions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _templatesDir = path.join(__dirname, 'emailparts', 'contents');

function _renderFile(templateFile: string, data: any): Promise<string> {
  return new Promise((resolve, reject) => {
    ejs.renderFile(templateFile, data, { root: _templatesDir }, (err: any, html: any) => {
      if (err) {
        return reject(err);
      }
      resolve(html);
    });
  });
}

// The i18n library renders every `{{placeholder}}` through Mustache
// (node_modules/i18n/i18n.js:621), and Mustache HTML-escapes by default. Measured
// with the real library: `/ ' & < >` all become entities, so a date interpolated
// into any notification came out as `07&#x2F;08&#x2F;2026` and a name like O'Neil
// as `O&#39;Neil`. In the HTML body that decodes and is INVISIBLE; in the
// plain-text body — which every mail client shows when HTML is off, and which is
// what SMS/Telegram fall back to — the raw entities are shown to the tenant.
//
// The escaping cannot simply be disabled (i18n's mustacheConfig.disable): the
// HTML templates interpolate tenant-supplied names through `<%-` (raw EJS), so
// Mustache's escaping is the only thing standing between a tenant name and
// markup injection into the email body. So decode in the TEXT path only, where
// entities have no meaning and no protective value.
const _TEXT_ENTITIES: Record<string, string> = {
  '&#x2F;': '/',
  '&#39;': "'",
  '&#x27;': "'",
  '&quot;': '"',
  '&lt;': '<',
  '&gt;': '>',
  '&nbsp;': ' ',
  // &amp; LAST: decoding it first would let "&amp;lt;" become "<".
  '&amp;': '&'
};

function _decodeTextEntities(input: string): string {
  let out = String(input);
  for (const [entity, char] of Object.entries(_TEXT_ENTITIES)) {
    out = out.split(entity).join(char);
  }
  return out;
}

export async function build(
  locale: string,
  currency: string,
  templateName: string,
  recordId: string,
  params: Record<string, any>,
  emailData: any
): Promise<{ subject: string; text: string; html: string }> {
  const contentPackagePath = path.join(_templatesDir, templateName);

  if (!fs.existsSync(contentPackagePath)) {
    throw new Error(
      `cannot generate email content for ${templateName}. Template not found`
    );
  }

  const data = {
    ...emailData,
    config: Service.getInstance().envConfig.getValues(),
    _: templateFunctions({ locale, currency })
  };
  const subject = await _renderFile(
    path.join(contentPackagePath, 'subject.ejs'),
    data
  );
  const html = await _renderFile(
    path.join(contentPackagePath, 'body_html.ejs'),
    data
  );
  const text = await _renderFile(
    path.join(contentPackagePath, 'body_text.ejs'),
    data
  );
  // subject is plain text too — it reaches the inbox list unrendered.
  return {
    subject: _decodeTextEntities(subject),
    text: _decodeTextEntities(text),
    html
  };
}
