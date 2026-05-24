import { Toaster as Sonner } from 'sonner';
import { useTheme } from 'next-themes';

/*
 * Toaster — DESIGN.md Elevation / toast shadow. Bone surface, hairline border,
 * top-right floating. Olive for success, oxide for destructive, sea for info.
 */
const Toaster = ({ ...props }) => {
  const { theme = 'system' } = useTheme();

  return (
    <Sonner
      theme={theme}
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            'group toast group-[.toaster]:bg-bone group-[.toaster]:text-ink group-[.toaster]:border group-[.toaster]:border-stone-line group-[.toaster]:rounded-lg group-[.toaster]:shadow-toast',
          description: 'group-[.toast]:text-ink-muted',
          actionButton:
            'group-[.toast]:bg-ink group-[.toast]:text-bone group-[.toast]:rounded-md',
          cancelButton:
            'group-[.toast]:bg-cream group-[.toast]:text-ink-soft group-[.toast]:rounded-md',
          // Body text → ink on every variant. Border + leading icon carry
          // the state color so the toast still reads at a glance.
          success:
            'group-[.toaster]:!border-olive/40 group-[.toaster]:!bg-olive-tint group-[.toaster]:!text-ink',
          error:
            'group-[.toaster]:!border-oxide/40 group-[.toaster]:!bg-oxide-tint group-[.toaster]:!text-ink',
          info: 'group-[.toaster]:!border-sea/40 group-[.toaster]:!bg-sea-tint group-[.toaster]:!text-ink',
          warning:
            'group-[.toaster]:!border-oxide/40 group-[.toaster]:!bg-oxide-tint group-[.toaster]:!text-ink'
        }
      }}
      {...props}
    />
  );
};

export { Toaster };
