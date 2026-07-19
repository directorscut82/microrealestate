import { Card } from '../ui/card';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Button } from '../ui/button';
import { QueryKeys, updateOwnerContact } from '../../utils/restcalls';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import useTranslation from 'next-translate/useTranslation';

/**
 * Στοιχεία επικοινωνίας ιδιοκτήτη — inline editor on the owner detail page.
 * Τηλέφωνο / Email / IBAN are editable (saved to every unit-owner entry of
 * this ownerKey via PATCH /owners/:key/contact). ΑΦΜ is displayed read-only:
 * it is part of the owner identity key (renaming/re-keying happens on the
 * unit co-owner editor).
 */
export default function OwnerContactCard({ owner, ownerKey }) {
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  const [phone, setPhone] = useState(owner.phone || '');
  const [email, setEmail] = useState(owner.email || '');
  const [iban, setIban] = useState(owner.iban || '');

  const mutation = useMutation({
    mutationFn: updateOwnerContact,
    onSuccess: () => {
      toast.success(t('Saved'));
      queryClient.invalidateQueries({ queryKey: [QueryKeys.OWNERS] });
    },
    onError: (err) =>
      toast.error(
        err?.response?.data?.message || t('Something went wrong')
      )
  });

  const dirty =
    phone !== (owner.phone || '') ||
    email !== (owner.email || '') ||
    iban !== (owner.iban || '');

  return (
    <Card className="p-5">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
        <div className="space-y-1.5">
          <Label htmlFor="owner-afm">{t('Tax ID')}</Label>
          <Input id="owner-afm" value={owner.taxId || ''} disabled readOnly />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="owner-phone">{t('Phone')}</Label>
          <Input
            id="owner-phone"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="owner-email">{t('Email')}</Label>
          <Input
            id="owner-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="owner-iban">IBAN</Label>
          <Input
            id="owner-iban"
            value={iban}
            onChange={(e) => setIban(e.target.value)}
          />
        </div>
      </div>
      {dirty && (
        <div className="mt-4">
          <Button
            size="sm"
            disabled={mutation.isPending}
            onClick={() =>
              mutation.mutate({ ownerKey, phone, email, iban })
            }
          >
            {mutation.isPending ? t('Saving') : t('Save')}
          </Button>
        </div>
      )}
    </Card>
  );
}
