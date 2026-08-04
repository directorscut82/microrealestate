import { mergeOrganization, updateStoreOrganization } from './utils';
import { QueryKeys, updateOrganization } from '../../utils/restcalls';
import { useCallback, useContext, useMemo } from 'react';
import { useForm, useFieldArray } from 'react-hook-form';
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

const optionalEmail = z
  .string()
  .trim()
  .email()
  .or(z.literal(''))
  .optional();

const schema = z.object({
  emailDeliveryServiceActive: z.boolean(),
  emailDeliveryServiceName: z.string().optional(),
  gmail_email: z.string().optional(),
  gmail_appPassword: z.string().optional(),
  smtp_server: z.string().optional(),
  smtp_port: z.preprocess(
    (v) => (v === '' || v == null ? undefined : v),
    z.coerce.number().int().min(1).max(65535).optional()
  ),
  smtp_secure: z.boolean().optional(),
  smtp_authentication: z.boolean().optional(),
  smtp_username: z.string().optional(),
  smtp_password: z.string().optional(),
  mailgun_apiKey: z.string().optional(),
  mailgun_domain: z.string().optional(),
  fromEmail: optionalEmail,
  replyToEmail: optionalEmail,
  b2Active: z.boolean(),
  keyId: z.string().optional(),
  applicationKey: z.string().optional(),
  endpoint: z.string().optional(),
  bucket: z.string().optional(),
  smsActive: z.boolean(),
  smsUrl: z.string().optional(),
  smsUsername: z.string().optional(),
  smsPassword: z.string().optional(),
  smsCountryCode: z
    .string()
    .regex(/^\+\d{1,4}$/)
    .or(z.literal(''))
    .optional(),
  telegramActive: z.boolean(),
  telegramBotToken: z.string().optional(),
  telegramAdminChatId: z.string().optional(),
  mailReadersActive: z.boolean(),
  mailReaders: z
    .array(
      z.object({
        provider: z.string().optional(),
        email: z.string().trim().email().or(z.literal('')).optional(),
        clientId: z.string().optional(),
        clientSecret: z.string().optional(),
        refreshToken: z.string().optional(),
        label: z.string().optional()
      })
    )
    .optional()
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
      bucket: organization.thirdParties?.b2?.bucket || '',
      smsActive: !!organization.thirdParties?.smsGateway?.selected,
      smsUrl: organization.thirdParties?.smsGateway?.url || '',
      smsUsername: organization.thirdParties?.smsGateway?.username || '',
      smsPassword: organization.thirdParties?.smsGateway?.password || '',
      smsCountryCode: organization.thirdParties?.smsGateway?.countryCode || '',
      telegramActive: !!organization.thirdParties?.telegram?.selected,
      telegramBotToken: organization.thirdParties?.telegram?.botToken || '',
      telegramAdminChatId:
        organization.thirdParties?.telegram?.adminChatId || '',
      mailReadersActive: (organization.thirdParties?.mailReaders || []).length > 0,
      mailReaders: (organization.thirdParties?.mailReaders || []).map((r) => ({
        provider: r.provider || 'gmail',
        email: r.email || '',
        clientId: r.clientId || '',
        clientSecret: r.clientSecret || '',
        refreshToken: r.refreshToken || '',
        label: r.label || ''
      }))
    };
  }, [organization]);

  const { register, handleSubmit, watch, setValue, control, formState: { isSubmitting } } = useForm({
    resolver: zodResolver(schema),
    defaultValues: initialValues,
    values: initialValues
  });
  const { fields: readerFields, append: appendReader, remove: removeReader } =
    useFieldArray({ control, name: 'mailReaders' });

  const emailActive = watch('emailDeliveryServiceActive');
  const emailService = watch('emailDeliveryServiceName');
  const smtpAuth = watch('smtp_authentication');
  const b2Active = watch('b2Active');
  const smsActive = watch('smsActive');
  const telegramActive = watch('telegramActive');
  const mailReadersActive = watch('mailReadersActive');

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
        // Turning a provider OFF must DISABLE it, not erase it. Sending `null`
        // made realmmanager's shallow spread overwrite the provider key, and
        // every secret-carry-forward branch there is gated on truthiness
        // (`if (req.body.thirdParties?.X)`), so the AES ciphertext was deleted
        // from the database and could only be recovered from the provider.
        // Every reader gates on `selected === true`, so `selected: false`
        // disables the channel just as completely while keeping the credential.
        formData.thirdParties.gmail = { selected: false };
        formData.thirdParties.smtp = { selected: false };
        formData.thirdParties.mailgun = { selected: false };
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
        // Disable, don't erase — see the note on the email providers above.
        formData.thirdParties.b2 = { selected: false };
      }
      if (values.smsActive) {
        formData.thirdParties.smsGateway = {
          selected: true,
          url: values.smsUrl,
          username: values.smsUsername,
          password: values.smsPassword,
          passwordUpdated: values.smsPassword !== initialValues.smsPassword,
          countryCode: values.smsCountryCode
        };
      } else {
        // Disable, don't erase — see the note on the email providers above.
        formData.thirdParties.smsGateway = { selected: false };
      }
      if (values.telegramActive) {
        formData.thirdParties.telegram = {
          selected: true,
          botToken: values.telegramBotToken,
          botTokenUpdated:
            values.telegramBotToken !== initialValues.telegramBotToken,
          adminChatId: values.telegramAdminChatId
        };
      } else {
        // Disable, don't erase — see the note on the email providers above.
        formData.thirdParties.telegram = { selected: false };
      }
      if (values.mailReadersActive) {
        // A1 (audit-2026-07): match each row to its PREVIOUS state by EMAIL,
        // not by array index. The `.filter()` above drops empty-email rows, so
        // an index into the unfiltered initialValues points at the wrong reader
        // once any earlier reader is removed — misfiring clientSecretUpdated and
        // making the backend encrypt the literal '**********' placeholder,
        // silently corrupting a surviving reader's secret. The backend already
        // keys previous state by email (realmmanager `prevByEmail`); mirror it.
        const prevByEmail = new Map(
          (initialValues.mailReaders || []).map((r) => [
            String(r.email || '').trim(),
            r
          ])
        );
        formData.thirdParties.mailReaders = (values.mailReaders || [])
          .filter((r) => (r.email || '').trim())
          .map((r) => {
            const prev = prevByEmail.get(String(r.email || '').trim()) || {};
            return {
              provider: r.provider || 'gmail',
              email: r.email,
              clientId: r.clientId,
              clientSecret: r.clientSecret,
              refreshToken: r.refreshToken,
              label: r.label || '',
              clientSecretUpdated: r.clientSecret !== prev.clientSecret,
              refreshTokenUpdated: r.refreshToken !== prev.refreshToken
            };
          });
      } else {
        formData.thirdParties.mailReaders = [];
      }
      await mutateAsync(mergeOrganization(organization, formData));
    },
    [mutateAsync, organization, initialValues]
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
      <SectionWithSwitch
        label={t('SMS Gateway')}
        description={t('Configuration required for sending SMS notifications to tenants')}
        switchChecked={smsActive}
        onSwitchChange={(v) => setValue('smsActive', v)}
      >
        {smsActive ? (
          <>
            <div className="space-y-2 mt-2"><Label htmlFor="smsUrl">{t('Server URL')}</Label><Input id="smsUrl" {...register('smsUrl')} /></div>
            <div className="space-y-2 mt-2"><Label htmlFor="smsUsername">{t('Username')}</Label><Input id="smsUsername" {...register('smsUsername')} /></div>
            <div className="space-y-2 mt-2"><Label htmlFor="smsPassword">{t('Password')}</Label><Input id="smsPassword" type="password" {...register('smsPassword')} /></div>
            <div className="space-y-2 mt-2"><Label htmlFor="smsCountryCode">{t('SMS Country Code')}</Label><Input id="smsCountryCode" placeholder="+30" {...register('smsCountryCode')} /></div>
          </>
        ) : null}
      </SectionWithSwitch>
      <SectionWithSwitch
        label={t('Telegram notifications')}
        description={t('Send push notifications through a Telegram bot (e.g. alert yourself about overdue rents). Needs a bot token and a chat id.')}
        switchChecked={telegramActive}
        onSwitchChange={(v) => setValue('telegramActive', v)}
      >
        {telegramActive ? (
          <>
            <Link
              href="https://core.telegram.org/bots/features#botfather"
              target="_blank"
              rel="noreferrer"
              className="my-2"
            >
              {t('How to create a Telegram bot token (message @BotFather)')}
            </Link>
            <div className="space-y-2 mt-2"><Label htmlFor="telegramBotToken">{t('Bot token')}</Label><Input id="telegramBotToken" type="password" autoComplete="off" placeholder="123456:ABC-DEF..." {...register('telegramBotToken')} /></div>
            <div className="space-y-2 mt-2"><Label htmlFor="telegramAdminChatId">{t('Admin chat ID')}</Label><Input id="telegramAdminChatId" autoComplete="off" {...register('telegramAdminChatId')} /></div>
          </>
        ) : null}
      </SectionWithSwitch>
      <SectionWithSwitch
        label={t('Mail reading (auto-detect bills)')}
        description={t('Read one or more mailboxes to auto-detect incoming utility bills (e.g. ΔΕΗ) and notify you in the app. Uses the Gmail API (read-only).')}
        switchChecked={mailReadersActive}
        onSwitchChange={(v) => {
          setValue('mailReadersActive', v);
          if (v && readerFields.length === 0) {
            appendReader({ provider: 'gmail', email: '', clientId: '', clientSecret: '', refreshToken: '', label: '' });
          }
        }}
      >
        {mailReadersActive ? (
          <div className="space-y-4">
            <Link
              href="https://console.cloud.google.com/apis/credentials"
              target="_blank"
              rel="noreferrer"
              className="my-2"
            >
              {t('How to create the Client ID, Client secret and Refresh token (Google Cloud + OAuth)')}
            </Link>
            {readerFields.map((field, idx) => (
              <div key={field.id} className="rounded-lg border border-border p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-muted-foreground">
                    {t('Mailbox {{n}}', { n: idx + 1 })}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removeReader(idx)}
                  >
                    {t('Remove')}
                  </Button>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label htmlFor={`mailReaders.${idx}.email`}>{t('Email')}</Label>
                    <Input id={`mailReaders.${idx}.email`} type="email" placeholder="name@gmail.com" {...register(`mailReaders.${idx}.email`)} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`mailReaders.${idx}.label`}>{t('Label (optional)')}</Label>
                    <Input id={`mailReaders.${idx}.label`} placeholder={t('e.g. Bills inbox')} {...register(`mailReaders.${idx}.label`)} />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`mailReaders.${idx}.clientId`}>{t('Client ID')}</Label>
                  <Input id={`mailReaders.${idx}.clientId`} autoComplete="off" {...register(`mailReaders.${idx}.clientId`)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`mailReaders.${idx}.clientSecret`}>{t('Client secret')}</Label>
                  <Input id={`mailReaders.${idx}.clientSecret`} type="password" autoComplete="off" {...register(`mailReaders.${idx}.clientSecret`)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`mailReaders.${idx}.refreshToken`}>{t('Refresh token')}</Label>
                  <Input id={`mailReaders.${idx}.refreshToken`} type="password" autoComplete="off" {...register(`mailReaders.${idx}.refreshToken`)} />
                </div>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => appendReader({ provider: 'gmail', email: '', clientId: '', clientSecret: '', refreshToken: '', label: '' })}
            >
              + {t('Add mailbox')}
            </Button>
          </div>
        ) : null}
      </SectionWithSwitch>
      <Button type="submit" disabled={isSubmitting} data-cy="submit">
        {!isSubmitting ? t('Save') : t('Saving')}
      </Button>
    </form>
  );
}
