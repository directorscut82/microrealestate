import * as React from 'react';
import { cn } from '../../utils';

/*
 * Input — DESIGN.md Components / Inputs.
 *
 * Bone surface, hairline border, 10px radius, 40px tall, 14px horizontal padding.
 * Focus shifts the border to sea and adds a 2px sea ring offset against cream.
 * No glow, no animation beyond a 120ms color transition.
 *
 * For currency inputs, pass `variant="numeric"` to switch to JetBrains Mono
 * with tabular numerals, right-aligned. The Tabular-Numeral Rule.
 */
const Input = React.forwardRef(
  ({ className, type, variant, step, ...props }, ref) => {
    const isNumeric = variant === 'numeric';
    // For type="number", default step="any" so decimal values are accepted.
    // Native HTML <input type="number"> defaults to step="1" which silently
    // rejects fractional input on most browsers — bites surface in m²,
    // monetary amounts, thousandths, etc. Callers can still override (e.g.
    // step="0.01" for currency or step="1" for whole-number-only fields).
    const effectiveStep = type === 'number' ? (step ?? 'any') : step;
    return (
      <input
        type={type}
        step={effectiveStep}
        className={cn(
          'flex h-10 w-full rounded-md border border-stone-line bg-bone px-3.5 py-2 text-body text-ink',
          'transition-colors duration-fast ease-out-quart',
          'placeholder:text-ink-muted',
          'file:border-0 file:bg-transparent file:text-body file:font-medium',
          'focus-visible:outline-none focus-visible:border-sea focus-visible:ring-2 focus-visible:ring-sea focus-visible:ring-offset-2 focus-visible:ring-offset-cream',
          'disabled:cursor-not-allowed disabled:opacity-60 disabled:bg-cream',
          'aria-[invalid=true]:border-oxide aria-[invalid=true]:focus-visible:ring-oxide',
          isNumeric && 'font-mono tabular-nums text-right',
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Input.displayName = 'Input';

export { Input };
