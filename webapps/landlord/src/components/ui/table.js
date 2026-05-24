import * as React from 'react';

import { cn } from '../../utils';

/*
 * Table — DESIGN.md Components / Tables.
 *
 * Tables read like a printed ledger. Default row 48px, hover transitions to
 * cream over 120ms, no lift. Numeric cells use JetBrains Mono with tabular
 * numerals via `<TableCell numeric>`. Selected rows get the active indicator
 * (inset 2px sea bar on the leading edge), forbidden side-stripes excluded.
 */

const Table = React.forwardRef(({ className, ...props }, ref) => (
  <div className="relative w-full overflow-auto rounded-lg border border-stone-line bg-bone">
    <table
      ref={ref}
      className={cn('w-full caption-bottom text-body', className)}
      {...props}
    />
  </div>
));
Table.displayName = 'Table';

const TableHeader = React.forwardRef(({ className, ...props }, ref) => (
  <thead
    ref={ref}
    className={cn('bg-cream [&_tr]:border-b [&_tr]:border-stone-line', className)}
    {...props}
  />
));
TableHeader.displayName = 'TableHeader';

const TableBody = React.forwardRef(({ className, ...props }, ref) => (
  <tbody
    ref={ref}
    className={cn('[&_tr:last-child]:border-0', className)}
    {...props}
  />
));
TableBody.displayName = 'TableBody';

const TableFooter = React.forwardRef(({ className, ...props }, ref) => (
  <tfoot
    ref={ref}
    className={cn(
      'border-t border-stone-line bg-cream font-semibold [&>tr]:last:border-b-0',
      className
    )}
    {...props}
  />
));
TableFooter.displayName = 'TableFooter';

const TableRow = React.forwardRef(({ className, ...props }, ref) => (
  <tr
    ref={ref}
    className={cn(
      'border-b border-stone-line transition-colors duration-fast ease-out-quart hover:bg-cream',
      'data-[state=selected]:bg-sea-tint data-[state=selected]:indicator-active',
      className
    )}
    {...props}
  />
));
TableRow.displayName = 'TableRow';

const TableHead = React.forwardRef(
  ({ className, numeric, ...props }, ref) => (
    <th
      ref={ref}
      className={cn(
        'h-10 px-4 align-middle text-label font-medium text-ink-muted',
        '[&:has([role=checkbox])]:pr-0',
        numeric ? 'text-right' : 'text-left',
        className
      )}
      {...props}
    />
  )
);
TableHead.displayName = 'TableHead';

const TableCell = React.forwardRef(
  ({ className, numeric, ...props }, ref) => (
    <td
      ref={ref}
      className={cn(
        'px-4 py-3.5 align-middle text-body text-ink',
        '[&:has([role=checkbox])]:pr-0',
        numeric && 'font-mono tabular-nums text-right',
        className
      )}
      {...props}
    />
  )
);
TableCell.displayName = 'TableCell';

const TableCaption = React.forwardRef(({ className, ...props }, ref) => (
  <caption
    ref={ref}
    className={cn('mt-4 text-body text-ink-muted', className)}
    {...props}
  />
));
TableCaption.displayName = 'TableCaption';

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption
};
