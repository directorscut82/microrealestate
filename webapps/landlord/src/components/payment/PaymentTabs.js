import { Card, CardContent, CardHeader } from '../ui/card';
import {
  forwardRef,
  useCallback,
  useContext,
  useImperativeHandle,
  useRef,
  useState
} from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import _ from 'lodash';
import { Button } from '../ui/button';
import { Collapse } from '../ui/collapse';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../ui/select';
import { LuPlus, LuTrash2 } from 'react-icons/lu';
import moment from 'moment';
import { payRent, QueryKeys } from '../../utils/restcalls';
import { StoreContext } from '../../store';
import { toast } from 'sonner';
import usePaymentTypes from '../../hooks/usePaymentTypes';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import useTranslation from 'next-translate/useTranslation';

const paymentSchema = z.object({
  amount: z.coerce.number().min(0).optional(),
  date: z.string().optional(),
  type: z.enum(['cash', 'transfer', 'levy', 'cheque']),
  reference: z.string().optional()
});

const schema = z.object({
  payments: z.array(paymentSchema).min(1),
  description: z.string().optional(),
  extracharge: z.coerce.number().min(0).optional(),
  noteextracharge: z.string().optional(),
  promo: z.coerce.number().min(0).optional(),
  notepromo: z.string().optional()
});

const emptyPayment = { amount: '', date: '', type: 'transfer', reference: '' };

function initialFormValues(rent) {
  return {
    payments: rent?.payments?.length
      ? rent.payments.map(({ amount, date, type, reference }) => ({
          amount: amount === 0 ? '' : amount,
          date: date ? moment(date, 'DD/MM/YYYY').format('YYYY-MM-DD') : '',
          type,
          reference: reference || ''
        }))
      : [emptyPayment],
    description: rent?.description?.trimEnd() || '',
    extracharge: rent?.extracharge !== 0 ? rent.extracharge : '',
    noteextracharge: rent?.noteextracharge?.trimEnd() || '',
    promo: rent?.promo !== 0 ? rent.promo : '',
    notepromo: rent?.notepromo?.trimEnd() || ''
  };
}

