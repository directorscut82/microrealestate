import {
  RiDeleteBin2Line,
  RiDeleteColumn,
  RiDeleteRow,
  RiInsertColumnLeft,
  RiInsertColumnRight,
  RiInsertRowBottom,
  RiInsertRowTop,
  RiMergeCellsHorizontal,
  RiSplitCellsHorizontal,
  RiTable2
} from 'react-icons/ri';
import { Button } from '../ui/button';
import { Separator } from '../ui/separator';

import useTranslation from 'next-translate/useTranslation';
const TableMenu = ({ editor }) => {
  const { t } = useTranslation('common');
  return editor ? (
    <div className="flex">
      <Button
        variant="ghost"
        size="icon"
        onClick={() =>
          editor.commands.insertTable({
            rows: 1,
            cols: 2,
            withHeaderRow: false
          })
        }
        disabled={!editor.isEditable}
      aria-label={t('Insert table')}
      >
        <RiTable2 />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        disabled={!editor.isEditable || !editor.can().deleteTable()}
        onClick={() => editor.chain().focus().deleteTable().run()}
      aria-label={t('Delete table')}
      >
        <RiDeleteBin2Line />
      </Button>
      <Separator orientation="vertical" />
      <Button
        variant="ghost"
        size="icon"
        disabled={!editor.isEditable || !editor.can().addColumnBefore()}
        onClick={() => editor.chain().focus().addColumnBefore().run()}
      aria-label={t('Insert column left')}
      >
        <RiInsertColumnLeft />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        disabled={!editor.isEditable || !editor.can().addColumnAfter()}
        onClick={() => editor.chain().focus().addColumnAfter().run()}
      aria-label={t('Insert column right')}
      >
        <RiInsertColumnRight />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        disabled={!editor.isEditable || !editor.can().deleteColumn()}
        onClick={() => editor.chain().focus().deleteColumn().run()}
      aria-label={t('Delete column')}
      >
        <RiDeleteColumn />
      </Button>
      <Separator orientation="vertical" />
      <Button
        variant="ghost"
        size="icon"
        disabled={!editor.isEditable || !editor.can().addRowBefore()}
        onClick={() => editor.chain().focus().addRowBefore().run()}
      aria-label={t('Insert row above')}
      >
        <RiInsertRowTop />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        disabled={!editor.isEditable || !editor.can().addRowAfter()}
        onClick={() => editor.chain().focus().addRowAfter().run()}
      aria-label={t('Insert row below')}
      >
        <RiInsertRowBottom />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        disabled={!editor.isEditable || !editor.can().deleteRow()}
        onClick={() => editor.chain().focus().deleteRow().run()}
      aria-label={t('Delete row')}
      >
        <RiDeleteRow />
      </Button>
      <Separator orientation="vertical" />
      <Button
        variant="ghost"
        size="icon"
        disabled={!editor.isEditable || !editor.can().mergeCells()}
        onClick={() => editor.chain().focus().mergeCells().run()}
      aria-label={t('Merge cells')}
      >
        <RiMergeCellsHorizontal />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        disabled={!editor.isEditable || !editor.can().splitCell()}
        onClick={() => editor.chain().focus().splitCell().run()}
      aria-label={t('Split cell')}
      >
        <RiSplitCellsHorizontal />
      </Button>
    </div>
  ) : null;
};

export default TableMenu;
