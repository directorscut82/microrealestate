export type ParsedBill = {
  provider: 'deh' | 'eydap' | 'epa' | 'other';
  billingId: string;
  billingIdNormalized: string;
  totalAmount: number;
  periodStart: Date;
  periodEnd: Date;
  issueDate?: Date;
  dueDate?: Date;
  rfCode?: string;
  irisCodeImage?: Buffer;
};

export type BillParseResult = {
  success: boolean;
  bill?: ParsedBill;
  error?: string;
};

export function normalizeBillingId(id: string): string {
  return id.replace(/[\s\-\.]/g, '');
}
