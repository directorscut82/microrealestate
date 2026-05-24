import SearchFilterBar from '../SearchFilterBar';

/*
 * ResourceList/Header — DESIGN.md flat-toolbar.
 *
 * No card surface. The bar is part of the page; the controls inside have
 * their own bone surfaces (Input, Button) and provide the visual binding.
 * The mobile action area becomes a fixed bottom strip on small screens.
 */
export default function Header({ filters, renderActions, onSearch }) {
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-center md:gap-4">
      <SearchFilterBar
        filters={filters}
        onSearch={onSearch}
        className="flex-grow"
      />
      <div className="fixed bottom-0 left-0 bg-bone p-4 w-full z-40 border-t border-stone-line md:relative md:bg-transparent md:p-0 md:w-auto md:z-auto md:border-0">
        {renderActions()}
      </div>
    </div>
  );
}
