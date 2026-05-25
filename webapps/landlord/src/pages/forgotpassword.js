import React, { useContext, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import Link from '../components/Link';
import { LuCheckCircle } from 'react-icons/lu';
import SignInUpLayout from '../components/SignInUpLayout';
import { StoreContext } from '../store';
import { toast } from 'sonner';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';

const schema = z.object({
  email: z.string().email().min(1)
});

export default function ForgotPassword() {
  const { t } = useTranslation('common');
  const store = useContext(StoreContext);
  const [emailSent, setEmailSent] = useState('');
  const router = useRouter();

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting }
  } = useForm({
    resolver: zodResolver(schema),
    defaultValues: { email: '' }
  });

  const forgotPassword = async ({ email }) => {
    try {
      const status = await store.user.forgotPassword(email);
      if (status !== 200) {
        switch (status) {
          case 422:
            toast.error(t('Some fields are missing'));
            return;
          default:
            toast.error(t('Something went wrong'));
            return;
        }
      }
      setEmailSent(email);
    } catch (error) {
      console.error(error);
      toast.error(t('Something went wrong'));
    }
  };

  const signIn = (event) => {
    event.preventDefault();
    router.push('/signin');
  };

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
      {!emailSent ? (
        <>
          <div className="space-y-2 mb-8">
            <h1 className="text-headline font-medium text-ink tracking-tight">
              {t('Reset your password')}
            </h1>
            <p className="text-body text-ink-muted">
              {t(
                "Enter your email and we'll send you a link to reset your password"
              )}
            </p>
          </div>
          <form
            onSubmit={handleSubmit(forgotPassword)}
            className="space-y-5"
          >
            <div className="space-y-1.5">
              <Label htmlFor="email">{t('Email Address')}</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                {...register('email')}
              />
              {errors.email && (
                <p className="text-label text-oxide">
                  {errors.email.message}
                </p>
              )}
            </div>
            <Button
              type="submit"
              className="w-full"
              disabled={isSubmitting}
              data-cy="submit"
            >
              {!isSubmitting ? t('Reset') : t('Reseting')}
            </Button>
          </form>
          <div className="mt-8 text-center text-body text-ink-muted">
            <Link href="/signin" data-cy="signin">
              {t('Sign in')}
            </Link>
          </div>
        </>
      ) : (
        <div className="space-y-6">
          <div className="flex items-center gap-2 text-olive">
            <LuCheckCircle className="size-5" />
            <span className="text-headline font-medium tracking-tight">
              {t('Check your email')}
            </span>
          </div>
          <div className="text-body text-ink-soft space-y-2">
            <p>
              {t('An email has been sent to your email address {{email}}', {
                email: emailSent
              })}
            </p>
            <p>
              {t('Follow the directions in the email to reset your password')}
            </p>
          </div>
          <Button onClick={signIn} className="w-full">
            {t('Done')}
          </Button>
        </div>
      )}
    </SignInUpLayout>
  );
}
