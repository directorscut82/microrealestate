import { EmptyIllustration } from '../../components/Illustrations';
import PropertyListItem from './PropertyListItem';
import { useMemo } from 'react';
import useTranslation from 'next-translate/useTranslation';

/*
 * PropertyList — DESIGN.md grouped list.
 *
 * Buildings group as labeled sections (a small UPPERCASE label, hairline
 * separator, then a grid of property cards). NO colored side-stripes, NO
 * pastel-tinted backgrounds. NO nested cards. The label IS the grouping
 * affordance.
 */
export default function PropertyList({ data }) {
  const { t } = useTranslation('common');

  const grouped = useMemo(() => {
    const map = new Map();
    const ungrouped = [];
    for (const property of data || []) {
      if (property.buildingId) {
        if (!map.has(property.buildingId)) {
          map.set(property.buildingId, {
            buildingName:
              property.buildingName ||
              property.address?.street1 ||
              t('Building'),
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

  if (!data || data.length === 0) {
    return <EmptyIllustration label={t('No properties found')} />;
  }

  return (
    <div className="space-y-10">
      {grouped.buildings.map(([buildingId, group]) => (
        <section key={buildingId}>
          <header className="flex items-baseline justify-between gap-3 mb-3 pb-2 border-b border-stone-line">
            <h3 className="text-label font-medium text-ink-muted uppercase tracking-wide">
              {group.buildingName}
            </h3>
            <span className="text-label text-ink-muted">
              {t('{{count}} properties', { count: group.properties.length })}
            </span>
          </header>
          <div className="grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
            {group.properties.map((property) => (
              <PropertyListItem key={property._id} property={property} />
            ))}
          </div>
        </section>
      ))}
      {grouped.ungrouped.length > 0 && (
        <section>
          {grouped.buildings.length > 0 && (
            <header className="flex items-baseline justify-between gap-3 mb-3 pb-2 border-b border-stone-line">
              <h3 className="text-label font-medium text-ink-muted uppercase tracking-wide">
                {t('Other')}
              </h3>
              <span className="text-label text-ink-muted">
                {t('{{count}} properties', {
                  count: grouped.ungrouped.length
                })}
              </span>
            </header>
          )}
          <div className="grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
            {grouped.ungrouped.map((property) => (
              <PropertyListItem key={property._id} property={property} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
