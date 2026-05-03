import {
  AllocationMethod,
  ContractorSpecialty,
  ExpenseType,
  HeatingType,
  LeaseTimeRange,
  OccupancyType,
  Locale,
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
      vatnumber: string;
    };
    thirdParties: {
      gmail: {
        selected: boolean;
        email: string;
        appPassword: string;
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
      };
    };
    locale: Locale;
    currency: string;
  };

  export type Document = {
    _id: string;
    realmId: string;
    tenantId: string;
    leaseId: string;
    templateId: string;
    type: 'text' | 'file';
    name: string;
    description: string;
    mimeType?: string;
    expiryDate?: Date;
    contents?: Record<string, never>;
    html?: string;
    url?: string;
    versionId?: string;
    createdDate: Date;
    updatedDate: Date;
  };

  export type Email = {
    _id: string;
    templateName: string;
    recordId: string;
    params: Record<string, never>;
    sentTo: string;
    sentDate: Date;
    status: string;
    emailId: string;
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
    dehNumber?: string;
    buildingId?: string | Building;
    electricitySupplyNumber?: string;
    energyCertificate?: {
      number: string;
      issueDate: Date;
      energyClass: string;
      inspectorNumber: string;
    };

    // TODO to remove, replaced by address
    building: string;
    level: string;
    location: string;
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
        }[]
      | [];
    description: string;
  };

  export type Tenant = {
    _id: string;
    realmId: string | Realm;
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
    }[];
    reference: string;
    contract: string;
    leaseId: string | Lease;
    beginDate: Date;
    endDate: Date;
    terminationDate: Date;
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

    stepperMode: boolean;
    archived?: boolean;
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
    expenseId?: string;
  };

  export type BuildingUnit = {
    _id: string;
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
    owners: UnitOwner[] | [];
    propertyId?: string | Property;
    isManaged: boolean;
    occupancyType?: OccupancyType;
    parkingAssignedTo?: string[];
    monthlyCharges: MonthlyCharge[] | [];
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
    notes?: string;
    createdDate?: Date;
    updatedDate?: Date;
  };
}
