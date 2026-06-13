import { cn } from '../../utils';
import { DashboardCard } from './DashboardCard';
import { LuWallet } from 'react-icons/lu';
import NumberFormat from '../NumberFormat';
import { Progress } from '../ui/progress';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';

/*
 * OwnerExpensesFigures — the owner counterpart to the rent collected-vs-owed
 * figures. Shows owner-expenses paid vs unpaid for the current year (across
 * all buildings), driven by owner καταβολές (dashboardData.ownerExpenses).
 * Clicking opens the Owners page.
 */
export default function OwnerExpensesFigures({ className, dashboardData }) {
  const { t } = useTranslation('common');
  const router = useRouter();

  const oe = dashboardData?.ownerExpenses || {
    total: 0,
    paid: 0,
    outstanding: 0
  };
  // Label with the year the SERVER filtered by (UTC), not the client's local
  // year — they can disagree for ~2h at the Jan-1 boundary in Athens.
  const labelYear = oe.year || new Date().getFullYear();
  const total = Number(oe.total) || 0;
  const paid = Number(oe.paid) || 0;
  const outstanding = Number(oe.outstanding) || 0;
  const pct = total > 0 ? Math.round((paid / total) * 100) : 0;

  return (
    <div className={cn('grid grid-cols-1 gap-4', className)}>
      <DashboardCard
        Icon={LuWallet}
        title={t('Owner expenses paid')}
        description={t('Owner-side charges for {{year}}: paid vs outstanding.', {
          year: labelYear
        })}
        onClick={() => router.push(`/${router.query.organization}/owners`)}
        renderContent={() =>
          total > 0 ? (
            <div className="space-y-3">
              <div className="flex items-baseline justify-between">
                <span className="text-body text-ink-muted">
                  {t('Owner expenses paid')}
                </span>
                <span className="font-mono tabular-nums text-title font-medium text-ink">
                  <NumberFormat value={paid} showZero />
                  <span className="text-ink-muted text-body">
                    {' / '}
                    <NumberFormat value={total} showZero />
                  </span>
                </span>
              </div>
              <Progress value={pct} />
              <div className="flex justify-between text-label">
                <span className="text-olive">
                  {t('Paid')}: <NumberFormat value={paid} showZero />
                </span>
                <span className="text-oxide">
                  {t('Outstanding')}:{' '}
                  <NumberFormat value={outstanding} showZero />
                </span>
              </div>
            </div>
          ) : (
            <div className="text-body text-ink-muted py-4">
              {t('No owner expenses for this year')}
            </div>
          )
        }
      />
    </div>
  );
}
