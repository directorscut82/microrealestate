import { useCallback, useContext, useMemo, useState } from 'react';
import {
  LuAlertTriangle,
  LuCheckCircle2,
  LuMail,
  LuMessageCircle,
  LuPhone,
  LuX
} from 'react-icons/lu';
import { cn } from '../../utils';
import { StoreContext } from '../../store';
import useTranslation from 'next-translate/useTranslation';

/**
 * Three thin status banners showing which delivery channels are configured
 * for the current realm:
 *   - Email   (Gmail / SMTP / Mailgun)        — olive when ready, amber when missing
 *   - SMS     (smsGateway via sms-gate.app)   — olive when ready, amber when missing
 *   - Messengers (WhatsApp/Telegram/etc.)     — slate; not implemented yet
 *
 * Each banner is dismissable for the rest of the session, scoped to the
 * current realm so dismissals don't leak across organizations.
 */

const STATE_CLASSES = {
  ready: 'bg-olive/10 text-olive border-olive/30',
  missing: 'bg-amber-50 text-amber-700 border-amber-200',
  unavailable: 'bg-slate-50 text-slate-600 border-slate-200'
};

function Banner({ state, icon: Icon, message, onDismiss }) {
  const StateIcon = state === 'ready' ? LuCheckCircle2 : LuAlertTriangle;
  return (
    <div
      role="status"
      className={cn(
        'flex items-center gap-2 px-3 py-1.5 border rounded-md text-sm',
        STATE_CLASSES[state]
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <StateIcon className="size-4 shrink-0" aria-hidden="true" />
      <span className="flex-1 leading-snug">{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded-sm hover:bg-black/5 p-0.5"
        aria-label="Dismiss"
      >
        <LuX className="size-3.5" />
      </button>
    </div>
  );
}

function dismissKey(realmId, channel) {
  return `mre.channelBanner.dismissed.${realmId}.${channel}`;
}

function readDismissed(realmId) {
  if (typeof window === 'undefined') return {};
  try {
    return {
      email: !!window.sessionStorage.getItem(dismissKey(realmId, 'email')),
      sms: !!window.sessionStorage.getItem(dismissKey(realmId, 'sms')),
      messengers: !!window.sessionStorage.getItem(
        dismissKey(realmId, 'messengers')
      )
    };
  } catch {
    return {};
  }
}

export default function ChannelStatusBanners() {
  const store = useContext(StoreContext);
  const { t } = useTranslation('common');
  const realmId = store.organization.selected?._id || 'unknown';
  const [dismissed, setDismissed] = useState(() => readDismissed(realmId));

  const dismiss = useCallback(
    (channel) => () => {
      try {
        window.sessionStorage.setItem(dismissKey(realmId, channel), '1');
      } catch {
        // Ignore quota / privacy-mode failures — dismissal becomes
        // transient (in-memory) rather than persisting across reloads.
      }
      setDismissed((prev) => ({ ...prev, [channel]: true }));
    },
    [realmId]
  );

  const emailProvider = store.organization.emailProviderName;
  const canSendEmails = store.organization.canSendEmails;
  const canSendSms = store.organization.canSendSms;

  const banners = useMemo(() => {
    const items = [];
    if (!dismissed.email) {
      items.push({
        key: 'email',
        state: canSendEmails ? 'ready' : 'missing',
        icon: LuMail,
        message: canSendEmails
          ? t('Email: configured ({{provider}}) — bulk send is enabled', {
              provider: emailProvider
            })
          : t(
              'Email: not configured — set it up in Settings → Third-party services to enable bulk send'
            )
      });
    }
    if (!dismissed.sms) {
      items.push({
        key: 'sms',
        state: canSendSms ? 'ready' : 'missing',
        icon: LuPhone,
        message: canSendSms
          ? t('SMS: configured (sms-gate.app) — text messages can be sent')
          : t(
              'SMS: not configured — set it up in Settings → Third-party services to enable SMS sending'
            )
      });
    }
    if (!dismissed.messengers) {
      items.push({
        key: 'messengers',
        state: 'unavailable',
        icon: LuMessageCircle,
        message: t(
          'Messengers (WhatsApp, Telegram, Viber, Signal): not implemented yet'
        )
      });
    }
    return items;
  }, [
    dismissed.email,
    dismissed.sms,
    dismissed.messengers,
    canSendEmails,
    canSendSms,
    emailProvider,
    t
  ]);

  if (!banners.length) return null;

  return (
    <div className="flex flex-col gap-1.5 mb-4">
      {banners.map((b) => (
        <Banner
          key={b.key}
          state={b.state}
          icon={b.icon}
          message={b.message}
          onDismiss={dismiss(b.key)}
        />
      ))}
    </div>
  );
}
