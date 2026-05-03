import { EmptyIllustration } from '../../components/Illustrations';
import PropertyListItem from './PropertyListItem';
import { useMemo } from 'react';
import useTranslation from 'next-translate/useTranslation';

const ACCENT_COLORS = [
  'border-l-blue-500',
  'border-l-emerald-500',
  'border-l-amber-500',
  'border-l-violet-500',
  'border-l-rose-500',
  'border-l-cyan-500',
  'border-l-orange-500',
  'border-l-indigo-500'
];

const BG_COLORS = [
  'bg-blue-50/50',
  'bg-emerald-50/50',
  'bg-amber-50/50',
  'bg-violet-50/50',
  'bg-rose-50/50',
  'bg-cyan-50/50',
  'bg-orange-50/50',
  'bg-indigo-50/50'
];

export default function PropertyList({ data }) {
  const { t } = useTranslation('common');

  const grouped = useMemo(() => {
    const map = new Map();
    const ungrouped = [];
    for (const property of data) {
      if (property.buildingId) {
        if (!map.has(property.buildingId)) {
          map.set(property.buildingId, {
            buildingName: property.buildingName || property.address?.street1 || t('Building'),
            properties: []
          });
        }
        map.get(property.buildingId).properties.push(property);
      } else {
        ungrouped.push(property);
      }
    }
    return { buildings: [...map.entries()], ungrouped };
  }, [data, t]);

  if (data.length === 0) {
    return <EmptyIllustration label={t('No properties found')} />;
  }

  return (
    <div className="space-y-8">
      {grouped.buildings.map(([buildingId, group], idx) => {
        const accent = ACCENT_COLORS[idx % ACCENT_COLORS.length];
        const bg = BG_COLORS[idx % BG_COLORS.length];
        return (
          <div key={buildingId} className={`rounded-lg p-4 ${bg}`}>
            <h3 className="text-sm font-semibold text-muted-foreground mb-3 uppercase tracking-wide">
              {group.buildingName}
            </h3>
            <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
              {group.properties.map((property) => (
                <PropertyListItem
                  key={property._id}
                  property={property}
                  accent={accent}
                />
              ))}
            </div>
          </div>
        );
      })}
      {grouped.ungrouped.length > 0 && (
        <div>
          {grouped.buildings.length > 0 && (
            <h3 className="text-sm font-semibold text-muted-foreground mb-3 uppercase tracking-wide">
              {t('Other')}
            </h3>
          )}
          <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
            {grouped.ungrouped.map((property) => (
              <PropertyListItem key={property._id} property={property} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
