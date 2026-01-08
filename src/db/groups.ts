import { prisma } from './index';
import { Prisma } from '../generated/client/client';

export type GroupCreateInput = Prisma.GroupCreateInput;

// Get user ID from Telegram user ID (BigInt)
const getUserIdFromTelegramId = async (telegramUserId: bigint): Promise<number> => {
  const user = await prisma.user.findUnique({
    where: { userId: telegramUserId },
  });
  if (!user) {
    throw new Error(`User with Telegram ID ${telegramUserId} not found`);
  }
  return user.id;
};

export const createOrUpdateGroup = async (
  chatId: bigint, 
  ownerTelegramId: bigint,
  data: Partial<GroupCreateInput>
) => {
  const ownerId = await getUserIdFromTelegramId(ownerTelegramId);
  
  return prisma.group.upsert({
    where: {
      chatId_ownerId: {
        chatId,
        ownerId,
      },
    },
    create: {
      chatId,
      ownerId,
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

export const getGroupByChatId = async (chatId: bigint, ownerTelegramId: bigint) => {
  const ownerId = await getUserIdFromTelegramId(ownerTelegramId);
  return prisma.group.findUnique({
    where: {
      chatId_ownerId: {
        chatId,
        ownerId,
      },
    },
  });
};

export const getAllGroups = async (ownerTelegramId: bigint, activeOnly: boolean = false) => {
  const ownerId = await getUserIdFromTelegramId(ownerTelegramId);
  return prisma.group.findMany({
    where: {
      ownerId,
      ...(activeOnly ? { isActive: true } : {}),
    },
    include: {
      signals: {
        select: { id: true },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
};

export const getDestinationGroups = async (ownerTelegramId: bigint) => {
  const ownerId = await getUserIdFromTelegramId(ownerTelegramId);
  return prisma.group.findMany({
    where: { 
      ownerId,
      type: 'destination', 
      isActive: true 
    },
    orderBy: { createdAt: 'desc' },
  });
};

export const setGroupType = async (
  chatId: bigint, 
  ownerTelegramId: bigint,
  type: 'source' | 'destination'
) => {
  const ownerId = await getUserIdFromTelegramId(ownerTelegramId);
  return prisma.group.update({
    where: {
      chatId_ownerId: {
        chatId,
        ownerId,
      },
    },
    data: { type, updatedAt: new Date() },
  });
};

export const toggleGroupActive = async (
  chatId: bigint, 
  ownerTelegramId: bigint,
  isActive: boolean
) => {
  const ownerId = await getUserIdFromTelegramId(ownerTelegramId);
  return prisma.group.update({
    where: {
      chatId_ownerId: {
        chatId,
        ownerId,
      },
    },
    data: { isActive, updatedAt: new Date() },
  });
};

export const deleteGroup = async (chatId: bigint, ownerTelegramId: bigint) => {
  const ownerId = await getUserIdFromTelegramId(ownerTelegramId);
  return prisma.group.delete({
    where: {
      chatId_ownerId: {
        chatId,
        ownerId,
      },
    },
  });
};

// Get bot invite link for adding to groups
export const getBotInviteLink = async (botUsername: string): Promise<string> => {
  // Telegram bot invite link format: https://t.me/{bot_username}?startgroup
  return `https://t.me/${botUsername}?startgroup`;
};

