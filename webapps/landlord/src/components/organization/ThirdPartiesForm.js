import { mergeOrganization, updateStoreOrganization } from './utils';
import { QueryKeys, updateOrganization } from '../../utils/restcalls';
import { useCallback, useContext, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Separator } from '../ui/separator';
import { Switch } from '../ui/switch';
import Link from '../Link';
import { StoreContext } from '../../store';
import { toast } from 'sonner';
import useTranslation from 'next-translate/useTranslation';

const schema = z.object({
  emailDeliveryServiceActive: z.boolean(),
  emailDeliveryServiceName: z.string().optional(),
  gmail_email: z.string().optional(),
  gmail_appPassword: z.string().optional(),
  smtp_server: z.string().optional(),
  smtp_port: z.coerce.number().optional(),
  smtp_secure: z.boolean().optional(),
  smtp_authentication: z.boolean().optional(),
  smtp_username: z.string().optional(),
  smtp_password: z.string().optional(),
  mailgun_apiKey: z.string().optional(),
  mailgun_domain: z.string().optional(),
  fromEmail: z.string().optional(),
  replyToEmail: z.string().optional(),
  b2Active: z.boolean(),
  keyId: z.string().optional(),
  applicationKey: z.string().optional(),
  endpoint: z.string().optional(),
  bucket: z.string().optional()
});

function SectionWithSwitch({ label, description, switchChecked, onSwitchChange, children }) {
  return (
    <div className="pb-10">
      <div className="flex justify-between items-center">
        <div className="text-xl">{label}</div>
        <Switch checked={switchChecked} onCheckedChange={onSwitchChange} />
      </div>
      {description && <div className="text-muted-foreground text-sm">{description}</div>}
      <Separator className="mt-1 mb-2" />
      {children}
    </div>
  );
}

