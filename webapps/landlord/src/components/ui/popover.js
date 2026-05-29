import * as PopoverPrimitive from '@radix-ui/react-popover';
import * as React from 'react';

import { cn } from '../../utils';

/*
 * Popover — DESIGN.md Elevation / floating shadow.
 *
 * Bone surface, hairline border, two-stop floating shadow, 12px radius.
 * Lift means the element is structurally above the page.
 */

const Popover = PopoverPrimitive.Root;

const PopoverTrigger = PopoverPrimitive.Trigger;

const PopoverContent = React.forwardRef(
  ({ className, align = 'center', sideOffset = 6, ...props }, ref) => (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={ref}
        align={align}
        sideOffset={sideOffset}
        // Wave-26 round-3b: when a Popover lives inside a Vaul Drawer (e.g.
        // the date-picker inside the payment-recording dialog), Vaul's
        // pointerdown drag handler intercepts clicks on portaled-popover
        // contents and the click registers on whatever sits underneath
        // instead of on the calendar day. `data-vaul-no-drag` opts the
        // popover subtree out of Vaul's drag interaction, restoring normal
        // click handling for date cells, buttons, etc.
        data-vaul-no-drag
        className={cn(
          'z-50 w-72 rounded-lg border border-stone-line bg-bone p-4 text-ink shadow-floating outline-none',
          'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
          'data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1',
          className
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
);
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverTrigger, PopoverContent };
