import {
  DEFAULT_LOCALE,
  getLocaleFromPathname,
  LOCALES
} from '@/utils/i18n/common';
import getServerEnv from './utils/env/server';
import { Locale } from '@microrealestate/types';
import { match } from '@formatjs/intl-localematcher';
import Negotiator from 'negotiator';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

const GATEWAY_URL =
  getServerEnv('DOCKER_GATEWAY_URL') ||
  getServerEnv('GATEWAY_URL') ||
  'http://localhost';

export async function middleware(request: NextRequest) {
  let nextResponse = injectLocale(request);
  if (nextResponse) {
    return nextResponse;
  }

  if (getServerEnv('DEMO_MODE') !== 'true') {
    nextResponse = await redirectSignIn(request);
    if (nextResponse) {
      return nextResponse;
    }
  }

  nextResponse = redirectDashboard(request);
  if (nextResponse) {
    return nextResponse;
  }

  return injectXPathHeader(request);
}

export const config = {
  matcher: [
    // Skip all paths which do not need to be localized
    '/((?!api|health|_next/static|_next/image|favicon.svg|welcome.svg).*)',
    '/'
  ]
};

function getRequestLocale(request: NextRequest) {
  const requestHeaders: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    requestHeaders[key] = value;
  });
  const languages = new Negotiator({ headers: requestHeaders }).languages();
  try {
    return match(languages, LOCALES, DEFAULT_LOCALE) as Locale;
  } catch {
    return DEFAULT_LOCALE as Locale;
  }
}

function injectLocale(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const requestLocale = getRequestLocale(request);
  const pathnameLocale = getLocaleFromPathname(pathname);
  const locale = pathnameLocale || requestLocale;

  if (!pathnameLocale) {
    request.nextUrl.pathname = `/${locale}${pathname}`;
    console.debug('====>', pathname, 'redirected to', request.nextUrl.pathname);
    return NextResponse.redirect(request.nextUrl);
  }
}

const REDIRECT_LOOP_HEADER = 'x-mre-signin-redirects';
const MAX_SIGNIN_REDIRECTS = 3;

async function redirectSignIn(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const locale = getLocaleFromPathname(pathname);

  if (
    [`/${locale}/signin`, `/${locale}/otp`].some(
      (p) => pathname === p || pathname.startsWith(p + '/')
    )
  ) {
    return;
  }

  // Redirect loop guard: short-circuit if we've already bounced too many times.
  const prevRedirects = Number(
    request.headers.get(REDIRECT_LOOP_HEADER) || '0'
  );
  if (prevRedirects >= MAX_SIGNIN_REDIRECTS) {
    console.error(
      `redirectSignIn: redirect loop detected (${prevRedirects} hops) for ${pathname}`
    );
    return;
  }

  let session = null;
  try {
    const response = await fetch(
      `${GATEWAY_URL}/api/v2/authenticator/tenant/session`,
      {
        headers: {
          cookie: `sessionToken=${
            request.cookies.get('sessionToken')?.value || ''
          }`
        },
        signal: AbortSignal.timeout(5000)
      }
    );
    if (response.status === 200) {
      session = await response.json();
    }
  } catch (error) {
    console.error(error);
  }

  if (!session) {
    request.nextUrl.pathname = '/signin';
    const response = NextResponse.redirect(request.nextUrl);
    response.headers.set(
      REDIRECT_LOOP_HEADER,
      String(prevRedirects + 1)
    );
    return response;
  }
}

function redirectDashboard(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const locale = getLocaleFromPathname(pathname);

  if (pathname === '/' || pathname === `/${locale}`) {
    request.nextUrl.pathname = `/${locale}/dashboard`;
    console.debug('====>', pathname, 'redirected to', request.nextUrl.pathname);
    return NextResponse.redirect(request.nextUrl);
  }
}

function injectXPathHeader(request: NextRequest) {
  // The x-path header is used to determine the current locale from the server side components
  const { pathname } = request.nextUrl;
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-path', pathname);
  return NextResponse.next({
    request: {
      headers: requestHeaders
    }
  });
}