function PaymentTabs({ rent, onSubmit }, ref) {
  const queryClient = useQueryClient();
  const store = useContext(StoreContext);
  const { t } = useTranslation('common');
  const paymentTypes = usePaymentTypes();
  const initVals = initialFormValues(rent);
  const [expandedNote, setExpandedNote] = useState(!!initVals.description);
  const [expandedDiscount, setExpandedDiscount] = useState(initVals.promo > 0);
  const [expandedAdditionalCost, setExpandedAdditionalCost] = useState(initVals.extracharge > 0);
  const formRef = useRef();

  const {
    register,
    handleSubmit,
    control,
    watch,
    setValue,
    reset,
    formState: { errors, isDirty }
  } = useForm({
    resolver: zodResolver(schema),
    defaultValues: initVals
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'payments' });

  useImperativeHandle(ref, () => ({
    isDirty: () => isDirty,
    async submit() { formRef.current?.requestSubmit(); },
    setValues(rent) { reset(initialFormValues(rent)); }
  }), [isDirty, reset]);

  const momentTerm = moment(rent.term, 'YYYYMMDDHH');
  const minDate = moment(momentTerm).startOf('month').format('YYYY-MM-DD');
  const maxDate = moment(momentTerm).endOf('month').format('YYYY-MM-DD');

  const _handleSubmit = useCallback(
    async (values) => {
      const clonedValues = _.cloneDeep(values);
      clonedValues.payments = clonedValues.payments
        .filter(({ amount }) => amount > 0)
        .map((payment) => {
          payment.date = moment(payment.date).format('DD/MM/YYYY');
          if (payment.type === 'cash') delete payment.reference;
          return payment;
        });

      const payment = {
        _id: rent._id,
        month: rent.month,
        year: rent.year,
        ...clonedValues
      };

      const period = moment(String(rent.term), 'YYYYMMDDHH').format('YYYY.MM');
      try {
        await payRent({ term: String(rent.term), payment });
        queryClient.invalidateQueries({ queryKey: [QueryKeys.RENTS, period] });
        queryClient.invalidateQueries({ queryKey: [QueryKeys.DASHBOARD] });
        onSubmit?.();
      } catch (error) {
        console.error(error);
        toast.error(t('Something went wrong'));
      }
    },
    [onSubmit, queryClient, rent._id, rent.month, rent.term, rent.year, t]
  );

  const payments = watch('payments');

  return (
    <form ref={formRef} onSubmit={handleSubmit(_handleSubmit)} autoComplete="off">
      <div className="space-y-4">
        <Card>
          <CardHeader className="text-lg px-6 pt-3 pb-0">{t('Settlement')}</CardHeader>
          <CardContent>
            {fields.map((field, index) => (
              <div key={field.id} className="mb-4 p-3 border rounded-md">
                <div className="flex justify-between items-center mb-2">
                  <div className="font-medium">{t('Settlement #{{count}}', { count: index + 1 })}</div>
                  {fields.length > 1 && (
                    <Button type="button" variant="ghost" size="icon" onClick={() => remove(index)}>
                      <LuTrash2 className="size-4" />
                    </Button>
                  )}
                </div>
                <div className="grid gap-2 items-end grid-cols-1 md:grid-cols-2 lg:grid-cols-4">
                  <div className="space-y-1">
                    <Label htmlFor={`payments.${index}.date`}>{t('Date')}</Label>
                    <Input id={`payments.${index}.date`} type="date" min={minDate} max={maxDate} {...register(`payments.${index}.date`)} />
                  </div>
                  <div className="space-y-1">
                    <Label>{t('Type')}</Label>
                    <Select value={payments?.[index]?.type || 'transfer'} onValueChange={(val) => setValue(`payments.${index}.type`, val)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {paymentTypes.itemList.map((pt) => (
                          <SelectItem key={pt.id} value={pt.value}>{pt.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {payments?.[index]?.type !== 'cash' && (
                    <div className="space-y-1">
                      <Label htmlFor={`payments.${index}.reference`}>{t('Reference')}</Label>
                      <Input id={`payments.${index}.reference`} {...register(`payments.${index}.reference`)} />
                    </div>
                  )}
                  <div className="space-y-1">
                    <Label htmlFor={`payments.${index}.amount`}>{t('Amount')}</Label>
                    <Input id={`payments.${index}.amount`} type="number" {...register(`payments.${index}.amount`)} />
                  </div>
                </div>
              </div>
            ))}
            <Button type="button" variant="outline" onClick={() => append(emptyPayment)}>
              <LuPlus className="size-4 mr-1" />{t('Add a settlement')}
            </Button>
          </CardContent>
        </Card>

        <Collapse title={t('Note')} open={expandedNote} onOpenChange={setExpandedNote}>
          <div className="space-y-1">
            <Label htmlFor="description">{t('Note (only visible to landlord)')}</Label>
            <Textarea id="description" {...register('description')} />
          </div>
        </Collapse>

        <Collapse title={t('Discount')} open={expandedDiscount} onOpenChange={setExpandedDiscount}>
          <div className="space-y-2">
            <div className="space-y-1">
              <Label htmlFor="promo">{t('Amount')}</Label>
              <Input id="promo" type="number" {...register('promo')} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="notepromo">{t('Description (visible to tenant)')}</Label>
              <Textarea id="notepromo" {...register('notepromo')} />
            </div>
          </div>
        </Collapse>

        <Collapse title={t('Additional cost')} open={expandedAdditionalCost} onOpenChange={setExpandedAdditionalCost}>
          <div className="space-y-2">
            <div className="space-y-1">
              <Label htmlFor="extracharge">{t('Amount')}</Label>
              <Input id="extracharge" type="number" {...register('extracharge')} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="noteextracharge">{t('Description (visible to tenant)')}</Label>
              <Textarea id="noteextracharge" {...register('noteextracharge')} />
            </div>
          </div>
        </Collapse>
      </div>
    </form>
  );
}

export default forwardRef(PaymentTabs);
