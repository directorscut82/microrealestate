import * as React from 'react';
import { cn } from '../../utils';
import { cva } from 'class-variance-authority';
import { Slot } from '@radix-ui/react-slot';

/*
 * Button — DESIGN.md Components / Buttons.
 *
 * Buttons are quiet. They sit at 40px height (default), 10px radius, ink-on-bone
 * for primary, hairline border for secondary. They never lift on hover; they
 * shift color. Primary action is one per screen.
 *
 * Variants:
 *   default      ink → sea-deep on hover (the primary action)
 *   secondary    bone with stone-line border, hover to cream (cancel/edit/export)
 *   ghost        transparent, hover cream (dense toolbars and table rows)
 *   destructive  bone with oxide border, hover to oxide-tint (delete/archive)
 *   outline      alias of secondary, kept for legacy callers
 *   link         underlined sea-blue text
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap rounded-md text-title font-medium transition-colors duration-base ease-out-quart focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sea focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        // Primary is an outline-style petrol button. Bone surface + petrol
        // border/text in default state; petrol fill + bone text on hover.
        // Quieter than any solid button at rest, distinct enough to read
        // as the screen's primary action.
        default:
          'bg-bone text-sea border border-sea hover:bg-sea hover:text-bone',
        destructive:
          'bg-bone text-oxide border border-oxide hover:bg-oxide-tint',
        outline: 'bg-bone text-ink border border-stone-line hover:bg-cream',
        secondary:
          'bg-bone text-ink border border-stone-line hover:bg-cream',
        ghost: 'text-ink-soft hover:bg-cream hover:text-ink',
        link: 'text-sea-deep underline-offset-4 hover:underline'
      },
      size: {
        default: 'h-10 px-[18px]',
        sm: 'h-8 rounded-md px-3 text-body',
        lg: 'h-11 rounded-md px-6',
        icon: 'h-10 w-10'
      }
    },
    defaultVariants: {
      variant: 'default',
      size: 'default'
    }
  }
);

const Button = React.forwardRef(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = 'Button';

export { Button, buttonVariants };