export default function ThirdPartiesForm({ organization }) {
  const { t } = useTranslation('common');
  const store = useContext(StoreContext);
  const queryClient = useQueryClient();
  const { mutateAsync, isError } = useMutation({
    mutationFn: updateOrganization,
    onSuccess: (updatedOrganization) => {
      updateStoreOrganization(store, updatedOrganization);
      queryClient.invalidateQueries({ queryKey: [QueryKeys.ORGANIZATIONS] });
    }
  });

  if (isError) toast.error(t('Error updating organization'));

  const initialValues = useMemo(() => {
    let emailDeliveryServiceName = '';
    let fromEmail = organization.contacts?.[0]?.email || '';
    let replyToEmail = organization.contacts?.[0]?.email || '';
    if (organization.thirdParties?.gmail?.selected) {
      emailDeliveryServiceName = 'gmail';
      fromEmail = organization.thirdParties?.gmail?.fromEmail || '';
      replyToEmail = organization.thirdParties?.gmail?.replyToEmail || '';
    } else if (organization.thirdParties?.smtp?.selected) {
      emailDeliveryServiceName = 'smtp';
      fromEmail = organization.thirdParties?.smtp?.fromEmail || '';
      replyToEmail = organization.thirdParties?.smtp?.replyToEmail || '';
    } else if (organization.thirdParties?.mailgun?.selected) {
      emailDeliveryServiceName = 'mailgun';
      fromEmail = organization.thirdParties?.mailgun?.fromEmail || '';
      replyToEmail = organization.thirdParties?.mailgun?.replyToEmail || '';
    }
    return {
      emailDeliveryServiceActive:
        !!organization.thirdParties?.gmail?.selected ||
        !!organization.thirdParties?.smtp?.selected ||
        !!organization.thirdParties?.mailgun?.selected,
      emailDeliveryServiceName,
      gmail_email: organization.thirdParties?.gmail?.email || '',
      gmail_appPassword: organization.thirdParties?.gmail?.appPassword || '',
      smtp_server: organization.thirdParties?.smtp?.server || '',
      smtp_port: organization.thirdParties?.smtp?.port || 25,
      smtp_secure: !!organization.thirdParties?.smtp?.secure,
      smtp_authentication: organization.thirdParties?.smtp?.authentication === undefined ? true : organization.thirdParties.smtp.authentication,
      smtp_username: organization.thirdParties?.smtp?.username || '',
      smtp_password: organization.thirdParties?.smtp?.password || '',
      mailgun_apiKey: organization.thirdParties?.mailgun?.apiKey || '',
      mailgun_domain: organization.thirdParties?.mailgun?.domain || '',
      fromEmail,
      replyToEmail,
      b2Active: !!organization.thirdParties?.b2?.keyId,
      keyId: organization.thirdParties?.b2?.keyId || '',
      applicationKey: organization.thirdParties?.b2?.applicationKey || '',
      endpoint: organization.thirdParties?.b2?.endpoint || '',
      bucket: organization.thirdParties?.b2?.bucket || ''
    };
  }, [organization]);

  const { register, handleSubmit, watch, setValue, formState: { isSubmitting } } = useForm({
    resolver: zodResolver(schema),
    defaultValues: initialValues,
    values: initialValues
  });

  const emailActive = watch('emailDeliveryServiceActive');
  const emailService = watch('emailDeliveryServiceName');
  const smtpAuth = watch('smtp_authentication');
  const b2Active = watch('b2Active');

  const onSubmit = useCallback(
    async (values) => {
      const formData = { thirdParties: {} };
      if (values.emailDeliveryServiceActive) {
        formData.thirdParties.gmail = {
          selected: values.emailDeliveryServiceName === 'gmail',
          email: values.gmail_email,
          appPassword: values.gmail_appPassword,
          appPasswordUpdated: values.gmail_appPassword !== initialValues.gmail_appPassword,
          fromEmail: values.fromEmail,
          replyToEmail: values.replyToEmail
        };
        formData.thirdParties.smtp = {
          selected: values.emailDeliveryServiceName === 'smtp',
          server: values.smtp_server,
          port: values.smtp_port,
          secure: values.smtp_secure,
          authentication: values.smtp_authentication,
          username: values.smtp_username,
          password: values.smtp_password,
          passwordUpdated: values.smtp_password !== initialValues.smtp_password,
          fromEmail: values.fromEmail,
          replyToEmail: values.replyToEmail
        };
        formData.thirdParties.mailgun = {
          selected: values.emailDeliveryServiceName === 'mailgun',
          apiKey: values.mailgun_apiKey,
          apiKeyUpdated: values.mailgun_apiKey !== initialValues.mailgun_apiKey,
          domain: values.mailgun_domain,
          fromEmail: values.fromEmail,
          replyToEmail: values.replyToEmail
        };
      } else {
        formData.thirdParties.gmail = null;
        formData.thirdParties.smtp = null;
        formData.thirdParties.mailgun = null;
      }
      if (values.b2Active) {
        formData.thirdParties.b2 = {
          keyId: values.keyId,
          applicationKey: values.applicationKey,
          keyIdUpdated: values.keyId !== initialValues.keyId,
          applicationKeyUpdated: values.applicationKey !== initialValues.applicationKey,
          endpoint: values.endpoint,
          bucket: values.bucket
        };
      } else {
        formData.thirdParties.b2 = null;
      }
      await mutateAsync({ store, organization: mergeOrganization(organization, formData) });
    },
    [mutateAsync, store, organization, initialValues]
  );

  return (
    <form onSubmit={handleSubmit(onSubmit)} autoComplete="off">
      <SectionWithSwitch
        label={t('Email delivery service')}
        description={t('Configuration required for sending invoices, notices and all kind of communication to the tenants')}
        switchChecked={emailActive}
        onSwitchChange={(v) => setValue('emailDeliveryServiceActive', v)}
      >
        {emailActive ? (
          <>
            <div className="space-y-2 mb-4">
              <Label>{t('Service')}</Label>
              <div className="flex flex-col gap-2">
                {['gmail', 'smtp', 'mailgun'].map((svc) => (
                  <label key={svc} className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" value={svc} checked={emailService === svc} onChange={() => setValue('emailDeliveryServiceName', svc)} className="accent-primary" />
                    {svc === 'gmail' ? 'Gmail' : svc === 'smtp' ? 'SMTP' : 'Mailgun'}
                  </label>
                ))}
              </div>
            </div>
            {emailService === 'gmail' && (
              <>
                <Link href={`https://support.google.com/accounts/answer/185833?hl=${organization.locale}`} target="_blank" rel="noreferrer" className="my-2">
                  {t('How to use the App password with Gmail')}
                </Link>
                <div className="space-y-2 mt-2"><Label htmlFor="gmail_email">{t('Email')}</Label><Input id="gmail_email" {...register('gmail_email')} /></div>
                <div className="space-y-2 mt-2"><Label htmlFor="gmail_appPassword">{t('Application password')}</Label><Input id="gmail_appPassword" type="password" {...register('gmail_appPassword')} /></div>
              </>
            )}
            {emailService === 'smtp' && (
              <>
                <div className="space-y-2 mt-2"><Label htmlFor="smtp_server">{t('Server')}</Label><Input id="smtp_server" {...register('smtp_server')} /></div>
                <div className="space-y-2 mt-2"><Label htmlFor="smtp_port">{t('Port')}</Label><Input id="smtp_port" type="number" {...register('smtp_port')} /></div>
                <div className="flex items-center gap-2 mt-2">
                  <Switch id="smtp_secure" checked={watch('smtp_secure')} onCheckedChange={(v) => setValue('smtp_secure', v)} />
                  <Label htmlFor="smtp_secure">{t('Enable explicit TLS (Implicit TLS / StartTLS is always used when supported by the SMTP)')}</Label>
                </div>
                <div className="flex items-center gap-2 mt-2">
                  <Switch id="smtp_authentication" checked={smtpAuth} onCheckedChange={(v) => setValue('smtp_authentication', v)} />
                  <Label htmlFor="smtp_authentication">{t('Use authentication')}</Label>
                </div>
                {smtpAuth && (
                  <>
                    <div className="space-y-2 mt-2"><Label htmlFor="smtp_username">{t('Username')}</Label><Input id="smtp_username" {...register('smtp_username')} /></div>
                    <div className="space-y-2 mt-2"><Label htmlFor="smtp_password">{t('Password')}</Label><Input id="smtp_password" type="password" {...register('smtp_password')} /></div>
                  </>
                )}
              </>
            )}
            {emailService === 'mailgun' && (
              <>
                <Link href={`https://help.mailgun.com/hc/${organization.locale.toLowerCase()}/articles/203380100-Where-can-I-find-my-API-key-and-SMTP-credentials-`} target="_blank" rel="noreferrer" className="my-2">
                  {t('How to use the API key and domain with Mailgun')}
                </Link>
                <div className="space-y-2 mt-2"><Label htmlFor="mailgun_apiKey">{t('Private API key')}</Label><Input id="mailgun_apiKey" type="password" {...register('mailgun_apiKey')} /></div>
                <div className="space-y-2 mt-2"><Label htmlFor="mailgun_domain">{t('Domain')}</Label><Input id="mailgun_domain" {...register('mailgun_domain')} /></div>
              </>
            )}
            <div className="space-y-2 mt-2"><Label htmlFor="fromEmail">{t('From Email')}</Label><Input id="fromEmail" {...register('fromEmail')} /></div>
            <div className="space-y-2 mt-2"><Label htmlFor="replyToEmail">{t('Reply to email')}</Label><Input id="replyToEmail" {...register('replyToEmail')} /></div>
          </>
        ) : null}
      </SectionWithSwitch>
      <SectionWithSwitch
        label="Backblaze B2 Cloud Storage"
        description={t('Configuration required to store documents in the cloud')}
        switchChecked={b2Active}
        onSwitchChange={(v) => setValue('b2Active', v)}
      >
        {b2Active ? (
          <>
            <div className="space-y-2 mt-2"><Label htmlFor="keyId">KeyId</Label><Input id="keyId" type="password" {...register('keyId')} /></div>
            <div className="space-y-2 mt-2"><Label htmlFor="applicationKey">ApplicationKey</Label><Input id="applicationKey" type="password" {...register('applicationKey')} /></div>
            <div className="space-y-2 mt-2"><Label htmlFor="bucket">{t('Bucket')}</Label><Input id="bucket" {...register('bucket')} /></div>
            <div className="space-y-2 mt-2"><Label htmlFor="endpoint">{t('Bucket endpoint')}</Label><Input id="endpoint" {...register('endpoint')} /></div>
          </>
        ) : null}
      </SectionWithSwitch>
      <Button type="submit" disabled={isSubmitting} data-cy="submit">
        {!isSubmitting ? t('Save') : t('Saving')}
      </Button>
    </form>
  );
}
