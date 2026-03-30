import { useCallback, useContext } from 'react';
import { Button } from '../../ui/button';
import { Separator } from '../../ui/separator';

function Section({ label, children }) {
  return (
    <div className="pb-10">
      <div className="text-xl">{label}</div>
      <Separator className="mt-1 mb-2" />
      {children}
    </div>
  );
}
import { StoreContext } from '../../../store';
import TemplateList from './TemplateList';
import useTranslation from 'next-translate/useTranslation';

export default function TemplateForm({ onSubmit }) {
  const store = useContext(StoreContext);
  const { t } = useTranslation('common');

  const handleNext = useCallback(() => {
    onSubmit();
  }, [onSubmit]);

  return (
    <>
      <Section
        label={t('Template documents')}
        visible={!store.lease.selected.stepperMode}
      >
        <TemplateList />
      </Section>
      {store.lease?.selected.stepperMode ? (
        <Button onClick={handleNext} data-cy="submit">
          {t('Save')}
        </Button>
      ) : null}
    </>
  );
}
