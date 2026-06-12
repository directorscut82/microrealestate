import { cn } from '../utils';

/*
 * ShortcutButton — DESIGN.md Components / dashboard shortcut.
 *
 * A single shortcut tile in the dashboard's shortcut bar. NOT a Button variant
 * because it has its own visual logic: stacked icon + label on mobile (the
 * fixed bottom bar), inline horizontal on desktop. Uses bone surface, hover
 * to cream, sea-blue focus ring.
 */
export default function ShortcutButton({
  Icon,
  label,
  onClick,
  disabled,
  className,
  dataCy,
  ...rest
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-cy={dataCy || rest['data-cy']}
      className={cn(
        // Vertical icon-above-label layout in every viewport. Greek labels
        // get up to 2 lines instead of truncating mid-word.
        'group relative flex flex-col items-center justify-start gap-2 h-full min-h-[80px] w-full px-2 py-3',
        'text-label font-medium text-ink-soft text-center leading-tight',
        'rounded-md border border-stone-line bg-bone',
        'transition-colors duration-base ease-out-quart',
        'hover:bg-cream hover:text-ink',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sea focus-visible:ring-offset-2 focus-visible:ring-offset-bone',
        'disabled:pointer-events-none disabled:opacity-50',
        className
      )}
    >
      {Icon ? (
        <Icon className="size-[18px] text-ink-muted shrink-0 group-hover:text-sea transition-colors duration-base ease-out-quart" />
      ) : null}
      <span className="line-clamp-2 px-1">{label}</span>
    </button>
  );
}
