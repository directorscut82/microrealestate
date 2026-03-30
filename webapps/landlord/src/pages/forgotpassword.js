import React, { useContext, useState } from 'react';
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

  if (store.organization.selected?.name) {
    router.push(`/${store.organization.selected.name}/dashboard`);
    return null;
  }

  return (
    <SignInUpLayout>
      {!emailSent ? (
        <>
          <div className="p-5 md:p-0 md:max-w-md w-full">
            <form
              onSubmit={handleSubmit(forgotPassword)}
              className="space-y-10"
            >
              <div className="text-2xl text-center md:text-left md:text-4xl font-medium text-secondary-foreground">
                {t('Reset your password')}
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">{t('Email Address')}</Label>
                <Input
                  id="email"
                  autoComplete="email"
                  {...register('email')}
                />
                {errors.email && (
                  <p className="text-sm text-destructive">
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
          </div>
          <div className="mt-10 lg:mt-0 lg:absolute lg:bottom-10 text-center text-muted-foreground w-full">
            <Link href="/signin" data-cy="signin">
              {t('Sign in')}
            </Link>
            .
          </div>
        </>
      ) : (
        <div className="p-5 text-center lg:text-left md:p-0 md:max-w-md w-full space-y-10">
          <div className="flex items-center justify-center lg:justify-normal text-success font-semibold">
            <LuCheckCircle />
            <span className="ml-2 text-lg my-4">{t('Check your email')}</span>
          </div>
          <div>
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
