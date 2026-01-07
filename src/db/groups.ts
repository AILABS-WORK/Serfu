import { prisma } from './index';
import { Prisma } from '../generated/client/client';

export type GroupCreateInput = Prisma.GroupCreateInput;

export const createOrUpdateGroup = async (chatId: bigint, data: Partial<GroupCreateInput>) => {
  return prisma.group.upsert({
    where: { chatId },
    create: {
      chatId,
      name: data.name,
      type: data.type || 'source',
      isActive: data.isActive ?? true,
    },
    update: {
      name: data.name,
      type: data.type,
      isActive: data.isActive,
      updatedAt: new Date(),
    },
  });
};

export const getGroupByChatId = async (chatId: bigint) => {
  return prisma.group.findUnique({
    where: { chatId },
  });
};

export const getAllGroups = async (activeOnly: boolean = false) => {
  return prisma.group.findMany({
    where: activeOnly ? { isActive: true } : undefined,
    orderBy: { createdAt: 'desc' },
  });
};

export const getDestinationGroups = async () => {
  return prisma.group.findMany({
    where: { type: 'destination', isActive: true },
    orderBy: { createdAt: 'desc' },
  });
};

export const setGroupType = async (chatId: bigint, type: 'source' | 'destination') => {
  return prisma.group.update({
    where: { chatId },
    data: { type, updatedAt: new Date() },
  });
};

export const toggleGroupActive = async (chatId: bigint, isActive: boolean) => {
  return prisma.group.update({
    where: { chatId },
    data: { isActive, updatedAt: new Date() },
  });
};

export const deleteGroup = async (chatId: bigint) => {
  return prisma.group.delete({
    where: { chatId },
  });
};

