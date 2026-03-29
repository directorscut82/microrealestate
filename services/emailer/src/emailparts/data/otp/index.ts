import { Collections } from '@microrealestate/common';

export async function get(email: string, params: Record<string, any>) {
  const dbTenant = await Collections.Tenant.findOne({
    'contacts.email': email
  }).populate('realmId');
  if (!dbTenant) {
    throw new Error('email not found as tenant contact');
  }

  const landlord = (dbTenant as any).realmId.toObject();

  return {
    landlord,
    otp: params.otp,
    useAppEmailService: true
  };
}
