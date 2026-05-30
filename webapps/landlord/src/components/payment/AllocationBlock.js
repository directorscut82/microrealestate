import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../ui/select';
import {
  PAYMENT_CATEGORIES,
  applyAllocation,
  autoSpreadAllocation
} from '../../utils/paymentAllocation';
import { Input } from '../ui/input';

// Wave-25: human-readable label for each payment category. The values here
// are the LITERAL English keys that exist in every locale's common.json —
// next-translate uses string-keyed flat JSON, not dot-notation namespaces.
const CATEGORY_LABEL_KEY = {
  rent: 'Rent',
  expenses: 'Building expenses',
  repairs: 'Repairs',
  vat: 'VAT',
  previousBalance: 'Previous balance',
  extracharge: 'Extra charge'
};

/**
 * Wave-25: per-payment allocation block. Three modes:
 *   - auto: payment auto-spreads oldest debt category first (server default)
 *   - specific: pick one category, full amount goes there
 *   - custom: per-category inputs, sum should equal payment amount
 *
 * The preview shows owed-before / owed-after for every category that has
 * a non-zero owed amount. Categories with zero owed are hidden (avoids
 * cluttering the table with rows that don't apply this month).
 *
 * Overpayment surfaces a "Credit to next month" line so the surplus is
 * visible, never silent.
 *
 * Extracted from PaymentTabs.js in round-3o so the parent stays under
 * 1000 lines and the allocation logic can be tested in isolation.
 */
