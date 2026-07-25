import {
  AllocationMethod,
  ContractorSpecialty,
  ExpenseType,
  HeatingType,
  LeaseTimeRange,
  Locale,
  OccupancyType,
  PaymentMethod,
  RepairCategory,
  RepairStatus,
  RepairUrgency,
  UnitOwnerType,
  UserRole
} from './index.js';

export type MongooseDocument<T> = {
  __v: number;
  save: () => Promise<T>;
  toObject: () => T;
} & T;

/* eslint-disable @typescript-eslint/no-namespace */
export namespace CollectionTypes {
  export type PartAddress = {
    street1: string;
    street2?: string;
    zipCode: string;
    city: string;
    state?: string;
    country: string;
  };

  export type Account = {
    _id: string;
    firstname: string;
    lastname: string;
    email: string;
    password: string;
    createdDate?: Date;
  };

  export type Realm = {
    _id: string;
    name: string;
    members: {
      name: string;
      email: string;
      role: UserRole;
      registered: boolean;
    }[];
    applications: {
      name: string;
      role: UserRole;
      clientId: string;
      clientSecret: string;
      createdDate: Date;
      expiryDate: Date;
    }[];
    addresses: CollectionTypes.PartAddress[];
    bankInfo: {
      name: string;
      iban: string;
    };
    contacts: {
      name: string;
      email: string;
      phone1: string;
      phone2: string;
    }[];
    isCompany: boolean;
    companyInfo: {
      name: string;
      legalStructure: string;
      legalRepresentative: string;
      capital: number;
      ein: string;
      dos: string;
      // E11: align the type with the runtime shape. The Mongoose schema
      // (services/common/src/collections/realm.ts), the PDF templates
      // (services/pdfgenerator/templates), and the landlord frontend
      // (webapps/landlord/src/components/organization/BillingForm.js)
      // all read/write `vatNumber` (camelCase). The previous lowercase
      // `vatnumber` in this type meant every consumer was forced to
      // bypass the type system with `(realm as any).companyInfo.vatNumber`.
      vatNumber: string;
    };
    thirdParties: {
      gmail: {
        selected: boolean;
        email: string;
        appPassword: string;
        fromEmail: string;
        replyToEmail: string;
      };
      smtp?: {
        selected: boolean;
        server: string;
        port: number;
        secure: boolean;
        authentication: boolean;
        username: string;
        password: string;
        fromEmail: string;
        replyToEmail: string;
      };
      mailgun: {
        selected: boolean;
        apiKey: string;
        domain: string;
        fromEmail: string;
        replyToEmail: string;
      };
      b2: {
        keyId: string;
        applicationKey: string;
        endpoint: string;
        bucket: string;
      };
      smsGateway: {
        selected: boolean;
        url: string;
        username: string;
        password: string;
        countryCode?: string;
      };
      // Telegram bot channel (push notifications). botToken is encrypted at
      // rest. adminChatId is the chat the bot messages for admin/self
      // notifications. Optional — legacy realms predate it.
      telegram?: {
        selected: boolean;
        botToken: string;
        adminChatId: string;
      };
      // Inbox readers (multiple mailboxes) for auto-detecting incoming bills.
      // Separate from the single SENDING provider above. clientSecret +
      // refreshToken are encrypted at rest.
      mailReaders?: {
        provider: string;
        email: string;
        clientId: string;
        clientSecret: string;
        refreshToken: string;
        label?: string;
      }[];
    };
    locale: Locale;
    currency: string;
  };

  export type Document = {
    _id: string;
    realmId: string;
    // Exactly ONE of tenantId / buildingId / ownerKey identifies the entity
    // the document belongs to (route-enforced). tenantId+leaseId were
    // historically required (tenant docs); building/owner docs set neither.
    tenantId?: string;
    leaseId?: string;
    buildingId?: string;
    ownerKey?: string;
    templateId?: string;
    type: 'text' | 'file' | 'fileDescriptor';
    name: string;
    description: string;
    mimeType?: string;
    expiryDate?: Date;
    contents?: Record<string, any>;
    html?: string;
    url?: string;
    versionId?: string;
    createdDate: Date;
    updatedDate: Date;
  };

