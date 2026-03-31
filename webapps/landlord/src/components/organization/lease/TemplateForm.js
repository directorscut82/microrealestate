import { useCallback } from 'react';
import { Button } from '../../ui/button';
import { Separator } from '../../ui/separator';
import TemplateList from './TemplateList';
import useTranslation from 'next-translate/useTranslation';

function Section({ label, visible = true, children }) {
  if (!visible) return children;
  return (
    <div className="pb-10">
      <div className="text-xl">{label}</div>
      <Separator className="mt-1 mb-2" />
      {children}
    </div>
  );
}

export default function TemplateForm({ leaseId, onSubmit, stepperMode = false }) {
  const { t } = useTranslation('common');

  const handleNext = useCallback(() => {
    onSubmit();
  }, [onSubmit]);

  return (
    <>
      <Section label={t('Template documents')} visible={!stepperMode}>
        <TemplateList leaseId={leaseId} />
      </Section>
      {stepperMode ? (
        <Button onClick={handleNext} data-cy="submit">{t('Save')}</Button>
      ) : null}
    </>
  );
}
