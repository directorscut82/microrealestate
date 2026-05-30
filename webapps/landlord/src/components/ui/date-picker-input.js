import * as React from 'react';
import { LuCalendar, LuInfo } from 'react-icons/lu';
import moment from 'moment';
import { Button } from './button';
import { Calendar } from './calendar';
import { cn } from '../../utils';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import useTranslation from 'next-translate/useTranslation';

/**
 * DatePickerInput — consistent calendar picker across all browsers/locales.
 *
 * Replaces native `<input type="date">` which renders inconsistently
 * (e.g., Safari iOS shows plain text, Chromium shows mini calendar, Greek
 * locale flips order). Stores values in DD/MM/YYYY string format to match
 * the existing API contract.
 *
 * Use with react-hook-form via `register('field')`-equivalent: pass
 * `value` and `onChange` from the form, or wrap in a Controller.
 */
export function DatePickerInput({
  value,
  onChange,
  placeholder = 'DD/MM/YYYY',
  format = 'DD/MM/YYYY',
  disabled,
  id,
  className,
  // Wave-26 round-3l: when true, the popover footer renders a brief
  // help note explaining what the payment date means vs. the rent
  // term. Only the payment dialog opts in (set in PaymentTabs).
  paymentContext = false
}) {
  const { t } = useTranslation('common');
  const parsed = React.useMemo(() => {
    if (!value) return null;
    // Accept both DD/MM/YYYY (canonical) and ISO 8601.
    const m =
      moment(value, format, true).isValid()
        ? moment(value, format, true)
        : moment(value);
    return m.isValid() ? m.toDate() : null;
  }, [value, format]);

  const display = parsed ? moment(parsed).format(format) : '';
  const [open, setOpen] = React.useState(false);

  return (
    // `modal` is required when this DatePickerInput lives inside a Vaul
    // Drawer (e.g., the payment-recording dialog). Vaul sets
    // `pointer-events: none` on <body> while the drawer is open, and
    // because Radix portals the popover to document.body the calendar
    // inherits that and clicks fall through to the drawer's dialog
    // layer beneath. `modal=true` makes Radix render its own focus
    // layer with its own pointer-event context, so calendar day clicks
    // land on the actual day. Outside this case `modal` is harmless.
    // Refs: shadcn-ui/ui#7652, vaul#482.
    <Popover modal open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          disabled={disabled}
          className={cn(
            'w-full justify-start text-left font-normal',
            !value && 'text-muted-foreground',
            className
          )}
        >
          <LuCalendar className="mr-2 size-4 shrink-0" />
          <span>{display || placeholder}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={parsed || undefined}
          onSelect={(d) => {
            if (d) {
              onChange?.(moment(d).format(format));
              setOpen(false);
            }
          }}
          initialFocus
        />
        {paymentContext && (
          <div className="border-t border-stone-line/60 px-3 py-2 max-w-[20rem] text-xs text-ink-muted leading-snug">
            <div className="flex items-start gap-2">
              <LuInfo className="size-3.5 mt-0.5 shrink-0" />
              <div className="space-y-1.5">
                <div>
                  {t(
                    'This date is when the cash actually changed hands. The rent month is set by the page you opened — it cannot be changed here.'
                  )}
                </div>
                <ul className="space-y-1">
                  <li>
                    <strong className="text-ink">
                      {t('Prepayment')}:
                    </strong>{' '}
                    {t(
                      'tenant pays in advance — pick a future date (up to +7 days from today).'
                    )}
                  </li>
                  <li>
                    <strong className="text-ink">
                      {t('Late entry')}:
                    </strong>{' '}
                    {t(
                      'cash was received earlier but you are recording it now — pick a date within this rent month.'
                    )}
                  </li>
                  <li>
                    <strong className="text-ink">
                      {t('Different rent month')}:
                    </strong>{' '}
                    {t(
                      'close this dialog and open the corresponding month from the rents page first.'
                    )}
                  </li>
                </ul>
              </div>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

export default DatePickerInput;
