import {
  LuBuilding2,
  LuKeyRound,
  LuLayoutDashboard,
  LuMenu,
  LuSettings,
  LuUserCircle,
  LuUsers,
  LuWallet
} from 'react-icons/lu';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger
} from './ui/sheet';
import { useCallback, useContext, useEffect, useState } from 'react';
import { BsReceipt } from 'react-icons/bs';
import { Button } from './ui/button';
import { cn } from '../utils';
import config from '../config';
import moment from 'moment';
import { Separator } from './ui/separator';
import SideMenuButton from './SideMenuButton';
import { StoreContext } from '../store';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';

/*
 * AppMenu — DESIGN.md Components / Navigation Rail.
 *
 * Cream rail, 240px wide on desktop. Active item lifts to bone with a 2px
 * inset sea-blue indicator on the leading edge. The Lift-Means-Above rule:
 * the rail itself has no shadow; depth is tonal.
 */

const menuItems = [
  {
    key: 'dashboard',
    labelId: 'Dashboard',
    pathname: '/dashboard',
    Icon: LuLayoutDashboard,
    dataCy: 'dashboardNav'
  },
  {
    key: 'rents',
    labelId: 'Rents',
    pathname: '/rents/[yearMonth]',
    subPathnames: ['/payment/[tenantId]/[...param]'],
    Icon: BsReceipt,
    dataCy: 'rentsNav'
  },
  {
    key: 'tenants',
    labelId: 'Tenants',
    pathname: '/tenants',
    Icon: LuUserCircle,
    dataCy: 'tenantsNav'
  },
  {
    key: 'properties',
    labelId: 'Properties',
    pathname: '/properties',
    Icon: LuKeyRound,
    dataCy: 'propertiesNav'
  },
  {
    key: 'buildings',
    labelId: 'Buildings',
    pathname: '/buildings',
    Icon: LuBuilding2,
    dataCy: 'buildingsNav'
  },
  {
    key: 'owners',
    labelId: 'Owners',
    pathname: '/owners',
    Icon: LuUsers,
    dataCy: 'ownersNav'
  },
  {
    key: 'accounting',
    labelId: 'Accounting',
    pathname: '/accounting/[year]',
    Icon: LuWallet,
    dataCy: 'accountingNav'
  },
  {
    key: 'settings',
    labelId: 'Settings',
    pathname: '/settings',
    Icon: LuSettings,
    dataCy: 'settingsNav'
  },
  {
    hidden: true,
    key: 'account',
    labelId: 'Settings',
    pathname: '/settings/account'
  },
  {
    hidden: true,
    key: 'organizations',
    labelId: 'Settings',
    pathname: '/settings/organizations'
  },
  {
    hidden: true,
    key: 'landlord',
    labelId: 'Settings',
    pathname: '/settings/landlord'
  },
  {
    hidden: true,
    key: 'billing',
    labelId: 'Settings',
    pathname: '/settings/billing'
  },
  {
    hidden: true,
    key: 'contracts',
    labelId: 'Settings',
    pathname: '/settings/contracts'
  },
  {
    hidden: true,
    key: 'members',
    labelId: 'Settings',
    pathname: '/settings/members'
  },
  {
    hidden: true,
    key: 'thirdparties',
    labelId: 'Settings',
    pathname: '/settings/thirdparties'
  }
];

