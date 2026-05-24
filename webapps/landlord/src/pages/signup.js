import React, { useContext } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import config from '../config';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import ErrorPage from 'next/error';
import Link from '../components/Link';
import SignInUpLayout from '../components/SignInUpLayout';
import { StoreContext } from '../store';
import { toast } from 'sonner';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';

const schema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email().min(1),
  password: z.string().min(1)
});

export default function SignUp() {
  const { t } = useTranslation('common');
  const store = useContext(StoreContext);
  const router = useRouter();

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting }
  } = useForm({
    resolver: zodResolver(schema),
    defaultValues: { firstName: '', lastName: '', email: '', password: '' }
  });

  if (!config.SIGNUP) {
    return <ErrorPage statusCode={404} />;
  }

  const signUp = async ({ firstName, lastName, email, password }) => {
    try {
      const status = await store.user.signUp(
        firstName,
        lastName,
        email,
        password
      );
      if (status !== 200) {
        switch (status) {
          case 422:
            toast.error(t('Some fields are missing'));
            return;
          case 409:
            toast.error(t('This user is already registered'));
            return;
          default:
            toast.error(t('Something went wrong'));
            return;
        }
      }
      router.push('/signin');
    } catch (error) {
      console.error(error);
      toast.error(t('Something went wrong'));
    }
  };

  if (store.organization.selected?.name) {
    router.push(`/${store.organization.selected.name}/dashboard`);
    return null;
  }

  return (
    <SignInUpLayout>
      <div className="space-y-2 mb-8">
        <h1 className="text-headline font-medium text-ink tracking-tight">
          {t('Sign up and manage your properties online')}
        </h1>
        <p className="text-body text-ink-muted">
          {t('Create an account in a minute')}
        </p>
      </div>
      <form onSubmit={handleSubmit(signUp)} className="space-y-5">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="firstName">{t('First name')}</Label>
            <Input id="firstName" {...register('firstName')} />
            {errors.firstName && (
              <p className="text-label text-oxide">
                {errors.firstName.message}
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lastName">{t('Last name')}</Label>
            <Input id="lastName" {...register('lastName')} />
            {errors.lastName && (
              <p className="text-label text-oxide">
                {errors.lastName.message}
              </p>
            )}
          </div>
        </div>
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
        <Button
          type="submit"
          className="w-full"
          disabled={isSubmitting}
          data-cy="submit"
        >
          {!isSubmitting ? t('Agree & Join') : t('Joining')}
        </Button>
      </form>
      <div className="mt-8 text-center text-body text-ink-muted">
        {t('Already on {{APP_NAME}}?', { APP_NAME: config.APP_NAME })}{' '}
        <Link href="/signin" data-cy="signin">
          {t('Sign in')}
        </Link>
      </div>
    </SignInUpLayout>
  );
}
