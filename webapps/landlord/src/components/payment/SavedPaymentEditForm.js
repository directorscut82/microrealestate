import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../ui/select';
import { Button } from '../ui/button';
import { Collapse } from '../ui/collapse';
import { DatePickerInput } from '../ui/date-picker-input';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';
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
  // Wave-26 round-3q: per-payment note / discount / extra-charge are
  // editable here too. Without these the saved-tile edit flow used to
  // SILENTLY WIPE any attached promo/extracharge that the user had
  // recorded on the original draft.
  const [description, setDescription] = useState(initial.description || '');
  const [promo, setPromo] = useState(
    initial.promo != null && Number(initial.promo) > 0
      ? String(initial.promo)
      : ''
  );
  const [notepromo, setNotepromo] = useState(initial.notepromo || '');
  const [extracharge, setExtracharge] = useState(
    initial.extracharge != null && Number(initial.extracharge) > 0
      ? String(initial.extracharge)
      : ''
  );
  const [noteextracharge, setNoteextracharge] = useState(
    initial.noteextracharge || ''
  );
  // Collapsibles default open when the corresponding field already has a
  // value, so the user immediately sees what was attached.
  const [noteOpen, setNoteOpen] = useState(!!initial.description);
  const [discountOpen, setDiscountOpen] = useState(
    Number(initial.promo) > 0
  );
  const [extraOpen, setExtraOpen] = useState(
    Number(initial.extracharge) > 0
  );

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

      {/* Per-payment note / discount / extra-charge — collapsibles default
          open when the value already exists, closed otherwise. */}
      <div className="mt-3 space-y-2">
        <Collapse title={t('Note')} open={noteOpen} onOpenChange={setNoteOpen}>
          <div className="space-y-1">
            <Label>{t('Note (only visible to landlord)')}</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
        </Collapse>
        <Collapse
          title={t('Discount')}
          open={discountOpen}
          onOpenChange={setDiscountOpen}
        >
          <div className="space-y-2">
            <div className="space-y-1">
              <Label>{t('Amount')}</Label>
              <Input
                type="number"
                value={promo}
                onChange={(e) => setPromo(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>{t('Description (visible to tenant)')}</Label>
              <Textarea
                value={notepromo}
                onChange={(e) => setNotepromo(e.target.value)}
              />
            </div>
          </div>
        </Collapse>
        <Collapse
          title={t('Additional cost')}
          open={extraOpen}
          onOpenChange={setExtraOpen}
        >
          <div className="space-y-2">
            <div className="space-y-1">
              <Label>{t('Amount')}</Label>
              <Input
                type="number"
                value={extracharge}
                onChange={(e) => setExtracharge(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>{t('Description (visible to tenant)')}</Label>
              <Textarea
                value={noteextracharge}
                onChange={(e) => setNoteextracharge(e.target.value)}
              />
            </div>
          </div>
        </Collapse>
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
              description,
              promo: Number(promo) || 0,
              notepromo,
              extracharge: Number(extracharge) || 0,
              noteextracharge
            })
          }
        >
          {t('Apply edit')}
        </Button>
      </div>
    </div>
  );
}
