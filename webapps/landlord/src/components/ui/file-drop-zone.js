import { LuFileUp, LuX } from 'react-icons/lu';
import React, { useCallback, useRef, useState } from 'react';
import { cn } from '../../utils';
import useTranslation from 'next-translate/useTranslation';

export default function FileDropZone({
  accept = '.pdf',
  multiple = false,
  files = [],
  onFilesChange,
  disabled = false,
  description
}) {
  const { t } = useTranslation('common');
  const inputRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleDragEnter = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      if (disabled) return;

      const droppedFiles = Array.from(e.dataTransfer.files).filter((f) =>
        f.name.toLowerCase().endsWith('.pdf')
      );
      if (droppedFiles.length === 0) return;

      if (multiple) {
        onFilesChange([...files, ...droppedFiles]);
      } else {
        onFilesChange([droppedFiles[0]]);
      }
    },
    [disabled, files, multiple, onFilesChange]
  );

  const handleClick = useCallback(() => {
    if (!disabled) {
      inputRef.current?.click();
    }
  }, [disabled]);

  const handleInputChange = useCallback(
    (e) => {
      const selectedFiles = Array.from(e.target.files || []);
      if (selectedFiles.length === 0) return;

      if (multiple) {
        onFilesChange([...files, ...selectedFiles]);
      } else {
        onFilesChange([selectedFiles[0]]);
      }
      if (inputRef.current) inputRef.current.value = '';
    },
    [files, multiple, onFilesChange]
  );

  const handleRemoveFile = useCallback(
    (index) => {
      const newFiles = files.filter((_, i) => i !== index);
      onFilesChange(newFiles);
    },
    [files, onFilesChange]
  );

  return (
    <div className="space-y-3">
      <div
        onClick={handleClick}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        className={cn(
          'border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors',
          isDragging && 'border-primary bg-primary/5',
          !isDragging && !disabled && 'border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/50',
          disabled && 'opacity-50 cursor-not-allowed border-muted'
        )}
      >
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          multiple={multiple}
          onChange={handleInputChange}
          className="hidden"
          disabled={disabled}
        />
        <div className="flex flex-col items-center gap-2">
          <LuFileUp className="size-10 text-muted-foreground" />
          <div className="space-y-1">
            <p className="text-sm font-medium">
              {multiple
                ? t('Drop PDF files here or click to browse')
                : t('Drop a PDF file here or click to browse')}
            </p>
            {description && (
              <p className="text-xs text-muted-foreground">{description}</p>
            )}
          </div>
        </div>
      </div>

      {files.length > 0 && (
        <div className="space-y-2">
          {files.map((file, index) => (
            <div
              key={`${file.name}-${index}`}
              className="flex items-center gap-2 p-2 border rounded-md bg-muted/30"
            >
              <LuFileUp className="size-4 text-muted-foreground shrink-0" />
              <span className="text-sm truncate flex-1">{file.name}</span>
              <span className="text-xs text-muted-foreground shrink-0">
                {(file.size / 1024).toFixed(0)} KB
              </span>
              {!disabled && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRemoveFile(index);
                  }}
                  className="p-1 hover:bg-destructive/10 rounded"
                >
                  <LuX className="size-3.5 text-destructive" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
