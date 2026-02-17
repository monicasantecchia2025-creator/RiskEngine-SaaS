import bcrypt from 'bcrypt';
import { PrismaClient, AccountStatus, Platform, JobType } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash('Password123!', 10);
  const user = await prisma.user.upsert({
    where: { email: 'demo@riskengine.com' },
    update: {},
    create: { email: 'demo@riskengine.com', name: 'Demo User', passwordHash }
  });

  const subscription = await prisma.subscription.upsert({
    where: { stripeCustomerId: 'cus_demo_123' },
    update: {},
    create: {
      userId: user.id,
      stripeCustomerId: 'cus_demo_123',
      stripeSubscriptionId: 'sub_demo_123',
      stripePriceId: 'price_demo_123',
      status: 'ACTIVE',
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 30 * 86400000)
    }
  });

  const account = await prisma.account.upsert({
    where: { metaapiAccountId: 'meta_demo_123' },
    update: {},
    create: {
      userId: user.id,
      subscriptionId: subscription.id,
      name: 'Demo MT5',
      platform: Platform.MT5,
      metaapiAccountId: 'meta_demo_123',
      status: AccountStatus.ACTIVE
    }
  });

  await prisma.tradingPlan.upsert({
    where: { accountId: account.id },
    update: {},
    create: {
      accountId: account.id,
      rules: {
        timezone: 'UTC',
        rules: [
          { key: 'max_daily_loss', enabled: true, value: -300, action: 'pause_account' },
          { key: 'max_drawdown', enabled: true, value: 6, action: 'notify' }
        ]
      }
    }
  });

  await prisma.job.createMany({
    data: [
      { type: JobType.METAAPI_SYNC, accountId: account.id },
      { type: JobType.RISK_ENGINE_EVAL, accountId: account.id },
      { type: JobType.SUBSCRIPTION_EXPIRY }
    ],
    skipDuplicates: true
  });
}

main().finally(() => prisma.$disconnect());
