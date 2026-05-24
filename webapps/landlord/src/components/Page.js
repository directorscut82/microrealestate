import { cn } from '../utils';
import Loading from './Loading';

/*
 * Page — DESIGN.md app shell page wrapper.
 *
 * The cream body sits behind every page; content lifts onto bone surfaces.
 * The optional ActionBar sticks to the bottom on mobile (a fixed strip with
 * a top hairline) and floats inline on desktop. No nested-card pattern; the
 * action bar is its own surface, not a card-in-a-card.
 */
function Page({ children, ActionBar, loading = false, dataCy, className }) {
  return (
    <div
      data-cy={dataCy}
      className={cn(
        'mx-auto w-full max-w-[1280px] px-4 md:px-8 pt-6 pb-28 md:pb-8',
        className
      )}
    >
      {ActionBar && !loading ? (
        <div
          className={cn(
            'fixed bottom-0 left-0 right-0 z-40 w-full bg-bone border-t border-stone-line px-4 py-3',
            'md:relative md:z-auto md:bg-transparent md:border-0 md:px-0 md:pt-0 md:pb-6'
          )}
        >
          {ActionBar}
        </div>
      ) : null}
      {loading ? <Loading /> : children}
    </div>
  );
}

export default Page;
