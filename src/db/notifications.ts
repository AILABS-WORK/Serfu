import { prisma } from './index';
import { Prisma } from '../generated/client/client';

export type NotificationSettingsCreateInput = Prisma.UserNotificationSettingsCreateInput;

// Get or create notification settings for a user
export const getOrCreateNotificationSettings = async (userId: number) => {
  let settings = await prisma.userNotificationSettings.findUnique({
    where: { userId },
  });

  if (!settings) {
    settings = await prisma.userNotificationSettings.create({
      data: {
        userId,
        // Defaults are set in schema
      },
    });
  }

  return settings;
};

// Update notification settings
export const updateNotificationSettings = async (
  userId: number,
  data: Partial<NotificationSettingsCreateInput>
) => {
  // Ensure settings exist
  await getOrCreateNotificationSettings(userId);

  return prisma.userNotificationSettings.update({
    where: { userId },
    data,
  });
};

// Get notification settings for a user
export const getNotificationSettings = async (userId: number) => {
  return getOrCreateNotificationSettings(userId);
};


