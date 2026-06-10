import * as React from 'react';

import { cn } from '../../utils';

// Lightweight RadioGroup component used by the PDF-import-as-extension
// flow. We don't pull a Radix radio dependency for this single use site —
// native input[type=radio] is fully accessible and keyboard-navigable
// inside a fieldset / role=radiogroup wrapper, and our existing shadcn
// styling stack covers the focus / checked states with Tailwind.
const RadioGroup = React.forwardRef(
  ({ className, value, onValueChange, name, children, ...props }, ref) => {
    const groupName = React.useMemo(
      () => name || `radio-group-${Math.random().toString(36).slice(2, 9)}`,
      [name]
    );
    const childArray = React.Children.toArray(children).map((child) =>
      React.isValidElement(child)
        ? React.cloneElement(child, {
            name: groupName,
            checked: child.props.value === value,
            onChange: () => {
              if (typeof onValueChange === 'function') {
                onValueChange(child.props.value);
              }
            }
          })
        : child
    );
    return (
      <div
        ref={ref}
        role="radiogroup"
        className={cn('flex flex-col gap-2', className)}
        {...props}
      >
        {childArray}
      </div>
    );
  }
);
RadioGroup.displayName = 'RadioGroup';

const RadioGroupItem = React.forwardRef(
  ({ className, value, id, children, disabled, ...props }, ref) => {
    return (
      <label
        htmlFor={id}
        className={cn(
          'flex items-start gap-2 text-sm',
          disabled
            ? 'cursor-not-allowed opacity-60'
            : 'cursor-pointer',
          className
        )}
      >
        <input
          ref={ref}
          type="radio"
          id={id}
          value={value}
          disabled={disabled}
          className={cn(
            'mt-0.5 h-4 w-4 accent-primary',
            disabled ? 'cursor-not-allowed' : 'cursor-pointer'
          )}
          {...props}
        />
        <span className="flex-1">{children}</span>
      </label>
    );
  }
);
RadioGroupItem.displayName = 'RadioGroupItem';

export { RadioGroup, RadioGroupItem };
