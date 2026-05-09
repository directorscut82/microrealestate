import {
  PaginationContent,
  PaginationItem,
  PaginationLink,
  Pagination as PrimitivePagination
} from '../ui/pagination';
import { useCallback, useEffect, useState } from 'react';

export default function Pagination({ chunks, onChange }) {
  const [selectedPage, setSelectedPage] = useState(1);

  // Reset to page 1 when chunks shrink below selected page
  useEffect(() => {
    if (selectedPage > chunks.length) {
      setSelectedPage(1);
      onChange?.(1);
    }
  }, [chunks.length, selectedPage, onChange]);

  const handlePageChange = useCallback(
    (index) => {
      setSelectedPage(index + 1);
      onChange?.(index + 1);
    },
    [onChange]
  );

  return chunks.length > 1 ? (
    <PrimitivePagination>
      <PaginationContent>
        {chunks.map((_, index) => (
          <PaginationItem key={index}>
            <PaginationLink
              href="#"
              isActive={selectedPage === index + 1}
              onClick={() => handlePageChange(index)}
            >
              {index + 1}
            </PaginationLink>
          </PaginationItem>
        ))}
      </PaginationContent>
    </PrimitivePagination>
  ) : null;
}
