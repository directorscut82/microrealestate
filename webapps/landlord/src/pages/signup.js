import React, { useContext, useEffect } from 'react';
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
  // Mirror the SERVER's real rule (MIN/MAX_PASSWORD_LENGTH, authenticator
  // landlord.ts:19-20). At .min(1) the form happily submitted a 1-char password and
  // the resulting 422 was shown as "some fields are missing".
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
  confirmPassword: z.string().min(1)
}).refine((d) => d.password === d.confirmPassword, {
  // The form has ONE masked password box, so a typo becomes the account hash and the
  // landlord is locked out of an account that was just created successfully.
  message: 'Passwords do not match',
  path: ['confirmPassword']
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

  useEffect(() => {
    if (store.organization.selected?.name) {
      router.push(`/${store.organization.selected.name}/dashboard`);
    }
  }, [store.organization.selected?.name, router]);

  if (!config.SIGNUP) {
    return <ErrorPage statusCode={404} />;
  }

  const signUp = async ({ firstName, lastName, email, password }) => {
    try {
      const [status, apiMessage] = await store.user.signUp(
        firstName,
        lastName,
        email,
        password
      );
      if (status !== 200) {
        switch (status) {
          case 422:
            // Prefer the server's reason. The blanket "some fields are missing"
            // contradicted a fully-filled form.
            toast.error(apiMessage || t('Some fields are missing'));
            return;
          case 429:
            // authRateLimit sends Retry-After: 60 and a message; this used to fall
            // into `default` and read as a server fault, so the landlord retried
            // immediately and kept the bucket full.
            toast.error(
              apiMessage || t('Too many attempts, please try again in a minute')
            );
            return;
          default:
            toast.error(apiMessage || t('Something went wrong'));
            return;
        }
      }
      // The server answers 201 for an ALREADY-REGISTERED email on purpose, to block
      // account enumeration, so a silent redirect looked like "account created" when
      // it may not have been. Say something true for both cases. (The old `case 409`
      // was dead code — grep finds no 409 anywhere in services/authenticator.)
      toast.success(
        t(
          'If this email was new, your account is ready — otherwise sign in or reset your password'
        )
      );
      router.push('/signin');
    } catch (error) {
      console.error(error);
      toast.error(t('Something went wrong'));
    }
  };

  if (store.organization.selected?.name) {
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
          <Input
            id="email"
            type="email"
            autoComplete="username"
            {...register('email')}
          />
          {errors.email && (
            <p className="text-label text-oxide">{errors.email.message}</p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="password">{t('Password')}</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            {...register('password')}
          />
          {errors.password && (
            <p className="text-label text-oxide">
              {t(errors.password.message)}
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="confirmPassword">{t('Confirm password')}</Label>
          <Input
            id="confirmPassword"
            type="password"
            autoComplete="new-password"
            {...register('confirmPassword')}
          />
          {errors.confirmPassword && (
            <p className="text-label text-oxide">
              {t(errors.confirmPassword.message)}
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
