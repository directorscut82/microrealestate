import React, { useContext } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import Link from '../../components/Link';
import SignInUpLayout from '../../components/SignInUpLayout';
import { StoreContext } from '../../store';
import { toast } from 'sonner';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';

const schema = z
  .object({
    password: z.string().min(1),
    confirmationPassword: z.string().min(1)
  })
  .refine((data) => data.password === data.confirmationPassword, {
    message: 'Passwords must match',
    path: ['confirmationPassword']
  });

export default function ResetPassword() {
  const { t } = useTranslation('common');
  const store = useContext(StoreContext);
  const router = useRouter();

  const { resetToken } = router.query;

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting }
  } = useForm({
    resolver: zodResolver(schema),
    defaultValues: { password: '', confirmationPassword: '' }
  });

  const resetPassword = async ({ password }) => {
    try {
      const status = await store.user.resetPassword(resetToken, password);
      if (status !== 200) {
        switch (status) {
          case 422:
            toast.error(t('Some fields are missing'));
            return;
          case 403:
            toast.error(t('Invalid reset link'));
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

  return (
    <SignInUpLayout>
      <>
        <div className="p-5 md:p-0 md:max-w-md w-full">
          <form
            onSubmit={handleSubmit(resetPassword)}
            className="space-y-10"
          >
            <div className="text-2xl text-center md:text-left md:text-4xl font-medium text-secondary-foreground">
              {t('Reset your password')}
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">{t('New password')}</Label>
              <Input
                id="password"
                type="password"
                {...register('password')}
              />
              {errors.password && (
                <p className="text-sm text-destructive">
                  {errors.password.message}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirmationPassword">
                {t('Confirmation password')}
              </Label>
              <Input
                id="confirmationPassword"
                type="password"
                {...register('confirmationPassword')}
              />
              {errors.confirmationPassword && (
                <p className="text-sm text-destructive">
                  {errors.confirmationPassword.message}
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
    </SignInUpLayout>
  );
}
