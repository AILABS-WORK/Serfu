import { PrismaClient } from '../generated/client/client';

const globalForPrisma = global as unknown as { prisma: PrismaClient };

// Prisma 7.2.0 requires adapter or accelerateUrl in types, but for standard PostgreSQL
// connections we don't need either. Using type assertion to work around this.
export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({} as any);

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

