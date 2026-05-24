import React, { useCallback, useContext, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import config from '../config';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import Link from '../components/Link';
import { setOrganizationId } from '../utils/fetch';
import SignInUpLayout from '../components/SignInUpLayout';
import { StoreContext } from '../store';
import { toast } from 'sonner';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';

const schema = z.object({
  email: z.string().email().min(1),
  password: z.string().min(1)
});

export default function SignIn() {
  const { t } = useTranslation('common');
  const store = useContext(StoreContext);
  const router = useRouter();

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting }
  } = useForm({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '' }
  });

  useEffect(() => {
    const match = document.cookie.match(/(?:^|; )locale=([^;]*)/);
    const savedLocale = match ? match[1] : null;
    if (savedLocale && savedLocale !== router.locale) {
      router.replace('/signin', undefined, { locale: savedLocale });
    }
  }, []);

  useEffect(() => {
    if (config.DEMO_MODE) {
      reset({ email: 'demo@demo.com', password: 'demo' });
    }
  }, [reset]);

  const signIn = useCallback(
    async ({ email, password }) => {
      try {
        const status = await store.user.signIn(email, password);
        if (status !== 200) {
          switch (status) {
            case 422:
              toast.error(t('Some fields are missing'));
              return;
            case 401:
              toast.error(t('Incorrect email or password'));
              return;
            default:
              toast.error(t('Something went wrong'));
              return;
          }
        }

        await store.organization.fetch();
        if (store.organization.items.length) {
          if (!store.organization.selected) {
            store.organization.setSelected(
              store.organization.items[0],
              store.user
            );
          }
          setOrganizationId(store.organization.selected._id);
          const orgLocale = store.organization.selected.locale;
          document.cookie = `locale=${orgLocale};path=/landlord;max-age=31536000`;
          router.push(
            `/${store.organization.selected.name}/dashboard`,
            undefined,
            {
              locale: store.organization.selected.locale
            }
          );
        } else {
          router.push('/firstaccess');
        }
      } catch (error) {
        console.error(error);
        toast.error(t('Something went wrong'));
      }
    },
    [router, store, t]
  );

  useEffect(() => {
    if (store.organization.selected?.name) {
      router.push(`/${store.organization.selected.name}/dashboard`);
    }
  }, [store.organization.selected?.name, router]);

  if (store.organization.selected?.name) {
    return null;
  }

  return (
    <SignInUpLayout>
      <div className="space-y-2 mb-8">
        <h1 className="text-headline font-medium text-ink tracking-tight">
          {t('Sign in to your account')}
        </h1>
        <p className="text-body text-ink-muted">
          {t('Welcome back')}
        </p>
      </div>
      <form onSubmit={handleSubmit(signIn)} className="space-y-5">
        <div className="space-y-1.5">
          <Label htmlFor="email">{t('Email Address')}</Label>
          <Input id="email" {...register('email')} />
          {errors.email && (
            <p className="text-label text-oxide">{errors.email.message}</p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="password">{t('Password')}</Label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            {...register('password')}
          />
          {errors.password && (
            <p className="text-label text-oxide">
              {errors.password.message}
            </p>
          )}
        </div>
        {!config.DEMO_MODE && (
          <div className="flex justify-end">
            <Link
              href="/forgotpassword"
              data-cy="forgotpassword"
              className="text-label"
            >
              {t('Forgot password?')}
            </Link>
          </div>
        )}
        <Button
          type="submit"
          className="w-full"
          disabled={isSubmitting}
          data-cy="submit"
        >
          {!isSubmitting ? t('Sign in') : t('Signing in')}
        </Button>
      </form>
      {!config.DEMO_MODE && config.SIGNUP && (
        <div className="mt-8 text-center text-body text-ink-muted">
          {t('New to {{APP_NAME}}?', { APP_NAME: config.APP_NAME })}{' '}
          <Link href="/signup" data-cy="signup">
            {t('Create an account')}
          </Link>
        </div>
      )}
    </SignInUpLayout>
  );
}