export default function AllocationBlock({
  index,
  fieldKey,
  amount,
  owed,
  state,
  onModeChange,
  onSpecificCategoryChange,
  onCustomAmountChange,
  t
}) {
  const mode = state.mode || 'auto';
  const specificCategory = state.specificCategory || '';
  const custom = state.custom || {};

  // Build the working allocation array based on the active mode. This is
  // what the preview applies to `owed` to render before/after columns.
  let allocation = [];
  if (mode === 'auto') {
    allocation = autoSpreadAllocation(amount, owed);
  } else if (mode === 'specific' && specificCategory) {
    allocation = [{ category: specificCategory, amount }];
  } else if (mode === 'custom') {
    allocation = Object.entries(custom)
      .map(([category, val]) => ({ category, amount: Number(val) || 0 }))
      .filter((a) => a.amount > 0);
  }

  const { remaining, creditToNextMonth, remainingTotal } = applyAllocation(
    owed,
    allocation
  );

  // Visible categories: anything with a non-zero owed amount, OR being
  // explicitly allocated to in custom mode.
  const visibleCats = PAYMENT_CATEGORIES.filter((c) => {
    if ((Number(owed?.[c]) || 0) > 0) return true;
    if (mode === 'custom' && Number(custom[c]) > 0) return true;
    return false;
  });

  const customSum = Object.values(custom).reduce(
    (s, v) => s + (Number(v) || 0),
    0
  );
  const customDelta = amount - customSum; // >0 = under-allocated, <0 = over

  return (
    <div className="mt-3 pt-3 border-t border-stone-line/60 space-y-3">
      <div className="text-sm font-medium">{t('Apply to')}</div>

      <div className="space-y-2">
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="radio"
            name={`alloc-mode-${fieldKey}`}
            value="auto"
            checked={mode === 'auto'}
            onChange={() => onModeChange('auto')}
            className="mt-1"
            data-cy={`allocMode-${index}-auto`}
          />
          <div className="flex-1">
            <div>{t('Auto-spread (oldest first)')}</div>
            <div className="text-xs text-muted-foreground">
              {t(
                'Payment fills the oldest unpaid category first, then the next.'
              )}
            </div>
          </div>
        </label>

        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="radio"
            name={`alloc-mode-${fieldKey}`}
            value="specific"
            checked={mode === 'specific'}
            onChange={() => onModeChange('specific')}
            className="mt-1"
            data-cy={`allocMode-${index}-specific`}
          />
          <div className="flex-1">
            <div>{t('Specific category')}</div>
            {mode === 'specific' && (
              <div className="mt-1">
                <Select
                  value={specificCategory}
                  onValueChange={onSpecificCategoryChange}
                >
                  <SelectTrigger
                    className="max-w-xs"
                    data-cy={`allocSpecificCategory-${index}`}
                  >
                    <SelectValue placeholder={t('Select a category')} />
                  </SelectTrigger>
                  <SelectContent>
                    {PAYMENT_CATEGORIES.filter(
                      (c) => (Number(owed?.[c]) || 0) > 0
                    ).map((c) => (
                      <SelectItem key={c} value={c}>
                        {t(CATEGORY_LABEL_KEY[c])} (
                        {(Number(owed?.[c]) || 0).toFixed(2)})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        </label>

        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="radio"
            name={`alloc-mode-${fieldKey}`}
            value="custom"
            checked={mode === 'custom'}
            onChange={() => onModeChange('custom')}
            className="mt-1"
            data-cy={`allocMode-${index}-custom`}
          />
          <div className="flex-1">
            <div>{t('Custom split')}</div>
            {mode === 'custom' && (
              <div className="mt-2 space-y-2">
                {visibleCats.map((c) => (
                  <div
                    key={c}
                    className="grid grid-cols-3 items-center gap-2 text-sm"
                  >
                    <div>{t(CATEGORY_LABEL_KEY[c])}</div>
                    <div className="text-muted-foreground tabular-nums">
                      {t('owed')}: {(Number(owed?.[c]) || 0).toFixed(2)}
                    </div>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="0.00"
                      value={custom[c] ?? ''}
                      onChange={(e) => onCustomAmountChange(c, e.target.value)}
                      data-cy={`allocCustom-${index}-${c}`}
                    />
                  </div>
                ))}
                <div
                  className={`text-xs ${
                    Math.abs(customDelta) < 0.005
                      ? 'text-muted-foreground'
                      : customDelta > 0
                        ? 'text-amber-600'
                        : 'text-destructive'
                  }`}
                >
                  {t('Allocated')}: {customSum.toFixed(2)} /{' '}
                  {amount.toFixed(2)}
                  {Math.abs(customDelta) >= 0.005 &&
                    ' — ' +
                      (customDelta > 0
                        ? t('{{amount}} unallocated', {
                            amount: customDelta.toFixed(2)
                          })
                        : t('{{amount}} over', {
                            amount: (-customDelta).toFixed(2)
                          }))}
                </div>
              </div>
            )}
          </div>
        </label>
      </div>

      {/* Preview: owed before / after for visible (non-zero owed) categories */}
      <div className="bg-marble-tint/40 rounded-md p-3 space-y-1 text-sm">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          {t('Preview after this {{amount}} payment', {
            amount: amount.toFixed(2)
          })}
        </div>
        {visibleCats.length === 0 ? (
          <div className="text-muted-foreground italic">
            {t('Nothing currently owed.')}
          </div>
        ) : (
          <table className="w-full tabular-nums">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="text-left font-normal">{t('Category')}</th>
                <th className="text-right font-normal">{t('Before')}</th>
                <th className="text-right font-normal">{t('After')}</th>
              </tr>
            </thead>
            <tbody>
              {visibleCats.map((c) => {
                const before = Number(owed?.[c]) || 0;
                const after = Number(remaining?.[c]) || 0;
                const delta = before - after;
                return (
                  <tr key={c}>
                    <td>{t(CATEGORY_LABEL_KEY[c])}</td>
                    <td className="text-right">{before.toFixed(2)}</td>
                    <td className="text-right">
                      {after.toFixed(2)}
                      {delta > 0.005 && (
                        <span className="ml-1 text-xs text-olive">
                          (-{delta.toFixed(2)})
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
              <tr className="border-t border-stone-line/60 font-medium">
                <td>{t('Total')}</td>
                <td className="text-right">
                  {(Number(owed?.total) || 0).toFixed(2)}
                </td>
                <td className="text-right">
                  {Number(remainingTotal).toFixed(2)}
                </td>
              </tr>
            </tbody>
          </table>
        )}
        {creditToNextMonth > 0 && (
          <div
            className="text-xs text-blue-700 mt-2"
            data-cy={`allocCredit-${index}`}
          >
            {t('Credit to next month')}: {creditToNextMonth.toFixed(2)}
          </div>
        )}
      </div>
    </div>
  );
}
