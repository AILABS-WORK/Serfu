const awaitingClaim = new Set<number>(); // Telegram user ids

export const setAwaitChannelClaim = (userId: number) => {
  awaitingClaim.add(userId);
};

export const clearAwaitChannelClaim = (userId: number) => {
  awaitingClaim.delete(userId);
};

export const isAwaitChannelClaim = (userId: number) => {
  return awaitingClaim.has(userId);
};
















