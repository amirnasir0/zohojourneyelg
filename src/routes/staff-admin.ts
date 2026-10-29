import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashPassword } from '../lib/password.js';
import { prisma } from '../lib/prisma.js';
import { requireAdmin } from '../lib/staff-auth-middleware.js';

const createStaffBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(['ADMIN', 'MANAGER', 'EMPLOYEE']),
  full_name: z.string().min(1).optional(),
  zoho_owner_id: z.string().min(1).optional(),
});

// Deliberately excludes email/password — email change is out of scope, and
// a password reset is its own dedicated endpoint (POST /staff/users/:id/
// password below), not folded into general profile edits.
const patchStaffBodySchema = z.object({
  role: z.enum(['ADMIN', 'MANAGER', 'EMPLOYEE']).optional(),
  active: z.boolean().optional(),
  full_name: z.string().min(1).nullable().optional(),
  zoho_owner_id: z.string().min(1).nullable().optional(),
});

const resetPasswordBodySchema = z.object({
  password: z.string().min(8),
});

interface StaffRow {
  id: string;
  email: string;
  role: string;
  fullName: string | null;
  zohoOwnerId: string | null;
  active: boolean;
  createdAt: Date;
}

function serializeStaff(staff: StaffRow) {
  return {
    id: staff.id,
    email: staff.email,
    role: staff.role,
    full_name: staff.fullName,
    zoho_owner_id: staff.zohoOwnerId,
    active: staff.active,
    created_at: staff.createdAt,
  };
}

export async function registerStaffAdminRoutes(app: FastifyInstance) {
  app.post('/staff/users', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = createStaffBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'INVALID_REQUEST' });
    }

    const email = parsed.data.email.toLowerCase();
    const existing = await prisma.staffUser.findUnique({ where: { email } });
    if (existing) {
      return reply.code(409).send({ error: 'EMAIL_TAKEN' });
    }

    const passwordHash = await hashPassword(parsed.data.password);
    const staff = await prisma.staffUser.create({
      data: {
        email,
        passwordHash,
        role: parsed.data.role,
        ...(parsed.data.full_name !== undefined ? { fullName: parsed.data.full_name } : {}),
        ...(parsed.data.zoho_owner_id !== undefined ? { zohoOwnerId: parsed.data.zoho_owner_id } : {}),
      },
    });

    return reply.code(201).send(serializeStaff(staff));
  });

  app.get('/staff/users', { preHandler: requireAdmin }, async (_req, reply) => {
    const staffMembers = await prisma.staffUser.findMany({ orderBy: { createdAt: 'desc' } });
    return reply.code(200).send(staffMembers.map(serializeStaff));
  });

  app.patch('/staff/users/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = patchStaffBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'INVALID_REQUEST' });
    }

    const existing = await prisma.staffUser.findUnique({ where: { id } });
    if (!existing) {
      return reply.code(404).send({ error: 'NOT_FOUND' });
    }

    const staff = await prisma.staffUser.update({
      where: { id },
      data: {
        ...(parsed.data.role !== undefined ? { role: parsed.data.role } : {}),
        ...(parsed.data.active !== undefined ? { active: parsed.data.active } : {}),
        ...(parsed.data.full_name !== undefined ? { fullName: parsed.data.full_name } : {}),
        ...(parsed.data.zoho_owner_id !== undefined ? { zohoOwnerId: parsed.data.zoho_owner_id } : {}),
      },
    });

    return reply.code(200).send(serializeStaff(staff));
  });

  // Admin-set password reset — passwords are only ever stored as bcrypt
  // hashes, so a forgotten one can't be recovered, only replaced. Revokes
  // every live session for that account so the old password (or a lost
  // device still logged in) stops working immediately.
  app.post('/staff/users/:id/password', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = resetPasswordBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'INVALID_REQUEST' });
    }

    const existing = await prisma.staffUser.findUnique({ where: { id } });
    if (!existing) {
      return reply.code(404).send({ error: 'NOT_FOUND' });
    }

    const passwordHash = await hashPassword(parsed.data.password);
    await prisma.$transaction([
      prisma.staffUser.update({ where: { id }, data: { passwordHash } }),
      prisma.staffSession.updateMany({ where: { staffId: id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);

    return reply.code(200).send({ success: true });
  });
}
