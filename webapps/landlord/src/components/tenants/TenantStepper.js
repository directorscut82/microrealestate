import BillingForm, {
  validate as BillingFormValidate
} from './forms/BillingForm';
import LeaseContractForm, {
  validate as LeaseContractFormValidate
} from './forms/LeaseContractForm';
import TenantForm, { validate as TenantFormValidate } from './forms/TenantForm';
import { useCallback, useContext, useState } from 'react';
import DocumentsForm from './forms/DocumentsForm';
import { Step, Stepper } from '../Stepper';
import { StoreContext } from '../../store';
import useTranslation from 'next-translate/useTranslation';

export default function TenantStepper({ onSubmit }) {
  const store = useContext(StoreContext);
  const { t } = useTranslation('common');
  const [activeStep, setActiveStep] = useState(0);

  const handleSubmit = useCallback(
    async (tenantPart) => {
      try {
        let isFormsValid = false;
        try {
          await TenantFormValidate(store.tenant?.selected);
          await LeaseContractFormValidate(store.tenant?.selected);
          await BillingFormValidate(store.tenant?.selected);
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
    [onSubmit, store.tenant?.selected, activeStep]
  );

  return (
    <Stepper activeStep={activeStep}>
      <Step stepLabel={t('Tenant information')}>
        <div className="px-2">
          <TenantForm onSubmit={handleSubmit} />
        </div>
      </Step>
      <Step stepLabel={t('Lease')}>
        <div className="px-2">
          <LeaseContractForm onSubmit={handleSubmit} />
        </div>
      </Step>
      <Step stepLabel={t('Billing information')}>
        <div className="px-2">
          <BillingForm onSubmit={handleSubmit} />
        </div>
      </Step>
      <Step stepLabel={t('Documents')}>
        <div className="px-2">
          <DocumentsForm onSubmit={handleSubmit} />
        </div>
      </Step>
    </Stepper>
  );
}
