import * as React from 'react';
import { cn } from '../../utils';
import { cva } from 'class-variance-authority';

/*
 * Badge / Pill — DESIGN.md Components / Pills.
 *
 * Pills carry state. Pill geometry (999px radius), 4px vertical / 10px
 * horizontal padding, label type (12px / +0.04em). Each state has a leading
 * glyph passed via the `glyph` prop or by composition; color must never be
 * the only signal. The Pair-Color-With-Glyph Rule.
 *
 * Variants map to DESIGN.md status colors:
 *   paid       olive on olive-tint (success)
 *   overdue    oxide on oxide-tint (destructive / warning)
 *   pending    sea-deep on sea-tint (informational)
 *   archived   ink-muted on stone (deactivated)
 *   neutral    ink on cream (default ledger entry)
 *
 * Legacy variants kept for backward compatibility with Radix-shadcn callers:
 *   default, secondary, success, destructive, outline.
 */
const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-pill px-2.5 py-0.5 text-label font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-sea focus:ring-offset-2 focus:ring-offset-cream',
  {
    variants: {
      variant: {
        // Status pills (preferred). Body label is ink on a colored tint so
        // tiny 12px text never relies on color-on-color. The leading glyph
        // carries the state signal (Pair-Color-With-Glyph Rule).
        paid: 'bg-olive-tint text-ink border border-olive/30',
        overdue: 'bg-oxide-tint text-ink border border-oxide/30',
        pending: 'bg-sea-tint text-ink border border-sea/30',
        archived: 'bg-stone text-ink-muted',
        neutral: 'bg-cream text-ink',
        // Legacy aliases.
        default: 'bg-ink text-bone',
        secondary: 'bg-cream text-ink border border-stone-line',
        success: 'bg-olive-tint text-ink border border-olive/30',
        destructive: 'bg-oxide-tint text-ink border border-oxide/30',
        outline: 'border border-stone-line text-ink'
      }
    },
    defaultVariants: {
      variant: 'neutral'
    }
  }
);

function Badge({ className, variant, ...props }) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
