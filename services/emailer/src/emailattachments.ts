import * as Attachments from './emailparts/attachments/index.js';

export async function build(
  authorizationHeader: string | undefined,
  locale: string,
  organizationId: string,
  templateName: string,
  recordId: string,
  params: Record<string, any>,
  data: any
) {
  return await Attachments.build(
    authorizationHeader,
    locale,
    organizationId,
    templateName,
    recordId,
    params,
    data
  );
}
