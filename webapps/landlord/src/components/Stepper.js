import { cn } from '../utils';
import { LuCheck } from 'react-icons/lu';
import React from 'react';

/*
 * Stepper — DESIGN.md numbered list.
 *
 * Each step has a leading 24px badge (number for pending, check for done),
 * a hairline rule connecting steps, and an action button below the label.
 * Done steps switch to olive (success); active step is sea-blue; pending
 * steps are stone-line on cream. Type stays in the system's body weight,
 * not bold.
 */
export function Step({
  stepLabel,
  index,
  isDone,
  isActive,
  isLast,
  children,
  className
}) {
  return (
    <div className="flex gap-4 items-stretch">
      <div className="flex flex-col items-center">
        {isDone ? (
          <div className="flex justify-center items-center rounded-pill bg-olive-tint text-olive size-6 shrink-0">
            <LuCheck className="size-3.5" strokeWidth={2.5} />
          </div>
        ) : (
          <div
            className={cn(
              'flex justify-center items-center rounded-pill size-6 shrink-0 text-label font-medium',
              isActive ? 'bg-sea text-bone' : 'bg-cream border border-stone-line text-ink-muted'
            )}
          >
            {index + 1}
          </div>
        )}
        {!isLast ? (
          <div
            className={cn(
              'flex-grow w-px mt-1.5 mb-1.5',
              isDone ? 'bg-olive/40' : 'bg-stone-line'
            )}
          />
        ) : null}
      </div>
      <div className={cn('flex flex-col flex-1', isLast ? 'pb-0' : 'pb-6')}>
        <div className="text-body text-ink leading-snug">{stepLabel}</div>
        {!isDone && children ? (
          <div className={cn('mt-3 flex gap-2', className)}>{children}</div>
        ) : null}
      </div>
    </div>
  );
}

export function Stepper({ activeStep, children }) {
  return (
    <div className="flex flex-col">
      {React.Children.map(children, (child, index) => {
        const isDone = activeStep > index || child.props.isDone;
        const isActive = !isDone && activeStep === index;
        return React.cloneElement(child, {
          index,
          isDone,
          isActive,
          isLast: index === React.Children.count(children) - 1
        });
      })}
    </div>
  );
}
