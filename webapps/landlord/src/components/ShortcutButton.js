import { cn } from '../utils';

/*
 * ShortcutButton — DESIGN.md Components / dashboard shortcut.
 *
 * A single shortcut tile in the dashboard's shortcut bar. NOT a Button variant
 * because it has its own visual logic: stacked icon + label on mobile (the
 * fixed bottom bar), inline horizontal on desktop. Uses bone surface, hover
 * to cream, sea-blue focus ring.
 */

// Visual variants. `default` is the neutral dashboard tile; `primary` marks the
// single recommended action (ink fill); `destructive` flags delete/terminate so
// they no longer read identically to a benign "Back". The icon tint follows the
// variant so the signal carries beyond color alone.
const VARIANTS = {
  default: {
    tile: 'border-stone-line bg-bone text-ink-soft hover:bg-cream hover:text-ink',
    icon: 'text-ink-muted group-hover:text-sea'
  },
  primary: {
    tile: 'border-ink bg-ink text-bone hover:bg-ink/90',
    icon: 'text-bone group-hover:text-bone'
  },
  destructive: {
    tile: 'border-oxide/40 bg-bone text-oxide hover:bg-oxide-tint',
    icon: 'text-oxide group-hover:text-oxide'
  }
};

export default function ShortcutButton({
  Icon,
  label,
  onClick,
  disabled,
  variant = 'default',
  className,
  dataCy,
  ...rest
}) {
  const v = VARIANTS[variant] || VARIANTS.default;
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
        'text-label font-medium text-center leading-tight',
        'rounded-md border',
        'transition-colors duration-base ease-out-quart',
        v.tile,
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sea focus-visible:ring-offset-2 focus-visible:ring-offset-bone',
        'disabled:pointer-events-none disabled:opacity-50',
        className
      )}
    >
      {Icon ? (
        <Icon
          className={cn(
            'size-[18px] shrink-0 transition-colors duration-base ease-out-quart',
            v.icon
          )}
        />
      ) : null}
      <span className="line-clamp-2 px-1">{label}</span>
    </button>
  );
}
