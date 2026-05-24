import {
  LuCheckCircle,
  LuFileText,
  LuInbox,
  LuMapPin,
  LuScroll,
  LuSparkles
} from 'react-icons/lu';
import useTranslation from 'next-translate/useTranslation';

/*
 * Illustrations — DESIGN.md type-only empty states.
 *
 * Earlier revisions used unDraw stock SVGs (smiling people, houses, project-
 * completion celebrations). PRODUCT.md flags those as the generic property-
 * tech SaaS anti-reference, so they're gone. Each empty state now renders as
 * a quiet single-icon + label pattern in ink-muted on cream, sitting flat on
 * the surface (no card-in-card, no decoration). The icon family is Lucide,
 * matching the rest of the system.
 *
 * The label prop remains for backward compatibility with existing callers.
 */

function EmptyState({ icon: Icon, label, className = '' }) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-3 py-16 text-ink-muted ${className}`}
    >
      {Icon ? <Icon className="size-8 text-ink-muted/60" /> : null}
      {label ? (
        <p className="text-body text-ink-muted text-center max-w-sm">
          {label}
        </p>
      ) : null}
    </div>
  );
}

export const SignInUpIllustration = () => null;

export const EmptyIllustration = ({ label }) => {
  const { t } = useTranslation('common');
  return <EmptyState icon={LuInbox} label={label || t('No data found')} />;
};

export const LocationIllustration = () => <EmptyState icon={LuMapPin} />;

export const BlankDocumentIllustration = () => (
  <EmptyState icon={LuFileText} />
);

export const TermsDocumentIllustration = () => <EmptyState icon={LuScroll} />;

export const WelcomeIllustration = () => null;

export const CelebrationIllustration = ({ label }) => {
  const { t } = useTranslation('common');
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 text-olive">
      <LuCheckCircle className="size-7" />
      <p className="text-body text-ink text-center">
        {label || t('Done')}
      </p>
      <LuSparkles className="size-3 text-olive/60" />
    </div>
  );
};
