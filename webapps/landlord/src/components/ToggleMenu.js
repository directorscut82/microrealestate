import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from '../components/ui/popover';
import { useCallback, useMemo, useRef } from 'react';
import { Checkbox } from '../components/ui/checkbox';

export default function ToggleMenu({
  options,
  selectedIds = [],
  multi = false,
  align = 'start',
  onChange,
  children
}) {
  const itemRefs = useRef([]);
  const selectedOptions = useMemo(() => {
    return selectedIds.map((id) => options.find((option) => option.id === id));
  }, [options, selectedIds]);

  const applyChange = useCallback(
    (option) => {
      if (multi === false) {
        onChange([option]);
      } else {
        let newOptions;
        if (!option?.id) {
          newOptions = [option];
        } else if (selectedOptions.map(({ id }) => id).includes(option.id)) {
          newOptions = selectedOptions.filter(({ id }) => id !== option.id);
        } else {
          newOptions = [...selectedOptions, option];
        }
        onChange(newOptions);
      }
    },
    [multi, onChange, selectedOptions]
  );

  const handleMenuItemClick = useCallback(
    (option) => () => applyChange(option),
    [applyChange]
  );

  // Arrow-key navigation + Enter/Space toggle so keyboard users (and
  // screen-reader users) can drive the menu without a mouse. Tab still
  // moves between items because every <li> has tabIndex=0 below.
  const handleKeyDown = useCallback(
    (option, idx) => (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        applyChange(option);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = itemRefs.current[(idx + 1) % options.length];
        next?.focus();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prev =
          itemRefs.current[(idx - 1 + options.length) % options.length];
        prev?.focus();
        return;
      }
      if (e.key === 'Home') {
        e.preventDefault();
        itemRefs.current[0]?.focus();
        return;
      }
      if (e.key === 'End') {
        e.preventDefault();
        itemRefs.current[options.length - 1]?.focus();
      }
    },
    [applyChange, options.length]
  );

  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align={align} className="p-1 m-0">
        <ul role="menu">
          {options.map((option, idx) => {
            const isSelected = selectedIds.includes(option.id);
            return (
              <li
                key={option.id}
                role={multi ? 'menuitemcheckbox' : 'menuitemradio'}
                aria-checked={isSelected}
                tabIndex={0}
                ref={(el) => (itemRefs.current[idx] = el)}
                className="p-2 hover:bg-primary/10 hover:cursor-pointer focus:bg-primary/10 focus:outline-none"
                onClick={handleMenuItemClick(option)}
                onKeyDown={handleKeyDown(option, idx)}
              >
                <Checkbox
                  id={option.id}
                  checked={isSelected}
                  className="inline-block align-middle pointer-events-none"
                />
                <span className="inline-block align-middle mt-0.5 ml-1 text-sm font-medium peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                  {option.label}
                </span>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
