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
  renderSubFilters,
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

  // No init useEffect here. SearchFilterBar (rendered inside <Header>)
  // owns the search/filter state and runs its own useEffect on mount —
  // that effect calls onSearch (= handleSearch below) with the current
  // search text and selected filter ids, populating filteredData. When
  // `data` refetches (background invalidation, focus refetch),
  // handleSearch's identity changes (deps include `data`), which makes
  // SearchFilterBar's useEffect refire with the user's CURRENT search
  // state — preserving the user's filter through refetches.
  //
  // The previous init useEffect here (with empty defaults) was clobbering
  // the user's typed search whenever data refetched: it ran AFTER
  // SearchFilterBar's effect (parent effects fire after child effects),
  // overwriting the filtered list with the unfiltered data. Removed
  // entirely; rely on SearchFilterBar as the single source of truth.

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
      // Guard against `data` being undefined while useQuery is still
      // loading. SearchFilterBar's useEffect fires onSearch on mount
      // before the query resolves; without this guard the consumer's
      // filterFn dereferences undefined (e.g. data.rents on the rents
      // page) and throws. handleSearch identity changes when data lands
      // (deps include data), which re-triggers SearchFilterBar's effect
      // to populate the list correctly.
      if (data == null) {
        setFilteredData([]);
        return;
      }
      try {
        const next = filterFn(data, newFilters);
        setFilteredData(Array.isArray(next) ? next : []);
      } catch {
        setFilteredData(Array.isArray(data) ? data : []);
      }
    },
    [data, filterFn]
  );

  const handlePageChange = useCallback((pageIndex) => {
    setPageIndex(pageIndex);
  }, []);

  // Clamp pageIndex to valid range for rendering
  const safePageIndex = Math.min(pageIndex, chunks.length);

  return (
    <div className="flex flex-col gap-6">
      <Header
        filters={filters}
        renderActions={renderActions}
        onSearch={handleSearch}
      />

      {renderSubFilters ? (
        <div className="flex justify-end -mt-3">{renderSubFilters()}</div>
      ) : null}

      {renderList?.({ data: chunks[safePageIndex - 1] || [] })}

      <div className="flex flex-col items-center gap-4">
        <Pagination
          chunks={chunks}
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
