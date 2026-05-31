import { LuChevronLeft, LuChevronRight } from 'react-icons/lu';
import { useMemo, useState } from 'react';
import { Button } from './ui/button';
import { cn } from '../utils';
import moment from 'moment';

import useTranslation from 'next-translate/useTranslation';
export default function PeriodPicker({
  value,
  period = 'month',
  className,
  onChange
}) {
  const { t } = useTranslation('common');
  const [month, setMonth] = useState(value || moment());
  const format = useMemo(() => {
    let format = 'MMM YY';
    switch (period) {
      case 'year':
        format = 'YYYY';
        break;
      case 'week':
        format = 'w, YYYY';
        break;
      case 'day':
        format = 'D MMMM YYYY';
        break;
    }
    return format;
  }, [period]);

  const handlePreviousClick = () => {
    const newMoment = month.clone().subtract(1, period);
    setMonth(newMoment);
    onChange?.(newMoment);
  };

  const handleNextClick = () => {
    const newMoment = month.clone().add(1, period);
    setMonth(newMoment);
    onChange?.(newMoment);
  };

  return (
    <div
      className={cn('flex flex-col items-center uppercase gap-2', className)}
    >
      <span>{month.format(format)}</span>
      <div className="flex gap-2">
        <Button variant="secondary" size="icon" onClick={handlePreviousClick} aria-label={t('Previous')}>
          <LuChevronLeft className="size-4" />
        </Button>
        <Button variant="secondary" size="icon" onClick={handleNextClick} aria-label={t('Next')}>
          <LuChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}