  export type Email = {
    _id: string;
    realmId: string;
    templateName: string;
    recordId: string;
    params: Record<string, any>;
    sentTo: string;
    sentDate: Date;
    status: string;
    emailId: string;
    // Optional message captured when status is 'failed'. Mirrors the
    // schema field on services/common/src/collections/email.ts.
    error?: string;
  };

  export type Lease = {
    _id: string;
    realmId: string;
    name: string;
    description: string;
    numberOfTerms: number;
    timeRange: LeaseTimeRange;
    active: boolean;
    stepperMode: boolean;
  };

  export type Property = {
    _id: string;
    realmId: string;
    type: string;
    name: string;
    description: string;
    surface: number;
    landSurface?: number;
    phone: string;
    digicode: string;
    address: CollectionTypes.PartAddress;
    price: number;
    atakNumber?: string;
    altAtakNumbers?: string[];
    // L9: cadastral code (Κ.Α.Ε.Κ.) — optional National Cadastre
    // identifier carried alongside ATAK on Greek properties.
    kaek?: string;
    dehNumber?: string;
    // Water supply number (ΕΥΔΑΠ) — sibling of dehNumber (ΔΕΗ).
    eydapNumber?: string;
    buildingId?: string | Building;
    electricitySupplyNumber?: string;
    energyCertificate?: {
      number: string;
      issueDate: Date;
      energyClass: string;
      inspectorNumber: string;
      // Expiry-notice debounce entries (windows in days before issue+5y).
      expiryNoticesSent?: { window: number; sentAt: Date }[];
    };
  };

  export type Template = {
    _id: string;
    realmId: string;
    name: string;
    type: string;
    description: string;
    hasExpiryDate: boolean;
    contents: Record<string, never>;
    html: string;
    linkedResourceIds: string[];
    required: boolean;
    requiredOnceContractTerminated: boolean;
  };

  export type PartRent = {
    term: number;
    // Set by businesslogic/tasks/1_base.ts and consumed everywhere the
    // PDF / accounting / dashboard render needs the month + year. The
    // runtime shape always carries these; the type was missing them
    // and downstream consumers had to read them via `any`.
    month?: number;
    year?: number;
    total: {
      preTaxAmount: number;
      charges: number;
      vat: number;
      discount: number;
      debts: number;
      balance: number;
      grandTotal: number;
      payment: number;
    };
    preTaxAmounts:
      | {
          amount: number;
          description: string;
        }[]
      | [];
    charges:
      | {
          amount: number;
          description: string;
        }[]
      | [];
    buildingCharges:
      | {
          description: string;
          amount: number;
          buildingName?: string;
          // Set by the rent computation pipeline at task 1_base. Used
          // by rentmanager._computeOwedByCategory and the dashboard pie
          // to bucket repair charges separately from regular building
          // expenses.
          type?: string;
        }[]
      | [];
    paymentInstructions:
      | {
          ownerName: string;
          iban: string;
          amount: number;
          percentage: number;
        }[]
      | [];
    debts:
      | {
          amount: number;
          description: string;
        }[]
      | [];
    discounts:
      | {
          origin: 'contract' | 'settlement';
          amount: number;
          description: string;
        }[]
      | [];
    vats:
      | {
          origin: 'contract' | 'settlement';
          amount: number;
          description: string;
          rate: number;
        }[]
      | [];
    payments:
      | {
          date: string;
          type: PaymentMethod;
          reference: string;
          amount: number;
          // Per-payment fields stored alongside the payment by Wave-26
          // round-3j (note/discount/extracharge attached to a specific
          // payment instead of the rent). Optional.
          description?: string;
          promo?: number;
          notepromo?: string;
          extracharge?: number;
          noteextracharge?: string;
          // Round-3r migration: explicit allocation per category.
          allocation?: { category: string; amount: number }[];
        }[]
      | [];
    description: string;
    // Flattened read-side fields produced by frontdata.toRentData on the
    // wire (NOT stored in mongo). The type historically only declared
    // the persisted shape, leaving every API response consumer to read
    // these via `any`. Declare them here so editors / typecheckers know
    // they exist on the GET responses.
    balance?: number;
    newBalance?: number;
    payment?: number;
    discount?: number;
    totalAmount?: number;
    totalToPay?: number;
    totalWithoutBalanceAmount?: number;
    totalWithoutVatAmount?: number;
    vatAmount?: number;
    promo?: number;
    notepromo?: string;
    extracharge?: number;
    noteextracharge?: string;
    hasMultiplePayments?: boolean;
    countMonthNotPaid?: number;
    paymentStatus?: { month: number; status: string }[];
    status?: 'paid' | 'partiallypaid' | 'notpaid';
    priorRents?: { term: number; newBalance: number }[];
    active?: 'active' | undefined;
    vatRatio?: number;
    uid?: string;
    emailStatus?: Record<string, unknown>;
  };

