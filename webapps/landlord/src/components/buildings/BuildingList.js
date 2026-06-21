import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '../ui/table';
import { EmptyIllustration } from '../Illustrations';
import { LuAlertTriangle } from 'react-icons/lu';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';

// Compute the "missing details" gap list for a building. Mirrors the prior
// per-card logic: units, manager, address completeness.
function buildingGaps(building, t) {
  const gaps = [];
  if (!building.units?.length && !building.unitCount) gaps.push(t('apartments'));
  if (!building.manager?.name?.trim?.()) gaps.push(t('manager'));
  const a = building.address || {};
  if (!a.street1 || !a.city || !a.zipCode) gaps.push(t('address'));
  return gaps;
}

// Buildings as a ruled LEDGER TABLE (DESIGN.md: tables are the app's primary
// surface and must read like a printed ledger). Replaces the prior grid of
// identical cards with colored left side-stripes + decorative avatars + amber
// warning boxes + drop shadows — all DESIGN.md-banned. Columns: building
// (name + ATAK code), address, managed/total units (mono), and a compact
// oxide-tinted gap pill only when something is missing.
export default function BuildingList({ data }) {
  const { t } = useTranslation('common');
  const router = useRouter();

  if (!data || data.length === 0) {
    return <EmptyIllustration label={t('No buildings found')} />;
  }

  const open = (id) =>
    router.push(`/${router.query.organization}/buildings/${id}`);

  return (
    <div className="overflow-x-auto rounded-lg border border-stone-line">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('Building')}</TableHead>
            <TableHead>{t('Address')}</TableHead>
            <TableHead className="text-right">{t('Units')}</TableHead>
            <TableHead>{t('Status')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((building) => {
            const gaps = buildingGaps(building, t);
            const address = [building.address?.street1, building.address?.city]
              .filter(Boolean)
              .join(', ');
            return (
              <TableRow
                key={building._id}
                className="cursor-pointer"
                data-cy="openResourceButton"
                onClick={() => open(building._id)}
              >
                <TableCell>
                  <div className="font-medium text-ink">{building.name}</div>
                  {building.atakPrefix && (
                    <div className="font-mono tabular-nums text-label text-ink-muted">
                      {building.atakPrefix}
                    </div>
                  )}
                  {building.description && (
                    <div className="text-label text-ink-muted truncate max-w-[28ch]">
                      {building.description}
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-ink-soft">{address || '—'}</TableCell>
                <TableCell numeric>
                  {building.managedCount || 0} / {building.unitCount || 0}
                </TableCell>
                <TableCell>
                  {gaps.length > 0 ? (
                    <span
                      data-cy="buildingMissingFields"
                      className="inline-flex items-center gap-1.5 rounded-pill bg-oxide-tint px-2 py-0.5 text-label text-oxide"
                    >
                      <LuAlertTriangle
                        className="size-3 shrink-0"
                        aria-hidden="true"
                      />
                      {t('Missing details')}
                    </span>
                  ) : (
                    <span className="text-label text-ink-muted">—</span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
