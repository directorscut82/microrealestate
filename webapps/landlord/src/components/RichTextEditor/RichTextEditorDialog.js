import {
  Dialog,
  DialogContent,
  DialogTitle
} from '../ui/dialog';
import dynamic from 'next/dynamic';
import { useCallback } from 'react';

const RichTextEditor = dynamic(import('./RichTextEditor'), {
  ssr: false
});

export default function RichTextEditorDialog({
  open,
  setOpen,
  onLoad,
  onSave,
  title,
  fields,
  editable
}) {
  const handleClose = useCallback(() => {
    setOpen(false);
  }, [setOpen]);

  return (
    <Dialog open={!!open} onOpenChange={setOpen}>
      <DialogContent
        className="max-w-full h-full p-0 border-0 rounded-none"
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogTitle className="hidden">{title}</DialogTitle>
        <RichTextEditor
          title={title}
          fields={fields}
          onLoad={onLoad}
          onSave={onSave}
          onClose={handleClose}
          showPrintButton
          editable={editable}
        />
      </DialogContent>
    </Dialog>
  );
}
