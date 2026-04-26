import { Avatar, AvatarFallback } from '../ui/avatar';
import { LuBuilding2 } from 'react-icons/lu';

export default function BuildingAvatar() {
  return (
    <Avatar className="size-14">
      <AvatarFallback className="bg-primary/20 font-medium">
        <LuBuilding2 className="size-6" />
      </AvatarFallback>
    </Avatar>
  );
}
