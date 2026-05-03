import BuildingListItem from './BuildingListItem';
import { EmptyIllustration } from '../Illustrations';
import useTranslation from 'next-translate/useTranslation';

export default function BuildingList({ data }) {
  const { t } = useTranslation('common');

  return data.length > 0 ? (
    <div className="grid gap-6 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
      {data.map((building, index) => (
        <BuildingListItem
          key={building._id}
          building={building}
          index={index}
        />
      ))}
    </div>
  ) : (
    <EmptyIllustration label={t('No buildings found')} />
  );
}
