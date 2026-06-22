import { Avatar, AvatarFallback } from '../ui/avatar';
import { useMemo } from 'react';

export default function TenantAvatar({ tenant }) {
  const initials = useMemo(() => {
    if (!tenant) return '';
    const parts = tenant.name.trim().split(' ');
    if (parts.length === 0) {
      return '';
    }
    if (parts.length === 1) {
      return tenant.name.charAt(0).toUpperCase();
    }
    if (parts.length === 2) {
      return `${parts[0].charAt(0).toUpperCase()}${parts[1]
        .charAt(0)
        .toUpperCase()}`;
    }

    return `${parts[0].charAt(0).toUpperCase()}${parts[parts.length - 1]
      .charAt(0)
      .toUpperCase()}`;
  }, [tenant]);
  return (
    <Avatar className="size-14">
      {/* Warm sea-tint fill (not a chroma-0 / cobalt grey, which reads cold
          against the bone/cream surface). */}
      <AvatarFallback className="bg-sea-tint text-sea-deep font-medium">
        {initials}
      </AvatarFallback>
    </Avatar>
  );
}
