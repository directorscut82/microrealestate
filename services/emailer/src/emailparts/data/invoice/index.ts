import { Collections } from '@microrealestate/common';
import moment from 'moment';

export async function get(tenantId: string, params: Record<string, any>) {
  const dbTenant = await Collections.Tenant.findOne({ _id: tenantId })
    .populate('realmId')
    .populate('leaseId')
    .populate('properties.propertyId');
  if (!dbTenant) {
    throw new Error('tenant not found');
  }

  if (!dbTenant.rents.length) {
    throw new Error('term not found');
  }

  const tenant: any = dbTenant.toObject();
  const landlord = tenant.realmId;
  landlord.name =
    (landlord.isCompany
      ? landlord.companyInfo?.name
      : landlord.contacts?.[0]?.name) || '';
  landlord.hasCompanyInfo = !!landlord.companyInfo;
  landlord.hasBankInfo = !!landlord.bankInfo;
  landlord.hasAddress = !!landlord.addresses?.length;
  landlord.hasContact = !!landlord.contacts?.length;

  delete tenant.realmId;

  tenant.contract = {
    name: tenant.contract,
    lease: tenant.leaseId,
    beginDate: tenant.beginDate,
    endDate: tenant.endDate,
    properties: tenant.properties.reduce((acc: any[], { propertyId }: { propertyId: any }) => {
      acc.push(propertyId);
      return acc;
    }, [])
  };

  delete tenant.leaseId;

  tenant.rents = tenant.rents.filter(
    (rent: any) => rent.term === Number(params.term)
  );

  return {
    landlord,
    tenant,
    period: params.term,
    today: moment().format('DD/MM/YYYY')
  };
}
