import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';

import { cn } from '../../utils';

/*
 * Tabs — DESIGN.md flat-by-default, hairline-active.
 *
 * The TabsList sits flush on cream; the active TabsTrigger lifts to bone via
 * tonal contrast (no shadow). A 2px sea-blue underline marks the active tab,
 * implemented as box-shadow (the Lift-Means-Above rule, applied horizontally).
 */

const Tabs = TabsPrimitive.Root;

const TabsList = React.forwardRef(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      'inline-flex h-10 items-center gap-1 border-b border-stone-line text-ink-muted',
      className
    )}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      'inline-flex h-10 items-center justify-center whitespace-nowrap px-4 text-title font-medium',
      'transition-colors duration-base ease-out-quart',
      '-mb-px border-b-2 border-transparent',
      'hover:text-ink',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sea focus-visible:ring-offset-2 focus-visible:ring-offset-cream',
      'disabled:pointer-events-none disabled:opacity-50',
      'data-[state=active]:text-ink data-[state=active]:border-sea',
      className
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      'mt-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sea focus-visible:ring-offset-2 focus-visible:ring-offset-cream',
      className
    )}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
