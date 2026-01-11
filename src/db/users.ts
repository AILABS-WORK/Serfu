import { prisma } from './index';
import { Prisma } from '@prisma/client';

export type UserCreateInput = Prisma.UserCreateInput;

export const createOrUpdateUser = async (userId: bigint, data: Partial<UserCreateInput>) => {
  return prisma.user.upsert({
    where: { userId },
    create: {
      userId,
      username: data.username,
      firstName: data.firstName,
      lastName: data.lastName,
    },
    update: {
      username: data.username,
      firstName: data.firstName,
      lastName: data.lastName,
      updatedAt: new Date(),
    },
  });
};

export const getUserByUserId = async (userId: bigint) => {
  return prisma.user.findUnique({
    where: { userId },
  });
};

export const getAllUsers = async () => {
  return prisma.user.findMany({
    orderBy: { createdAt: 'desc' },
  });
};

