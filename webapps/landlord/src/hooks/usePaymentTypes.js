import { useMemo } from 'react';
import useTranslation from 'next-translate/useTranslation';

export default function usePaymentTypes() {
  const { t } = useTranslation('common');

  return useMemo(() => {
    // Wave-26 round-3g: 'levy' (Εισφορά) was a copy from the original
    // upstream and never made sense for residential rentals — removed
    // from the dropdown. The data-side enum still accepts it so legacy
    // payment records render their type label correctly via itemMap.
    //
    // 'import' is a not-yet-built feature placeholder — disabled in the
    // dropdown but visible so the landlord knows it's coming.
    const itemList = [
      {
        id: 'cash',
        label: t('Cash'),
        value: 'cash'
      },
      {
        id: 'transfer',
        label: t('Transfer (bank)'),
        value: 'transfer'
      },
      {
        id: 'cheque',
        label: t('Cheque'),
        value: 'cheque'
      },
      {
        id: 'import',
        label: t('Import from file (soon)'),
        value: 'import',
        disabled: true
      }
    ];

    return {
      itemList,
      itemMap: itemList.reduce((acc, { id, label, value }) => {
        acc[id] = { label, value };
        return acc;
      }, {})
    };
  }, [t]);
}
