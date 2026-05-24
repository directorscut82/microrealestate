import { cn } from '../utils';
import useFormatNumber from '../hooks/useFormatNumber';

/*
 * NumberFormat — DESIGN.md Currency Display.
 *
 * Renders monetary values per the el-GR Currency Rule (1.234,56 €) and the
 * Tabular-Numeral Rule (JetBrains Mono, font-variant-numeric: tabular-nums).
 *
 * Color is paired with sign per the Don't-Colorize-Alone rule:
 *   credit (>= 0)  → olive (paid / credit)
 *   debit  (< 0)   → oxide (overdue / debit), with U+2212 minus sign
 *
 * Props (legacy compat preserved):
 *   value, minimumFractionDigits, style ('currency' default)
 *   withColor    apply credit/debit colors based on sign
 *   debitColor   force the debit color
 *   creditColor  force the credit color
 *   abs          render Math.abs(value) instead of the signed value
 *   showZero     show "0,00 €" instead of "—" for zero values
 */
export default function NumberFormat({
  value: rawValue,
  minimumFractionDigits = 2,
  style = 'currency',
  withColor,
  debitColor,
  creditColor,
  abs = false,
  showZero = false,
  className
}) {
  const formatNumber = useFormatNumber();

  // Currency stays in mono with tabular numerals; non-currency falls back to
  // sans (e.g. percentages already inline in body text).
  const isCurrency = style === 'currency';
  const baseClassName = cn(
    'whitespace-nowrap',
    isCurrency && 'font-mono tabular-nums',
    className
  );

  if (rawValue === undefined || rawValue === null || Number.isNaN(rawValue)) {
    return <span className={cn('text-ink-muted', baseClassName)}>—</span>;
  }

  const value = abs ? Math.abs(rawValue) : rawValue;

  if (rawValue === 0) {
    return (
      <span className={baseClassName}>
        {showZero ? formatNumber(value, style, minimumFractionDigits) : '—'}
      </span>
    );
  }

  // Replace ASCII hyphen with U+2212 (true minus) when Intl emits a sign.
  const formatted = formatNumber(value, style, minimumFractionDigits).replace(
    /^-/,
    '−'
  );

  if ((withColor && rawValue < 0) || debitColor) {
    return (
      <span className={cn('text-oxide', baseClassName)}>{formatted}</span>
    );
  }

  if ((withColor && rawValue >= 0) || creditColor) {
    return (
      <span className={cn('text-olive', baseClassName)}>{formatted}</span>
    );
  }

  return <span className={baseClassName}>{formatted}</span>;
}