export function HamburgerMenu({ className, onChange }) {
  const { t } = useTranslation('common');
  const store = useContext(StoreContext);
  const router = useRouter();
  const [selectedMenu, setSelectedMenu] = useState();

  useEffect(() => {
    const selectedMenuItems = menuItems.filter(
      (menuItem) => router.pathname.indexOf(menuItem.pathname) !== -1
    );
    let selectedMenuItem;
    if (selectedMenuItems.length > 0) {
      selectedMenuItem = selectedMenuItems[0];
    }
    setSelectedMenu(selectedMenuItem);
  }, [router.pathname]);

  const handleMenuClick = useCallback(
    (menuItem) => {
      setSelectedMenu(menuItem);
      onChange?.(menuItem);
      let pathname = menuItem.pathname.replace(
        '[yearMonth]',
        moment().format('YYYY.MM')
      );
      pathname = pathname.replace('[year]', moment().year());
      router.push(`/${router.query.organization}${pathname}`, undefined, {
        locale: store.organization.selected.locale
      });
    },
    [onChange, router, store.organization.selected?.locale]
  );

  return (
    <div className={className}>
      <Sheet>
        <SheetTrigger asChild>
          <Button
            data-cy="appMenu"
            variant="ghost"
            size="icon"
            className="text-ink-soft hover:text-ink"
            aria-label={t('Menu')}
          >
            <LuMenu className="size-5" />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="flex flex-col px-0 bg-stone">
          <SheetHeader className="px-4">
            <div className="text-label text-ink-muted uppercase tracking-wide">
              {config.APP_NAME}
            </div>
            <SheetTitle className="!text-title !font-medium">
              {router.query.organization ||
                store.organization.selected?.name ||
                ''}
            </SheetTitle>
            <SheetDescription className="sr-only">
              {config.APP_NAME}
            </SheetDescription>
          </SheetHeader>
          <Separator className="my-2" />
          <nav className="flex-grow overflow-auto px-3 flex flex-col gap-0.5">
            {menuItems
              .filter((menuItem) => !menuItem.hidden)
              .map((item) => {
                return (
                  <SheetClose asChild key={item.key}>
                    <SideMenuButton
                      item={item}
                      selected={item === selectedMenu}
                      onClick={() => handleMenuClick(item)}
                    />
                  </SheetClose>
                );
              })}
          </nav>
        </SheetContent>
      </Sheet>
      {selectedMenu ? (
        <span className="text-title font-medium flex-grow ml-2 text-ink">
          {t(selectedMenu.labelId)}
        </span>
      ) : null}
    </div>
  );
}

export function SideMenu({ className }) {
  const store = useContext(StoreContext);
  const router = useRouter();
  const [selectedMenu, setSelectedMenu] = useState();

  useEffect(() => {
    const selectedMenuItems = menuItems.filter(
      (menuItem) => router.pathname.indexOf(menuItem.pathname) !== -1
    );
    let selectedMenuItem;
    if (selectedMenuItems.length > 0) {
      selectedMenuItem = selectedMenuItems[0];
    }
    setSelectedMenu(selectedMenuItem);
  }, [router.pathname]);

  const handleMenuClick = useCallback(
    (menuItem) => () => {
      setSelectedMenu(menuItem);
      let pathname = menuItem.pathname.replace(
        '[yearMonth]',
        moment().format('YYYY.MM')
      );
      pathname = pathname.replace('[year]', moment().year());
      router.push(`/${router.query.organization}${pathname}`, undefined, {
        locale: store.organization.selected.locale
      });
    },
    [router, store.organization.selected?.locale]
  );

  return (
    <aside
      className={cn(
        'bg-stone border-r border-stone-line flex flex-col fixed w-60 h-full z-40',
        className
      )}
    >
      <div className="px-4 pt-6 pb-3">
        <div className="text-label text-ink-muted uppercase tracking-wide mb-1">
          {config.APP_NAME}
        </div>
        <div
          className="text-title font-medium text-ink truncate"
          title={router.query.organization || store.organization.selected?.name}
        >
          {router.query.organization ||
            store.organization.selected?.name ||
            ''}
        </div>
      </div>
      <Separator />
      <nav className="flex-grow overflow-auto px-3 py-4 flex flex-col gap-0.5">
        {menuItems
          .filter((menuItem) => !menuItem.hidden)
          .map((item) => {
            return (
              <SideMenuButton
                key={item.key}
                item={item}
                selected={item === selectedMenu}
                onClick={handleMenuClick(item)}
              />
            );
          })}
      </nav>
    </aside>
  );
}