  export type Tenant = {
    _id: string;
    realmId: string;
    name: string;
    firstName?: string;
    lastName?: string;
    taxId?: string;
    phone?: string;
    email?: string;
    isCompany: boolean;
    company: string;
    manager: string;
    legalForm: string;
    siret: string;
    rcs: string;
    capital: number;
    street1: string;
    street2: string;
    zipCode: string;
    city: string;
    country: string;
    contacts: {
      contact: string;
      phone: string;
      phone1: string;
      phone2: string;
      email: string;
      // E12: free-form per-contact note. Optional — only populated when
      // the landlord types something into the per-contact "notes" input.
      notes?: string;
    }[];
    reference: string;
    contract: string;
    leaseId: string | Lease;
    beginDate: Date;
    endDate: Date;
    terminationDate: Date;
    frequency?: 'days' | 'weeks' | 'months' | 'years' | 'hours';
    properties:
      | {
          propertyId: string;
          property: CollectionTypes.Property;
          rent: number;
          expenses: [
            { title: string; amount: number; beginDate: Date; endDate: Date }
          ];
          entryDate: Date;
          exitDate: Date;
        }[]
      | [];
    rents: PartRent[] | [];
    isVat: boolean;
    vatRatio: number;
    discount: number;
    guaranty: number;
    guarantyPayback: number;

    // Greek lease import fields
    declarationNumber?: string;
    amendsDeclaration?: string;
    originalLeaseStartDate?: Date;
    leaseNotes?: string;
    coTenants?: {
      name: string;
      taxId: string;
      acceptanceDate?: Date;
    }[];

    // Lease history snapshots written by extendLease when a PDF import is
    // classified as an extension of an existing active lease.
    leaseHistory?: {
      beginDate?: Date;
      endDate?: Date;
      leaseId?: string;
      declarationNumber?: string;
      amendsDeclaration?: string;
      originalLeaseStartDate?: Date;
      archivedAt?: Date;
      supersededByDeclarationNumber?: string;
    }[];

    stepperMode: boolean;
    archived?: boolean;
    lastExpiryNoticeSentAt?: Date | null;
    expiryNoticesSent?: Array<{ window: number; sentAt: Date }>;
    // Read-side enrichment fields produced by frontdata.toOccupantData on
    // the wire (NOT stored in mongo). Document them so the API
    // response shape is type-checked end-to-end.
    contactEmails?: string[];
    hasContactEmails?: boolean;
    contactPhones?: string[];
    hasContactPhones?: boolean;
    status?: 'inprogress' | 'stopped';
    terminated?: boolean;
    lease?: Lease;
    office?: { surface: number; price: number };
    parking?: { price: number };
    rental?: number;
    expenses?: number;
    total?: number;
    preTaxTotal?: number;
    vat?: number;
    hasPayments?: boolean;
  };

  export type UnitOwner = {
    type: UnitOwnerType;
    percentage: number;
    memberId?: string;
    name?: string;
    taxId?: string;
    iban?: string;
    phone?: string;
    email?: string;
  };

  export type MonthlyCharge = {
    _id: string;
    term: number;
    amount: number;
    description: string;
    expenseId?: string | null;
    repairId?: string | null;
  };

