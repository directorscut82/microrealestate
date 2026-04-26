import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow
} from '../ui/table';
import { Badge } from '../ui/badge';
import useTranslation from 'next-translate/useTranslation';

export default function ThousandthsOverview({ building }) {
  const { t } = useTranslation('common');

  const units = building?.units || [];

  if (units.length === 0) {
    return (
      <div className="text-muted-foreground text-center py-8">
        {t('No units added yet')}
      </div>
    );
  }

  const totals = units.reduce(
    (acc, unit) => ({
      general: acc.general + (unit.generalThousandths || 0),
      heating: acc.heating + (unit.heatingThousandths || 0),
      elevator: acc.elevator + (unit.elevatorThousandths || 0)
    }),
    { general: 0, heating: 0, elevator: 0 }
  );

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('Unit')}</TableHead>
          <TableHead>{t('Floor')}</TableHead>
          <TableHead className="text-right">{t('Surface')}</TableHead>
          <TableHead className="text-right">{t('General ‰')}</TableHead>
          <TableHead className="text-right">{t('Heating ‰')}</TableHead>
          <TableHead className="text-right">{t('Elevator ‰')}</TableHead>
          <TableHead>{t('Status')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {units.map((unit) => (
          <TableRow key={unit._id}>
            <TableCell>
              {unit.atakNumber}
              {unit.unitLabel && (
                <span className="text-muted-foreground ml-1">
                  ({unit.unitLabel})
                </span>
              )}
            </TableCell>
            <TableCell>{unit.floor ?? '-'}</TableCell>
            <TableCell className="text-right">
              {unit.surface ? `${unit.surface} m²` : '-'}
            </TableCell>
            <TableCell className="text-right">
              {unit.generalThousandths || 0}
            </TableCell>
            <TableCell className="text-right">
              {unit.heatingThousandths || 0}
            </TableCell>
            <TableCell className="text-right">
              {unit.elevatorThousandths || 0}
            </TableCell>
            <TableCell>
              <Badge variant={unit.isManaged ? 'default' : 'secondary'}>
                {unit.isManaged ? t('Managed') : t('External')}
              </Badge>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell colSpan={3} className="font-medium">
            {t('Total')}
          </TableCell>
          <TableCell className="text-right font-medium">
            {totals.general.toFixed(2)}
          </TableCell>
          <TableCell className="text-right font-medium">
            {totals.heating.toFixed(2)}
          </TableCell>
          <TableCell className="text-right font-medium">
            {totals.elevator.toFixed(2)}
          </TableCell>
          <TableCell />
        </TableRow>
      </TableFooter>
    </Table>
  );
}
