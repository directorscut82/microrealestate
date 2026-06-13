import OwnerListItem from './OwnerListItem';

// Responsive grid of owner cards — mirrors TenantList.
export default function OwnerList({ owners = [] }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {owners.map((owner) => (
        <OwnerListItem key={owner.ownerKey} owner={owner} />
      ))}
    </div>
  );
}
