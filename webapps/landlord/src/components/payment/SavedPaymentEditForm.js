import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../ui/select';
import { Button } from '../ui/button';
import { DatePickerInput } from '../ui/date-picker-input';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import moment from 'moment';
import { useState } from 'react';

/**
 * Wave-26 round-3f: inline edit form for an already-saved payment.
 * Lives inside the locked tile when the user clicks ✏️. Changes are
 * staged in component state and committed to `savedPayments` only when
 * the user clicks Apply edit. The user still has to press Εκτέλεση on
 * the outer dialog to actually persist the change to the server.
 *
 * Extracted from PaymentTabs.js in round-3o.
 */
export default function SavedPaymentEditForm({
  initial,
  paymentTypes,
  onCancel,
  onSave,
  t
}) {
  const [amount, setAmount] = useState(String(initial.amount ?? ''));
  // initial.date is the persisted DD/MM/YYYY format; convert to ISO
  // for the DatePickerInput's internal storage (YYYY-MM-DD).
  const isoFromInitial = initial.date
    ? moment(initial.date, 'DD/MM/YYYY', true).isValid()
      ? moment(initial.date, 'DD/MM/YYYY').format('YYYY-MM-DD')
      : ''
    : '';
  const [date, setDate] = useState(isoFromInitial);
  const [type, setType] = useState(initial.type || 'transfer');
  const [reference, setReference] = useState(initial.reference || '');

  const canSave =
    Number(amount) > 0 &&
    !!date &&
    moment(date, 'YYYY-MM-DD', true).isValid();

  return (
    <div>
      <div className="text-sm text-amber-700 mb-2">
        {t(
          'Editing a recorded payment. Your changes are not saved until you press Record on the dialog.'
        )}
      </div>
      <div className="grid gap-2 items-end grid-cols-1 md:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1">
          <Label>{t('Date')}</Label>
          <DatePickerInput
            value={date ? moment(date, 'YYYY-MM-DD').format('DD/MM/YYYY') : ''}
            onChange={(d) => {
              const iso = d
                ? moment(d, 'DD/MM/YYYY').format('YYYY-MM-DD')
                : '';
              setDate(iso);
            }}
            paymentContext
          />
        </div>
        <div className="space-y-1">
          <Label>{t('Type')}</Label>
          <Select value={type} onValueChange={setType}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {paymentTypes.itemList.map((pt) => (
                <SelectItem
                  key={pt.id}
                  value={pt.value}
                  disabled={pt.disabled}
                  className={pt.disabled ? 'italic text-ink-muted' : undefined}
                >
                  {pt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {type !== 'cash' && (
          <div className="space-y-1">
            <Label>
              {type === 'cheque'
                ? t('Cheque no.')
                : type === 'transfer'
                  ? t('IBAN or transaction id')
                  : t('Reference')}
            </Label>
            <Input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </div>
        )}
        <div className="space-y-1">
          <Label>{t('Amount')}</Label>
          <Input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
      </div>
      <div className="flex justify-end gap-2 mt-3">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          {t('Cancel')}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!canSave}
          onClick={() =>
            onSave({
              amount: Number(amount),
              date: moment(date, 'YYYY-MM-DD').format('DD/MM/YYYY'),
              type,
              reference: type === 'cash' ? '' : reference,
              description: initial.description || ''
            })
          }
        >
          {t('Apply edit')}
        </Button>
      </div>
    </div>
  );
}
