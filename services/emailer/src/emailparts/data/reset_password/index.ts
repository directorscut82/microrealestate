import { Collections } from '@microrealestate/common';

export async function get(email: string, params: Record<string, any>) {
  const dbAccount = await Collections.Account.findOne({ email });
  if (!dbAccount) {
    throw new Error('user not found');
  }

  const account = dbAccount.toObject();

  return {
    firstname: account.firstname,
    token: params.token,
    useAppEmailService: true
  };
}