  export type BuildingUnit = {
    _id: string;
    name?: string;
    atakNumber: string;
    altAtakNumbers?: string[];
    floor?: number;
    unitLabel?: string;
    surface?: number;
    yearBuilt?: number;
    electricitySupplyNumber?: string;
    generalThousandths?: number;
    heatingThousandths?: number;
    elevatorThousandths?: number;
    // T2.P1.14: ΕΙΔΟΣ ΔΙΚΑΙΩΜΑΤΟΣ from E9 — full ownership, bare
    // ownership (Ψιλή κυριότητα), or usufruct (Επικαρπία). Optional
    // because legacy units predate the field and default to 'full'
    // server-side via the schema default.
    rightType?: 'full' | 'bare' | 'usufruct';
    owners: UnitOwner[] | [];
    propertyId?: string | Property;
    isManaged: boolean;
    occupancyType?: OccupancyType;
    parkingAssignedTo?: string[];
    monthlyCharges: MonthlyCharge[] | [];
    // Enrichment fields populated by buildingmanager._toBuildingData on
    // the API response. Not persisted in mongo; read-only on the wire.
    property?: Property | null;
    tenant?: { _id: string; name: string } | null;
  };

  export type CustomAllocation = {
    propertyId: string;
    value: number;
  };

  export type BuildingExpense = {
    _id: string;
    name: string;
    type: ExpenseType;
    amount: number;
    allocationMethod: AllocationMethod;
    customAllocations: CustomAllocation[] | [];
    isRecurring: boolean;
    startTerm?: number;
    endTerm?: number;
    notes?: string;
    trackOwnerExpense?: boolean;
    ownerAmount?: number;
    chargeOwnerWhenVacant?: boolean;
    billingId?: string;
  };

  export type OwnerExpensePayment = {
    date: Date;
    amount: number;
    type: 'cash' | 'transfer' | 'cheque';
    reference?: string;
    description?: string;
  };

  // §5: a VOLUNTARY contribution toward a building's Αχρέωτα (uncollected
  // vacant-unit expense money). NOT a liability — nobody owes it; it never
  // appears in Οφειλές. Recorded ONLY here (not on the payer's rent/owner
  // ledger as a settling payment) so the same euro is never counted twice.
  export type UncollectedPayment = {
    term: number;
    amount: number;
    paidByType?: 'renter' | 'owner';
    payerId?: string;
    date: Date;
    reference?: string;
  };

  export type OwnerMonthlyExpense = {
    _id: string;
    expenseId: string;
    term: number;
    amount: number;
    description?: string;
    // The vacant unit whose share this owner charge represents (the two
    // vacant sources only). null/absent for the owner-direct sources.
    propertyId?: string | null;
    // 'expense'       = owner-side share of a recurring building expense.
    // 'repair'        = owner-borne portion of a repair (expenseId = repair id).
    // 'vacant'        = building-EXPENSE share of a vacant unit, routed to owner.
    // 'repair-vacant' = REPAIR share of a vacant unit, routed to owner
    //                   (expenseId = repair id). Distinct from 'vacant' so the
    //                   expense recompute does not strip it.
    // 'owner-fixed'   = materialised fixed owner-only monthly amount
    //                   (BuildingExpense.ownerAmount), payable like any other.
    // 'owner-resident'= building-EXPENSE share of an OWNER-OCCUPIED unit
    //                   (occupancyType='owner_occupied'), billed to the resident
    //                   owner — NOT a vacant unit, never shown as uncollected.
    source?:
      | 'expense'
      | 'repair'
      | 'vacant'
      | 'repair-vacant'
      | 'owner-fixed'
      | 'owner-resident';
    // Owner payments (καταβολές) recorded against this charge. Settlement is
    // DERIVED from this array; `paid`/`paidDate` are a cached convenience.
    payments?: OwnerExpensePayment[];
    paid?: boolean;
    paidDate?: Date | null;
  };

  export type Contractor = {
    _id: string;
    name: string;
    company?: string;
    specialty: ContractorSpecialty;
    phone?: string;
    email?: string;
    taxId?: string;
    notes?: string;
  };

  export type Repair = {
    _id: string;
    title: string;
    description?: string;
    category: RepairCategory;
    status: RepairStatus;
    urgency: RepairUrgency;
    reportedDate?: Date;
    startDate?: Date;
    completionDate?: Date;
    estimatedCost?: number;
    actualCost?: number;
    isPaidFromRepairsFund: boolean;
    contractorId?: string;
    affectedUnitIds: string[] | [];
    affectedArea?: string;
    invoiceReference?: string;
    invoiceDocumentId?: string | null;
    receipts?: BillReceipt[];
    notes?: string;
    chargeableTo?: 'tenants' | 'owners' | 'split';
    tenantSharePercentage?: number;
    allocationMethod?: string;
    chargeTerm?: number;
  };

