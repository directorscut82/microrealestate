import { z } from 'zod';

export function applyZodTranslator(t) {
  z.setErrorMap((issue, ctx) => {
    if (issue.code === z.ZodIssueCode.invalid_type && issue.received === 'undefined') {
      return { message: t('Required') || ctx.defaultError };
    }
    if (issue.code === z.ZodIssueCode.too_small) {
      if (issue.type === 'string' && issue.minimum === 1) {
        return { message: t('Required') || ctx.defaultError };
      }
      return { message: t('Too short') || ctx.defaultError };
    }
    if (issue.code === z.ZodIssueCode.too_big) {
      return { message: t('Too long') || ctx.defaultError };
    }
    if (issue.code === z.ZodIssueCode.invalid_string && issue.validation === 'email') {
      return { message: t('Invalid email') || ctx.defaultError };
    }
    if (issue.code === z.ZodIssueCode.invalid_string && issue.validation === 'regex') {
      return { message: t('Invalid format') || ctx.defaultError };
    }
    return { message: ctx.defaultError };
  });
}
