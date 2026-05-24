import * as React from 'react';
import { cn } from '../../utils';
import { cva } from 'class-variance-authority';

/*
 * Alert / Callout — full-border tinted surface. NEVER a side-stripe border
 * (the absolute ban). Variants tint the entire surface so the alert reads
 * as paper, not as a sticker on top of paper.
 *
 * default      stone-line border on cream surface, ink text
 * destructive  oxide border on oxide-tint surface, ink text + oxide icon
 * warning      same as destructive (one warning color in the system)
 * success      olive border on olive-tint surface, ink text + olive icon
 * info         sea border on sea-tint surface, ink text + sea icon
 *
 * Body text always uses ink so colored tints never sacrifice legibility,
 * especially for Greek text where small-caps and accents are unforgiving
 * with low-contrast color-on-color.
 */
const alertVariants = cva(
  'relative w-full rounded-lg border p-5 text-body text-ink [&>svg~*]:pl-7 [&>svg+div]:translate-y-[-3px] [&>svg]:absolute [&>svg]:left-5 [&>svg]:top-5 [&>svg]:size-4',
  {
    variants: {
      variant: {
        default: 'bg-cream border-stone-line [&>svg]:text-ink-muted',
        destructive: 'bg-oxide-tint border-oxide/40 [&>svg]:text-oxide',
        warning: 'bg-oxide-tint border-oxide/40 [&>svg]:text-oxide',
        success: 'bg-olive-tint border-olive/40 [&>svg]:text-olive',
        info: 'bg-sea-tint border-sea/40 [&>svg]:text-sea-deep'
      }
    },
    defaultVariants: {
      variant: 'default'
    }
  }
);

const Alert = React.forwardRef(({ className, variant, ...props }, ref) => (
  <div
    ref={ref}
    role="alert"
    className={cn(alertVariants({ variant }), className)}
    {...props}
  />
));
Alert.displayName = 'Alert';

const AlertTitle = React.forwardRef(({ className, ...props }, ref) => (
  <h5
    ref={ref}
    className={cn('mb-1 text-title font-semibold leading-none', className)}
    {...props}
  />
));
AlertTitle.displayName = 'AlertTitle';

const AlertDescription = React.forwardRef(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn('text-body [&_p]:leading-relaxed', className)}
    {...props}
  />
));
AlertDescription.displayName = 'AlertDescription';

export { Alert, AlertTitle, AlertDescription };