  export type Building = {
    _id: string;
    realmId: string | Realm;
    name: string;
    description?: string;
    address: PartAddress;
    blockNumber?: string;
    blockStreets: string[] | [];
    atakPrefix: string;
    yearBuilt?: number;
    totalFloors?: number;
    hasElevator: boolean;
    hasCentralHeating: boolean;
    heatingType?: HeatingType;
    manager?: {
      name: string;
      phone?: string;
      email?: string;
      taxId?: string;
      company?: string;
    };
    bankInfo?: {
      name: string;
      iban: string;
    };
    units: BuildingUnit[] | [];
    expenses: BuildingExpense[] | [];
    contractors: Contractor[] | [];
    repairs: Repair[] | [];
    ownerMonthlyExpenses: OwnerMonthlyExpense[] | [];
    uncollectedPayments?: UncollectedPayment[] | [];
    notes?: string;
    createdDate?: Date;
    updatedDate?: Date;
  };

  export type BillProvider = 'deh' | 'eydap' | 'epa' | 'other';
  export type BillStatus = 'pending' | 'partial' | 'paid';

  // Slice 6 — the element bag stored per bill; a receipt's extracted elements
  // are scored against this to suggest a match.
  export type BillMatchKeys = {
    rfCodes?: string[];
    ibans?: string[];
    amounts?: number[];
    afm?: string[];
    dates?: Date[];
    nameTokens?: string[];
  };

  // Slice 6 — one recorded payment απόδειξη (installment-capable).
  export type BillReceipt = {
    amount?: number;
    date?: Date;
    proofUrl?: string;
    ocrText?: string;
    matchedOn?: string[];
    createdDate?: Date;
  };

  export type Bill = {
    _id: string;
    realmId: string;
    buildingId: string | Building;
    expenseId: string;
    provider: BillProvider;
    billingId: string;
    totalAmount: number;
    periodStart: Date;
    periodEnd: Date;
    issueDate?: Date;
    dueDate?: Date;
    term: number;
    rfCode?: string;
    paymentCode?: string;
    irisCodeBase64?: string;
    irisCodeUrl?: string;
    pdfUrl?: string;
    status: BillStatus;
    matchKeys?: BillMatchKeys;
    ocrText?: string;
    receipts?: BillReceipt[];
    paymentProofUrl?: string;
    paymentDate?: Date;
    createdDate?: Date;
    updatedDate?: Date;
  };

  // Telegram inbound-poller offset — one doc per realm, tracks the last
  // consumed getUpdates update_id so restarts never re-ingest messages.
  export type TelegramOffset = {
    _id: string;
    realmId: string;
    lastUpdateId: number;
    updatedDate?: Date;
  };

  export type InboxItemSource = 'telegram' | 'upload';
  export type InboxItemStatus = 'pending' | 'confirmed' | 'dismissed';

  export type InboxItemWarning = {
    level: 'block' | 'warn';
    code: string;
    message: string;
  };

  // A bill photo/document that arrived out-of-band (Telegram bot) and was
  // parsed server-side; waits in the landlord's inbox bell for confirm/dismiss.
  export type InboxItem = {
    _id: string;
    realmId: string;
    source: InboxItemSource;
    status: InboxItemStatus;
    parsed: {
      provider?: BillProvider;
      billingId?: string;
      billingIdNormalized?: string;
      totalAmount?: number;
      periodStart?: Date;
      periodEnd?: Date;
      issueDate?: Date;
      dueDate?: Date;
      rfCode?: string;
      paymentCode?: string;
      proposedTerm?: number;
      ocrText?: string;
    };
    parseError?: string;
    suggestedMatch?: {
      buildingId: string;
      buildingName: string;
      expenseId: string;
      expenseName: string;
    } | null;
    warnings: InboxItemWarning[] | [];
    sourceFileName?: string;
    telegramMessageId?: number;
    telegramFileId?: string;
    irisCodeBase64?: string;
    // B2 object key of the archived source file (photo/PDF), set at ingest when
    // B2 is configured. Carried onto the Bill's pdfUrl on confirm (no re-upload).
    sourcePdfUrl?: string;
    createdDate?: Date;
    updatedDate?: Date;
  };
}
