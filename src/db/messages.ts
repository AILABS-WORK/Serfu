import { prisma } from './index';
import { Prisma } from '../generated/client';

export type RawMessageCreateInput = Prisma.RawMessageCreateInput;

export const createRawMessage = async (data: RawMessageCreateInput) => {
  return prisma.rawMessage.create({
    data,
  });
};

export const getMessage = async (chatId: bigint, messageId: number) => {
  return prisma.rawMessage.findUnique({
    where: {
      chatId_messageId: {
        chatId,
        messageId,
      },
    },
  });
};

