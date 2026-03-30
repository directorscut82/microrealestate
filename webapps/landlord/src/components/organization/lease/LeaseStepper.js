import LeaseForm, { validate as LeaseFormValidate } from './LeaseForm';
import { useCallback, useState } from 'react';
import { Step, Stepper } from '../../Stepper';
import TemplateForm from './TemplateForm';
import useTranslation from 'next-translate/useTranslation';

export default function LeaseStepper({ lease, leases, onSubmit }) {
  const { t } = useTranslation('common');
  const [activeStep, setActiveStep] = useState(0);

  const handleSubmit = useCallback(
    async (leasePart = {}) => {
      try {
        let isFormsValid = false;
        try {
          await LeaseFormValidate(lease, leases);
          isFormsValid = activeStep >= 1;
        } catch (error) {
          console.log(error);
          isFormsValid = false;
        }
        await onSubmit({ ...leasePart, stepperMode: !isFormsValid });
        setActiveStep(activeStep + 1);
      } catch (error) {
        // do nothing on error
      }
    },
    [onSubmit, lease, leases, activeStep]
  );

  return (
    <Stepper activeStep={activeStep}>
      <Step stepLabel={t('Contract information')}>
        <div className="px-2">
          <LeaseForm lease={lease} leases={leases} onSubmit={handleSubmit} />
        </div>
      </Step>
      <Step stepLabel={t('Template documents')}>
        <div className="px-2">
          <TemplateForm onSubmit={handleSubmit} />
        </div>
      </Step>
    </Stepper>
  );
}
