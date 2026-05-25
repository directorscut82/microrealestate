import * as React from 'react';
import { LuCalendar } from 'react-icons/lu';
import moment from 'moment';
import { Button } from './button';
import { Calendar } from './calendar';
import { cn } from '../../utils';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

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
  className
}) {
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
    <Popover open={open} onOpenChange={setOpen}>
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
      </PopoverContent>
    </Popover>
  );
}

export default DatePickerInput;
