import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../ui/button';
import Header from './Header';
import Pagination from './Pagination';
import { LuLoader2 } from 'react-icons/lu';
import useTranslation from 'next-translate/useTranslation';

function _computeChunks(chunkSize, data = []) {
  const chunks = [];
  let index = 0;
  while (index < data.length) {
    const endIndex = index + chunkSize;
    if (endIndex < data.length) {
      chunks.push(data.slice(index, endIndex));
      index += chunkSize;
    } else {
      chunks.push(data.slice(index));
      index = data.length;
    }
  }
  return chunks.length > 0 ? chunks : [[]];
}

export default function List({
  data,
  filters,
  filterFn,
  renderActions,
  renderList,
  onLoadMore,
  hasMore,
  isLoadingMore
}) {
  const { t } = useTranslation('common');
  const pageSize = 21;
  const [pageIndex, setPageIndex] = useState(1);
  const [filteredData, setFilteredData] = useState([]);
  const chunks = useMemo(
    () => _computeChunks(pageSize, filteredData),
    [filteredData]
  );

  // Reset page index when chunks shrink below current page
  useEffect(() => {
    if (pageIndex > chunks.length) {
      setPageIndex(1);
    }
  }, [chunks.length, pageIndex]);

  const handleSearch = useCallback(
    (filters, text) => {
      const newFilters = {
        searchText: text,
        statuses: filters.filter(({ id }) => id).map(({ id }) => id)
      };
      setFilteredData(filterFn(data, newFilters));
    },
    [data, filterFn]
  );

  const handlePageChange = useCallback((pageIndex) => {
    setPageIndex(pageIndex);
  }, []);

  // Clamp pageIndex to valid range for rendering
  const safePageIndex = Math.min(pageIndex, chunks.length);

  return (
    <div className="flex flex-col gap-8">
      <Header
        filters={filters}
        renderActions={renderActions}
        onSearch={handleSearch}
      />

      {renderList?.({ data: chunks[safePageIndex - 1] || [] })}

      <div className="flex flex-col items-center gap-4">
        <Pagination
          chunks={chunks}
          data={filteredData}
          onChange={handlePageChange}
        />

        {hasMore && onLoadMore && (
          <Button
            variant="outline"
            onClick={onLoadMore}
            disabled={isLoadingMore}
            className="w-full max-w-xs"
            data-cy="loadMoreBtn"
          >
            {isLoadingMore ? (
              <>
                <LuLoader2 className="size-4 mr-2 animate-spin" />
                {t('Loading...')}
              </>
            ) : (
              t('Load more')
            )}
          </Button>
        )}
      </div>
    </div>
  );
}
