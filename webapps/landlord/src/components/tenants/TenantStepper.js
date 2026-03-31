import BillingForm, {
  validate as BillingFormValidate
} from './forms/BillingForm';
import LeaseContractForm, {
  validate as LeaseContractFormValidate
} from './forms/LeaseContractForm';
import TenantForm, { validate as TenantFormValidate } from './forms/TenantForm';
import { useCallback, useState } from 'react';
import DocumentsForm from './forms/DocumentsForm';
import { Step, Stepper } from '../Stepper';
import useTranslation from 'next-translate/useTranslation';

export default function TenantStepper({ tenant, leases, properties, organization, onSubmit }) {
  const { t } = useTranslation('common');
  const [activeStep, setActiveStep] = useState(0);

  const handleSubmit = useCallback(
    async (tenantPart) => {
      try {
        let isFormsValid = false;
        try {
          await TenantFormValidate(tenant);
          await LeaseContractFormValidate(tenant);
          await BillingFormValidate(tenant);
          isFormsValid = activeStep >= 3;
        } catch (error) {
          console.log(error);
          isFormsValid = false;
        }
        await onSubmit({ ...tenantPart, stepperMode: !isFormsValid });
        setActiveStep(activeStep + 1);
      } catch (error) {
        // do nothing on error
      }
    },
    [onSubmit, tenant, activeStep]
  );

  return (
    <Stepper activeStep={activeStep}>
      <Step stepLabel={t('Tenant information')}>
        <div className="px-2">
          <TenantForm tenant={tenant} onSubmit={handleSubmit} />
        </div>
      </Step>
      <Step stepLabel={t('Lease')}>
        <div className="px-2">
          <LeaseContractForm tenant={tenant} leases={leases} properties={properties} onSubmit={handleSubmit} />
        </div>
      </Step>
      <Step stepLabel={t('Billing information')}>
        <div className="px-2">
          <BillingForm tenant={tenant} organization={organization} onSubmit={handleSubmit} />
        </div>
      </Step>
      <Step stepLabel={t('Documents')}>
        <div className="px-2">
          <DocumentsForm tenant={tenant} onSubmit={handleSubmit} />
        </div>
      </Step>
    </Stepper>
  );
}
