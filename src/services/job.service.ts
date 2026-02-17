import { JobStatus, JobType, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';

export async function enqueueJob(type: JobType, accountId?: string, payload?: Prisma.InputJsonValue) {
  return prisma.job.create({
    data: {
      type,
      accountId,
      payload,
      maxAttempts: 10,
      status: JobStatus.PENDING
    }
  });
}

export async function lockNextJob(type: JobType, workerId: string) {
  const now = new Date();
  const job = await prisma.job.findFirst({
    where: {
      type,
      status: JobStatus.PENDING,
      nextRunAt: { lte: now }
    },
    orderBy: { createdAt: 'asc' }
  });

  if (!job) return null;

  return prisma.job.updateMany({
    where: { id: job.id, status: JobStatus.PENDING },
    data: { status: JobStatus.RUNNING, lockedAt: now, lockOwner: workerId }
  }).then(async (res) => (res.count ? prisma.job.findUnique({ where: { id: job.id } }) : null));
}

export async function completeJob(jobId: string) {
  return prisma.job.update({ where: { id: jobId }, data: { status: JobStatus.DONE, lockedAt: null, lockOwner: null } });
}

export async function failJob(jobId: string, attempts: number, maxAttempts: number, error: string) {
  const shouldRetry = attempts + 1 < maxAttempts;
  const delayMs = Math.min(60000, 2 ** attempts * 1000);
  return prisma.job.update({
    where: { id: jobId },
    data: {
      attempts: attempts + 1,
      status: shouldRetry ? JobStatus.PENDING : JobStatus.FAILED,
      nextRunAt: new Date(Date.now() + delayMs),
      lockedAt: null,
      lockOwner: null,
      lastError: error.slice(0, 2000)
    }
  });
}
