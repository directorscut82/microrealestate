import * as Express from 'express';
import * as crypto from 'crypto';
import {
  Collections,
  Middlewares,
  Service
} from '@microrealestate/common';

const routes = Express.Router();

// Existing: wipe all data
routes.delete(
  '/reset',
  Middlewares.asyncWrapper(
    async (req: Express.Request, res: Express.Response<string>) => {
      const mongoClient = Service.getInstance().mongoClient;
      await Promise.all(
        [
          'accounts',
          'contracts',
          'documents',
          'emails',
          'landloards',
          'leases',
          'occupants',
          'properties',
          'realms',
          'templates'
        ].map((collection) =>
          mongoClient?.dropCollection(collection).catch(console.error)
        )
      );

      const redis = Service.getInstance().redisClient;
      const keys = await redis?.keys('*');
      if (keys?.length) {
        await Promise.all(keys.map((key) => redis?.del(key)));
      }
      return res.status(200).send('success');
    }
  )
);

// New: seed test data — create user + org + entities in one call
routes.post(
  '/reset/seed',
  Middlewares.asyncWrapper(
    async (req: Express.Request, res: Express.Response) => {
      const { user, org, leases = [], properties = [], tenants = [] } = req.body;

      // Create account
      const account = await new Collections.Account({
        firstname: user.firstName,
        lastname: user.lastName,
        email: user.email,
        password: user.password,
        createdDate: new Date()
      }).save();

      // Create realm (org)
      const realm = await new Collections.Realm({
        name: org.name,
        locale: org.locale || 'fr-FR',
        currency: org.currency || 'EUR',
        isCompany: org.isCompany || false,
        companyInfo: org.companyInfo || {},
        members: [
          {
            name: `${user.firstName} ${user.lastName}`,
            email: user.email,
            role: 'administrator',
            registered: true
          }
        ]
      }).save();

      const realmId = realm._id;

      // Create leases (contracts)
      const createdLeases: Record<string, any> = {};
      for (const lease of leases) {
        const created = await new Collections.Lease({
          realmId,
          name: lease.name,
          description: lease.description || '',
          numberOfTerms: lease.numberOfTerms,
          timeRange: lease.timeRange,
          active: true
        }).save();
        createdLeases[lease.name] = created;
      }

      // Create properties
      const createdProperties: Record<string, any> = {};
      for (const prop of properties) {
        const created = await new Collections.Property({
          realmId,
          name: prop.name,
          type: prop.type || 'apartment',
          description: prop.description || '',
          surface: prop.surface || 0,
          phone: prop.phone || '',
          digicode: prop.digicode || '',
          price: prop.rent || 0,
          address: prop.address || {}
        }).save();
        createdProperties[prop.name] = created;
      }

      // Create tenants with lease assignments
      const createdTenants: any[] = [];
      const toDate = (d: string) => {
        if (!d) return undefined;
        if (d.includes('/')) {
          const [day, month, year] = d.split('/');
          return new Date(`${year}-${month}-${day}`);
        }
        return new Date(d);
      };

      for (const tenant of tenants) {
        const lease = tenant.leaseName ? createdLeases[tenant.leaseName] : null;
        const tenantProperties = (tenant.properties || []).map((tp: any) => {
          const prop = createdProperties[tp.name];
          return {
            propertyId: prop?._id,
            property: prop,
            rent: prop?.price || 0,
            expenses: tp.expenses || [{ title: 'charges', amount: 0 }],
            entryDate: toDate(tp.entryDate || tenant.beginDate),
            exitDate: toDate(tp.exitDate || tenant.endDate)
          };
        });

        const created = await new Collections.Tenant({
          realmId,
          name: tenant.name,
          isCompany: tenant.isCompany || false,
          company: tenant.company || '',
          manager: tenant.manager || '',
          contacts: tenant.contacts || [],
          address: tenant.address || {},
          leaseId: lease?._id,
          lease,
          beginDate: toDate(tenant.beginDate),
          endDate: toDate(tenant.endDate),
          properties: tenantProperties,
          isVat: tenant.isVat || false,
          vatRatio: tenant.vatRatio || 0,
          discount: tenant.discount || 0,
          guaranty: tenant.guaranty || 0,
          stepperMode: false
        }).save();
        createdTenants.push(created);
      }

      return res.json({
        accountId: account._id,
        realmId,
        leases: Object.fromEntries(
          Object.entries(createdLeases).map(([k, v]) => [k, v._id])
        ),
        properties: Object.fromEntries(
          Object.entries(createdProperties).map(([k, v]) => [k, v._id])
        ),
        tenants: createdTenants.map((t) => ({ id: t._id, name: t.name }))
      });
    }
  )
);

// New: create OTP for tenant email and return it directly
routes.post(
  '/reset/otp',
  Middlewares.asyncWrapper(
    async (req: Express.Request, res: Express.Response) => {
      const { email } = req.body;
      if (!email) {
        return res.status(400).json({ error: 'email required' });
      }

      const otp = crypto.randomBytes(16).toString('hex');
      const now = new Date();
      const createdAt = now.getTime();
      const expiresAt = createdAt + 5 * 60 * 1000;

      const redis = Service.getInstance().redisClient;
      await redis!.set(
        otp,
        `createdAt=${createdAt};expiresAt=${expiresAt};email=${email}`,
        { EX: 300 }
      );

      return res.json({ otp, email });
    }
  )
);

export default routes;
