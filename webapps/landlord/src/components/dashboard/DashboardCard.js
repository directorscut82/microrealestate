import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '../ui/card';
import { Button } from '../ui/button';
import { cn } from '../../utils';
import { LuArrowRightCircle } from 'react-icons/lu';

/*
 * DashboardCard — DESIGN.md panel composition.
 *
 * Quiet container for a dashboard figure. NOT the hero-metric template.
 * Title and optional description sit at the top with the icon to the right;
 * content fills the body. The ledger-cell rule still applies: any number
 * inside should use the mono numeric type via NumberFormat or the .font-mono
 * utility, not a giant 4xl display.
 */
export function DashboardCard({
  Icon,
  title,
  description,
  renderContent,
  onClick,
  className
}) {
  return (
    <Card className={cn('flex flex-col', className)}>
      {(title || Icon) && (
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-1 min-w-0">
              {title ? (
                <CardTitle className="text-title font-medium text-ink truncate">
                  {title}
                </CardTitle>
              ) : null}
              {description ? (
                <CardDescription className="text-body text-ink-muted">
                  {description}
                </CardDescription>
              ) : null}
            </div>
            {Icon ? (
              <Icon className="size-5 text-ink-muted shrink-0 mt-0.5" />
            ) : null}
          </div>
        </CardHeader>
      )}
      <CardContent className="flex-grow flex justify-between items-start gap-3">
        <div className="w-full min-w-0">{renderContent?.()}</div>
        {onClick ? (
          <Button
            variant="ghost"
            size="icon"
            onClick={onClick}
            aria-label="Open"
          >
            <LuArrowRightCircle className="size-5" />
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
