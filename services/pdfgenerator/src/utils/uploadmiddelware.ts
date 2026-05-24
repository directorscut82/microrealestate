import { sanitize, sanitizePath } from './index.js';
import fs from 'fs-extra';
import multer from 'multer';
import os from 'os';
import path from 'path';
import { logger, Service } from '@microrealestate/common';
import type { NextFunction, Request, Response } from 'express';

export default function () {
  const { UPLOAD_MAX_SIZE, UPLOADS_DIRECTORY } =
    Service.getInstance().envConfig.getValues();

  const SUPPORTED_FILE_EXTENSIONS: Record<string, string> = {
    'image/gif': 'gif',
    'image/png': 'png',
    'image/jpeg': 'jpeg',
    'image/jpg': 'jpg',
    'image/jpe': 'jpe',
    'application/pdf': 'pdf'
  };

  const SUPPORTED_MIMETYPES = Object.keys(SUPPORTED_FILE_EXTENSIONS);

  // Magic-byte signatures for the formats we accept. The client-supplied
  // mimetype is trivially spoofable, so we additionally inspect the first
  // bytes of the saved file and reject mismatches.
  type Signature = { bytes: number[]; offset?: number };
  const MAGIC_SIGNATURES: Record<string, Signature[]> = {
    'image/gif': [
      { bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] }, // GIF87a
      { bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] } // GIF89a
    ],
    'image/png': [
      { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }
    ],
    'image/jpeg': [{ bytes: [0xff, 0xd8, 0xff] }],
    'image/jpg': [{ bytes: [0xff, 0xd8, 0xff] }],
    'image/jpe': [{ bytes: [0xff, 0xd8, 0xff] }],
    'application/pdf': [{ bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }] // %PDF-
  };

  function matchesSignature(buf: Buffer, mimeType: string): boolean {
    const sigs = MAGIC_SIGNATURES[mimeType];
    if (!sigs) return false;
    return sigs.some(({ bytes, offset = 0 }) => {
      if (buf.length < offset + bytes.length) return false;
      for (let i = 0; i < bytes.length; i++) {
        if (buf[offset + i] !== bytes[i]) return false;
      }
      return true;
    });
  }

  const storage = multer.diskStorage({
    destination: function (req: any, file: any, cb: any) {
      const realm = (req as any).realm;
      const orgName = sanitize(realm.name);
      const orgId = sanitize(realm._id);
      let s3Dir = `${orgName}-${orgId}`;
      let localDir = path.join(UPLOADS_DIRECTORY as string, `${orgName}-${orgId}`);

      if (req.body.folder) {
        const folder = sanitizePath(req.body.folder);
        localDir = path.join(localDir, folder);
        req.body.localDir = localDir;

        s3Dir = path.join(s3Dir, folder);
        if (os.platform() === 'win32') {
          s3Dir = s3Dir.replace(/\\/g, '/');
        }
        req.body.s3Dir = s3Dir;
      }

      fs.ensureDirSync(localDir);
      cb(null, localDir);
    },
    filename: function (req: any, file: any, cb: any) {
      if (!SUPPORTED_MIMETYPES.includes(file.mimetype)) {
        return cb(new Error('file not supported'), '');
      }
      const fileNameNoExt = req.body.fileName || 'noname';
      const suffix = Math.round(Math.random() * 1e9);
      const extension = SUPPORTED_FILE_EXTENSIONS[file.mimetype];
      const fileName = sanitize(`${fileNameNoExt}-${suffix}.${extension}`);
      req.body.fileName = fileName;
      cb(null, fileName);
    }
  });

  const multerHandler = multer({
    storage: storage,
    limits: { fileSize: UPLOAD_MAX_SIZE as number }
  }).single('file');

  // Wrap multer to add a post-upload magic-byte sniff. If the bytes do not
  // match the declared mimetype we delete the saved file and return 415 so
  // a renamed `evil.exe` claiming to be `image/png` cannot land on disk.
  return function uploadWithMagicCheck(
    req: Request,
    res: Response,
    next: NextFunction
  ) {
    multerHandler(req, res, (err: any) => {
      if (err) return next(err);
      const file: any = (req as any).file;
      if (!file?.path) return next();
      try {
        const fd = fs.openSync(file.path, 'r');
        const buf = Buffer.alloc(8);
        const read = fs.readSync(fd, buf, 0, 8, 0);
        fs.closeSync(fd);
        const head = buf.slice(0, read);
        if (!matchesSignature(head, file.mimetype)) {
          try {
            fs.removeSync(file.path);
          } catch {
            // best effort
          }
          logger.warn(
            `rejected upload: mimetype=${file.mimetype} did not match magic bytes`
          );
          return res
            .status(415)
            .json({ message: 'file content does not match declared type' });
        }
      } catch (sniffErr) {
        logger.error('magic byte sniff failed', sniffErr);
        try {
          fs.removeSync(file.path);
        } catch {
          // best effort
        }
        return res.status(500).json({ message: 'upload validation failed' });
      }
      return next();
    });
  };
}
