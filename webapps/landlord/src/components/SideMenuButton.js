import { cn } from '../utils';
import useTranslation from 'next-translate/useTranslation';

/*
 * SideMenuButton — DESIGN.md Components / Navigation Rail.
 *
 * Default: ink-soft text on cream rail, hovers to ink on bone.
 * Active: ink text on bone background + inset 2px sea-blue indicator on the
 * leading edge (box-shadow, never a banned side-stripe border).
 */
export default function SideMenuButton({ item, selected, className, onClick }) {
  const { t } = useTranslation('common');

  return (
    <button
      onClick={onClick}
      data-cy={item.dataCy}
      type="button"
      className={cn(
        'relative flex w-full items-center gap-3 px-3 py-2 rounded-md text-title',
        'transition-colors duration-base ease-out-quart',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sea focus-visible:ring-offset-2 focus-visible:ring-offset-cream',
        selected
          ? 'bg-bone text-ink font-medium'
          : 'text-ink-soft font-normal hover:bg-bone/60 hover:text-ink',
        className
      )}
    >
      {selected ? (
        <span
          aria-hidden="true"
          className="absolute -left-3 top-1.5 bottom-1.5 w-0.5 bg-sea rounded-pill"
        />
      ) : null}
      {item.Icon ? (
        <item.Icon
          className={cn('size-[18px] shrink-0', selected ? 'text-sea' : '')}
        />
      ) : null}
      {item?.labelId ? <span>{t(item.labelId)}</span> : null}
    </button>
  );
}
