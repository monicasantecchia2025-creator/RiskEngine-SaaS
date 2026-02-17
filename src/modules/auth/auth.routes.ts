import { FastifyInstance } from 'fastify';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';

const registerSchema = z.object({ email: z.string().email(), password: z.string().min(8), name: z.string().min(2) });
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(8) });

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/register', async (request, reply) => {
    const body = registerSchema.parse(request.body);
    const exists = await prisma.user.findUnique({ where: { email: body.email } });
    if (exists) return reply.code(409).send({ message: 'Email already exists' });

    const user = await prisma.user.create({
      data: { email: body.email, name: body.name, passwordHash: await bcrypt.hash(body.password, 10) }
    });
    await prisma.auditLog.create({ data: { actorUserId: user.id, action: 'auth.register', entityType: 'User', entityId: user.id } });

    return reply.code(201).send({ id: user.id, email: user.email, name: user.name });
  });

  app.post('/auth/login', async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (!user || !(await bcrypt.compare(body.password, user.passwordHash))) {
      return reply.code(401).send({ message: 'Invalid credentials' });
    }
    const token = await reply.jwtSign({ userId: user.id, email: user.email, role: user.role });
    return { accessToken: token };
  });

  app.get('/auth/me', { preHandler: [app.authenticate] }, async (request) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: request.authUser!.userId } });
    return { id: user.id, email: user.email, name: user.name, role: user.role };
  });
}
