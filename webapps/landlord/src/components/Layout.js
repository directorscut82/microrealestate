import { HamburgerMenu, SideMenu } from './AppMenu';
import { cn } from '../utils';
import EnvironmentBar from './EnvironmentBar';
import OrganizationMenu from './organization/OrganizationMenu';
import { StoreContext } from '../store';
import { Toaster } from '../components/ui/sonner';
import { useContext } from 'react';
import { useMediaQuery } from 'usehooks-ts';

/*
 * Layout — DESIGN.md app shell.
 *
 * Two-region layout: cream nav rail (240px on desktop, sheet on tablet/mobile)
 * + bone content area. The top bar floats above with a hairline rule under it,
 * not a shadow (the Flat-By-Default rule). The OrganizationMenu sits at the
 * top-right; the hamburger appears below the xl breakpoint.
 */
export default function Layout({ hideMenu, children }) {
  const store = useContext(StoreContext);
  const isXLorGreater = useMediaQuery('(min-width: 1280px)', {
    initializeWithValue: false
  });

  return (
    <>
      {hideMenu ? (
        <>
          <div className="sticky top-0 z-50 bg-bone border-b border-stone-line">
            <EnvironmentBar />
          </div>
          <div className={cn('flex-grow')}>{children}</div>
        </>
      ) : (
        <>
          <div className="sticky top-0 z-50 bg-bone border-b border-stone-line">
            <EnvironmentBar />
            {store.user?.signedIn ? (
              <div className="flex items-center xl:justify-end w-full gap-2 px-4 py-2">
                {!isXLorGreater ? (
                  <HamburgerMenu className="flex flex-grow items-center" />
                ) : null}
                <OrganizationMenu />
              </div>
            ) : null}
          </div>
          <div className="flex">
            {store.user?.signedIn && isXLorGreater ? <SideMenu /> : null}
            <div
              className={cn(
                'flex-grow min-h-screen',
                store.user?.signedIn ? 'xl:ml-60' : ''
              )}
            >
              {children}
            </div>
          </div>
        </>
      )}

      <Toaster position="bottom-center" closeButton />
    </>
  );
}
