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
  let ownerId: number | null = null;
  
  try {
    ownerId = await getUserIdFromTelegramId(ownerTelegramId);
  } catch (error) {
    // If user doesn't exist yet, create them first
    const { createOrUpdateUser } = await import('./users');
    const user = await createOrUpdateUser(ownerTelegramId, {});
    ownerId = user.id;
  }
  
  // Handle nullable ownerId for migration compatibility
  const whereClause = ownerId 
    ? { chatId_ownerId: { chatId, ownerId } }
    : { id: -1 }; // Fallback, should not happen
  
  return prisma.group.upsert({
    where: whereClause as any,
    create: {
      chatId,
      ownerId: ownerId!,
      name: data.name,
      type: data.type || 'source',
      isActive: data.isActive ?? true,
    },
    update: {
      name: data.name,
      type: data.type,
      isActive: data.isActive,
      ownerId: ownerId, // Update owner if it was null
      updatedAt: new Date(),
    },
  });
};

export const getGroupByChatId = async (chatId: bigint, ownerTelegramId: bigint) => {
  try {
    const ownerId = await getUserIdFromTelegramId(ownerTelegramId);
    return prisma.group.findUnique({
      where: {
        chatId_ownerId: {
          chatId,
          ownerId,
        },
      },
    });
  } catch (error) {
    // If user doesn't exist, return null
    return null;
  }
};

export const getAllGroups = async (ownerTelegramId: bigint, activeOnly: boolean = false) => {
  try {
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
  } catch (error) {
    // If user doesn't exist, return empty array
    return [];
  }
};

export const getDestinationGroups = async (ownerTelegramId: bigint) => {
  try {
    const ownerId = await getUserIdFromTelegramId(ownerTelegramId);
    return prisma.group.findMany({
      where: { 
        ownerId,
        type: 'destination', 
        isActive: true 
      },
      orderBy: { createdAt: 'desc' },
    });
  } catch (error) {
    // If user doesn't exist, return empty array
    return [];
  }
};

export const setGroupType = async (
  chatId: bigint, 
  ownerTelegramId: bigint,
  type: 'source' | 'destination'
) => {
  try {
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
  } catch (error) {
    throw new Error(`Group not found or user not found: ${error}`);
  }
};

export const toggleGroupActive = async (
  chatId: bigint, 
  ownerTelegramId: bigint,
  isActive: boolean
) => {
  try {
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
  } catch (error) {
    throw new Error(`Group not found or user not found: ${error}`);
  }
};

export const deleteGroup = async (chatId: bigint, ownerTelegramId: bigint) => {
  try {
    const ownerId = await getUserIdFromTelegramId(ownerTelegramId);
    return prisma.group.delete({
      where: {
        chatId_ownerId: {
          chatId,
          ownerId,
        },
      },
    });
  } catch (error) {
    throw new Error(`Group not found or user not found: ${error}`);
  }
};

// Get bot invite link for adding to groups
export const getBotInviteLink = async (botUsername: string): Promise<string> => {
  // Telegram bot invite link format: https://t.me/{bot_username}?startgroup
  return `https://t.me/${botUsername}?startgroup`;
};

