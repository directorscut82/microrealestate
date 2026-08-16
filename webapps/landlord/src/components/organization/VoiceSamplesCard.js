import { fetchVoiceSamples, QueryKeys } from '../../utils/restcalls';
import { LuCheck, LuKeyboard, LuMic, LuTimer, LuX } from 'react-icons/lu';
import { Badge } from '../ui/badge';
import moment from 'moment';
import NumberFormat from '../NumberFormat';
import { useQuery } from '@tanstack/react-query';
import useTranslation from 'next-translate/useTranslation';

/*
 * VoiceSamplesCard — the read-only shadow-mode ledger of voice/text money
 * commands, rendered INSIDE the Telegram SectionWithSwitch on
 * settings/thirdparties (approved ASCII mock, 2026-08-16). Read-only on
 * purpose: these rows are a validation DATASET, not work items — the bell is
 * for things needing action, which is why this list does not live there.
 *
 * Not a <Card>: the whole form already sits in the page Card and nested cards
 * are DESIGN.md-banned. A hairline-bordered section with divide rules is the
 * idiom (same as the bell's warning boxes).
 */

// Outcome → pill. Glyph is mandatory beside color (Pair-Color-With-Glyph).
const OUTCOME = {
  validated: { variant: 'paid', Icon: LuCheck, key: 'Validated' },
  rejected: { variant: 'overdue', Icon: LuX, key: 'Rejected' },
  abandoned: { variant: 'archived', Icon: LuTimer, key: 'Abandoned' }
};

const INTENT_KEY = {
  rentPayment: 'Rent payment',
  commonChargesPayment: 'Common charges payment',
  ownerPayment: 'Owner payment'
};

function SampleRow({ item }) {
  const { t } = useTranslation('common');
  const outcome = OUTCOME[item.outcome] || OUTCOME.abandoned;
  const SourceIcon = item.firstSource === 'voice' ? LuMic : LuKeyboard;
  const monthName =
    typeof item.month === 'number'
      ? moment.localeData().months()[item.month - 1]
      : null;

  return (
    <div className="flex items-start gap-3 px-3 py-2.5" data-cy="voiceSampleRow">
      <div className="flex shrink-0 items-center gap-1.5 pt-0.5 text-muted-foreground">
        <span className="font-mono text-[11px]">
          {moment(item.createdDate).format('DD/MM HH:mm')}
        </span>
        <SourceIcon className="size-3.5" />
      </div>
      <div className="min-w-0 flex-1 text-sm">
        {item.intent ? (
          <span className="break-words">
            {t(INTENT_KEY[item.intent] || item.intent)}
            {' — '}
            {item.personName ? `${item.personName}, ` : null}
            {typeof item.amount === 'number' ? (
              <>
                <NumberFormat value={item.amount} />
                {monthName ? ', ' : null}
              </>
            ) : null}
            {monthName}
            {/* A dialogue can end (timeout, όχι-then-walk-away) before every
                slot fills; say so instead of rendering a sentence with holes. */}
            {!item.personName ||
            typeof item.amount !== 'number' ||
            !monthName ? (
              <span className="text-muted-foreground"> ({t('incomplete')})</span>
            ) : null}
          </span>
        ) : (
          <span className="text-muted-foreground">
            {t('(no money command recognized)')}
          </span>
        )}
        {item.corrections > 0 ? (
          <span className="text-xs text-muted-foreground">
            {' · '}
            {t('{{count}} corrections', { count: item.corrections })}
          </span>
        ) : null}
      </div>
      <Badge variant={outcome.variant} className="shrink-0">
        <outcome.Icon className="size-3" />
        {t(outcome.key)}
      </Badge>
    </div>
  );
}

export default function VoiceSamplesCard() {
  const { t } = useTranslation('common');
  const { data } = useQuery({
    queryKey: [QueryKeys.VOICE_SAMPLES],
    queryFn: fetchVoiceSamples,
    // Same cadence as the bell: a sample recorded over Telegram shows up here
    // within a minute while the landlord is looking at this page.
    refetchInterval: 60_000
  });

  const items = data?.items || [];
  const stats = data?.stats;

  return (
    <div className="mt-4" data-cy="voiceSamplesCard">
      <div className="text-sm font-medium">
        {t('Voice commands (trial mode)')}
      </div>
      <div className="text-xs text-muted-foreground">
        {t(
          'Commands you send to the bot are recorded as validation samples. Nothing is booked automatically during this phase.'
        )}
      </div>
      <div className="mt-2 rounded-md border">
        {items.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">
            {t('No samples yet. Send a voice or text command to the Telegram bot.')}
          </div>
        ) : (
          <div className="divide-y">
            {items.map((item) => (
              <SampleRow key={item._id} item={item} />
            ))}
          </div>
        )}
        {stats && stats.total > 0 ? (
          <div className="border-t px-3 py-2 text-xs text-muted-foreground">
            {t(
              'Samples: {{total}} · Validated: {{validated}} · Correct with at most one correction: {{good}}/{{validated}}',
              {
                total: stats.total,
                validated: stats.validated,
                good: stats.validatedLe1
              }
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
