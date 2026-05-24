import * as React from 'react';

import { cn } from '../../utils';

/*
 * Card — DESIGN.md Components / Cards.
 *
 * Cards are paper. Bone surface, 12px radius, 1px stone-line hairline border,
 * NO drop shadow at rest. Depth comes from the cream body lifting one tonal
 * step to bone. The Flat-Card Rule.
 *
 * Internal padding: 20px vertical, 24px horizontal.
 *
 * Variants:
 *   default  bone surface (the standard card)
 *   quiet    cream surface (when the card sits inside a bone region and
 *            should recede; the inverse of standard)
 */
const Card = React.forwardRef(({ className, variant, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      'rounded-lg border border-stone-line text-ink',
      variant === 'quiet' ? 'bg-cream' : 'bg-bone',
      className
    )}
    {...props}
  />
));
Card.displayName = 'Card';

const CardHeader = React.forwardRef(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn('flex flex-col gap-1.5 px-6 pt-5 pb-4', className)}
    {...props}
  />
));
CardHeader.displayName = 'CardHeader';

const CardTitle = React.forwardRef(({ className, ...props }, ref) => (
  <h3
    ref={ref}
    className={cn('text-title font-medium text-ink', className)}
    {...props}
  />
));
CardTitle.displayName = 'CardTitle';

const CardDescription = React.forwardRef(({ className, ...props }, ref) => (
  <p
    ref={ref}
    className={cn('text-body text-ink-muted', className)}
    {...props}
  />
));
CardDescription.displayName = 'CardDescription';

const CardContent = React.forwardRef(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('px-6 py-5', className)} {...props} />
));
CardContent.displayName = 'CardContent';

const CardFooter = React.forwardRef(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      'flex items-center px-6 pt-4 pb-5 border-t border-stone-line',
      className
    )}
    {...props}
  />
));
CardFooter.displayName = 'CardFooter';

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardDescription,
  CardContent
};
