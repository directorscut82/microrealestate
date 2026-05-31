import { getRentAmounts, RentAmount } from '../rents/RentDetails';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Button } from '../ui/button';
import { cn } from '../../utils';
import { LuChevronDown } from 'react-icons/lu';
import { Separator } from '../ui/separator';
import { useState } from 'react';
import useTranslation from 'next-translate/useTranslation';

function SelectRentItem({ rent, onClick }) {
  const { t } = useTranslation('common');
  const rentAmounts = rent ? getRentAmounts(rent) : null;

  // Remaining = max(0, totalAmount - payment). Surplus (overpaid) is
  // shown as a small badge, mirroring the rent-table column.
  const _gt = Number(rentAmounts?.totalAmount) || 0;
  const _pd = Number(rentAmounts?.payment) || 0;
  const _remaining = Math.max(0, Math.round((_gt - _pd) * 100) / 100);
  const _surplus = _pd > _gt ? Math.round((_pd - _gt) * 100) / 100 : 0;

  return (
    <div className="w-full">
      {rent?.occupant ? (
        <div
          className="grid grid-cols-1 md:grid-cols-2 items-center text-left"
          onClick={onClick}
        >
          <div>{rent.occupant.name}</div>
          <div className="flex md:grid md:grid-cols-3 items-center gap-2">
            <RentAmount
              label={t('Rent due')}
              amount={rentAmounts.totalAmount}
              withColor={false}
              debitColor={rentAmounts.totalAmount > 0}
            />
            <RentAmount
              label={t('Payment')}
              amount={rentAmounts.payment !== 0 ? rentAmounts.payment : null}
              withColor={true}
            />
            <div className="flex flex-col text-right min-w-0 leading-snug">
              <div className="text-label text-ink-muted truncate">
                {t('Remaining')}
              </div>
              <div className="text-label text-ink">
                {/* Inline number to keep the surplus badge aligned. */}
                <span className={_remaining > 0 ? 'font-bold text-oxide' : ''}>
                  {_remaining.toFixed(2)}
                </span>
              </div>
              {_surplus > 0 ? (
                <div className="text-[10px] text-olive whitespace-nowrap">
                  {t('+{{surplus}}€ credit', { surplus: _surplus.toFixed(2) })}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : (
        t('Select a rent')
      )}
    </div>
  );
}

export default function RentSelector({ value, rents, onChange, className }) {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);

  const handleOpen = () => {
    setOpen(open);
  };

  const handleChange = (rent) => {
    onChange(rent);
    setOpen(false);
  };

  if (!rents?.length) {
    return null;
  }

  return rents?.length > 1 ? (
    <Popover modal={true} open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          onClick={handleOpen}
          className={cn('flex w-full h-fit gap-2 bg-card px-4', className)}
        >
          <SelectRentItem rent={value} />
          <LuChevronDown />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="center"
        className="flex flex-col h-72 overflow-y-auto popover-content-width-same-as-its-trigger p-0"
      >
        {rents
          ?.sort(({ occupant: { name: n1 } }, { occupant: { name: n2 } }) => {
            n1.localeCompare(n2);
          })
          .map((rent) => {
            return (
              <div key={rent._id}>
                <div className="cursor-pointer py-2 pl-4 pr-12 hover:bg-primary/10">
                  <SelectRentItem
                    rent={rent}
                    onClick={() => handleChange(rent)}
                  />
                </div>
                <Separator />
              </div>
            );
          })}
      </PopoverContent>
    </Popover>
  ) : (
    <Button
      variant="outline"
      onClick={handleOpen}
      className={cn('w-full h-fit bg-card', className)}
    >
      <SelectRentItem rent={value} />
    </Button>
  );
}
