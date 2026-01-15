import { Signal, Prisma } from '../generated/client';
import { getDestinationGroups } from '../db/groups';
import { prisma } from '../db';
import { getBotInstance } from './instance';
import { logger } from '../utils/logger';
import { scheduleAutoDelete } from '../utils/messageCleanup';
import { checkDuplicateCA, generateFirstSignalCard, generateDuplicateSignalCard } from './signalCard';
import { provider } from '../providers';
import { TokenMeta } from '../providers/types';
import { UIHelper } from '../utils/ui';

export const forwardSignalToDestination = async (signal: Signal) => {
  try {
    // 1. Fetch signal details to get caller info
    const signalDetails = await prisma.signal.findUnique({
      where: { id: signal.id },
      include: { user: true, group: true, priceSamples: { orderBy: { sampledAt: 'asc' }, take: 1 } }
    });
    const userName = signalDetails?.user?.username || signalDetails?.user?.firstName || 'Unknown User';

    // 2. Find ALL users who are monitoring this source chat (Subscribers)
    // This allows fan-out: if User A and User B both monitor Chat X, both get forwards.
    const sourceSubscriptions = await prisma.group.findMany({
      where: {
        chatId: signal.chatId,
        type: 'source',
        isActive: true,
      },
      include: { owner: true }
    });

    if (sourceSubscriptions.length === 0) {
      logger.debug(`Forwarding skipped: No active subscriptions for chat ${signal.chatId}`);
      return;
    }

    // 3. Prepare Token Meta (once for all destinations)
    const meta = await provider.getTokenMeta(signal.mint);
    const quote = await provider.getQuote(signal.mint);
    const supply = meta?.supply ?? signal.entrySupply ?? undefined;
    const metaWithLive: TokenMeta = {
      ...meta,
      livePrice: quote.price,
      liveMarketCap: supply ? quote.price * supply : meta.marketCap,
    };
    
    const bot = getBotInstance();

    // 4. Iterate over each subscription (User context)
    for (const subscription of sourceSubscriptions) {
        if (!subscription.owner) continue;
        const ownerTelegramId = subscription.owner.userId;
        const ownerId = subscription.ownerId;
        const groupName = subscription.name || 'Unknown Group';

        const strategyPresets = await prisma.strategyPreset.findMany({
          where: { ownerId: ownerId || undefined, isActive: true },
          orderBy: { createdAt: 'desc' }
        });

        // Get destinations for THIS user
        const destinationGroups = await getDestinationGroups(ownerTelegramId);
        if (destinationGroups.length === 0) continue;

        const withinSchedule = (date: Date, schedule: any, groupId?: number | null): boolean => {
          const days = schedule?.days || [];
          const windows = schedule?.windows || [];
          const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
          const day = dayNames[date.getUTCDay()];
          if (days.length > 0 && !days.includes(day)) return false;
          if (schedule?.dayGroups && Object.keys(schedule.dayGroups).length > 0) {
            const allowed = schedule.dayGroups[day] || [];
            if (allowed.length > 0 && groupId && !allowed.includes(groupId)) return false;
          }
          if (!windows || windows.length === 0) return true;
          const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
          return windows.some((w: any) => {
            const [sh, sm] = w.start.split(':').map((x: string) => parseInt(x, 10));
            const [eh, em] = w.end.split(':').map((x: string) => parseInt(x, 10));
            const start = sh * 60 + sm;
            const end = eh * 60 + em;
            if (start <= end) return minutes >= start && minutes <= end;
            return minutes >= start || minutes <= end;
          });
        };

        const passesStrategy = async (): Promise<boolean> => {
          if (!strategyPresets || strategyPresets.length === 0) return true;
          if (!signalDetails) return false;

          for (const preset of strategyPresets) {
            const targetType = preset.targetType;
            const targetId = preset.targetId;
            if (targetType === 'GROUP' && targetId && signalDetails.groupId !== targetId) continue;
            if (targetType === 'USER' && targetId && signalDetails.userId !== targetId) continue;
            if (targetType !== 'OVERALL' && !targetId) continue;

            if (!withinSchedule(signalDetails.detectedAt, preset.schedule, signalDetails.groupId)) continue;

            const conditions: any = preset.conditions || {};
            if (conditions.minMarketCap && (!signalDetails.entryMarketCap || signalDetails.entryMarketCap < conditions.minMarketCap)) continue;
            if (conditions.maxMarketCap && (!signalDetails.entryMarketCap || signalDetails.entryMarketCap > conditions.maxMarketCap)) continue;

            if (conditions.minVolume) {
              const vol = signalDetails.priceSamples?.[0]?.volume || 0;
              if (vol < conditions.minVolume) continue;
            }

            if (conditions.minMentions) {
              const mentionCount = await prisma.signal.count({
                where: {
                  mint: signalDetails.mint,
                  group: { ownerId: ownerId || undefined }
                }
              });
              if (mentionCount < conditions.minMentions) continue;
            }

            return true;
          }
          return false;
        };

        const allowedByStrategy = await passesStrategy();
        if (!allowedByStrategy) {
          logger.debug(`Signal ${signal.id} skipped by strategy presets for owner ${ownerTelegramId}`);
          continue;
        }

        // Check Duplicate CA for THIS user's ecosystem
        // Pass the ownerId to checkDuplicateCA to see if THEY have seen this mint before
        const duplicateCheck = await checkDuplicateCA(signal.mint, ownerId ?? undefined, undefined, signal.id);
        const isDup = duplicateCheck.isDuplicate;

        for (const destGroup of destinationGroups) {
            // Skip self-forward
            if (destGroup.chatId === signal.chatId) continue;

            // Check if we've already sent THIS signal instance to this destination
            const existing = await prisma.forwardedSignal.findUnique({
                where: {
                signalId_destGroupId: {
                    signalId: signal.id,
                    destGroupId: destGroup.chatId,
                },
                },
            });
            if (existing) continue;

            // Check if this mint already exists in the destination group (from any source)
            // This handles the case where a channel sends a CA, then user sends same CA to destination
            const existingSignalInDest = await prisma.signal.findFirst({
                where: {
                    chatId: destGroup.chatId,
                    mint: signal.mint,
                },
                orderBy: { detectedAt: 'asc' }, // Get the first one
                include: { group: true }
            });

            // Check if we've already sent this mint from this specific source group to this destination
            // (Avoid spamming the same group mention repeatedly)
            const alreadySentFromSource = await prisma.forwardedSignal.findFirst({
                where: {
                destGroupId: destGroup.chatId,
                sourceGroupId: signal.chatId,
                signal: { mint: signal.mint },
                },
            });
            if (alreadySentFromSource) continue;

            // Generate Card
            let message: string;
            if (existingSignalInDest) {
                // Signal already exists in destination group - show repost with comparison
                const entryMc = existingSignalInDest.entryMarketCap || 0;
                const currentMc = metaWithLive.liveMarketCap || metaWithLive.marketCap || 0;
                const mcChange = entryMc > 0 && currentMc > 0 
                    ? ((currentMc - entryMc) / entryMc) * 100 
                    : 0;
                const mcChangeStr = mcChange >= 0 ? `+${mcChange.toFixed(1)}%` : `${mcChange.toFixed(1)}%`;
                
                message = `🔁 *CA REPOSTED*\n\n`;
                message += `*${metaWithLive.name || 'Unknown'}* (${metaWithLive.symbol || 'N/A'})\n`;
                message += `\`${signal.mint}\`\n\n`;
                message += `📊 *Entry MC:* ${UIHelper.formatMarketCap(entryMc)} ➔ *Now MC:* ${UIHelper.formatMarketCap(currentMc)} (*${mcChangeStr}*)\n`;
                message += `\nFirst detected: ${existingSignalInDest.detectedAt.toLocaleString()}\n`;
                message += `Reposted from: ${groupName}`;
            } else if (isDup && duplicateCheck.firstSignal) {
                message = generateDuplicateSignalCard(
                    signal,
                    metaWithLive,
                    duplicateCheck.firstSignal,
                    duplicateCheck.firstGroupName || 'Unknown Group',
                    groupName,
                    userName
                );
                message = `🆕 *NEW GROUP MENTION*\n\n` + message;
            } else {
                // First time seeing this CA in ANY of owner's groups
                message = await generateFirstSignalCard(signal, metaWithLive, groupName, userName);
            }

            const keyboard = {
                inline_keyboard: [
                [
                    { text: '📈 Chart', callback_data: `chart:${signal.id}` },
                    { text: '📊 Stats', callback_data: `stats:${signal.id}` },
                ],
                [
                    { text: '🐋 Analyze Holders', callback_data: `analyze_holders:${signal.id}` },
                ],
                [
                    { text: '🔍 View Source', callback_data: `source:${signal.id}` },
                    { text: '🔄 Refresh', callback_data: `refresh:${signal.id}` },
                ],
                ],
            } as any;

            const destPrefs = {
                autoDeleteSeconds: destGroup.autoDeleteSeconds ?? null,
                showHideButton: destGroup.showHideButton ?? true
            };

            if (destPrefs.showHideButton) {
                keyboard.inline_keyboard.push([{ text: '🙈 Hide', callback_data: 'hide' }]);
            }

            let sent;
            if (metaWithLive.image) {
                try {
                sent = await bot.telegram.sendPhoto(Number(destGroup.chatId), metaWithLive.image, {
                    caption: message,
                    parse_mode: 'Markdown',
                    reply_markup: keyboard,
                });
                } catch (err) {
                logger.warn(`Forwarder: failed to send photo, fallback to text: ${err}`);
                sent = await bot.telegram.sendMessage(Number(destGroup.chatId), message, {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard,
                    link_preview_options: { is_disabled: false },
                });
                }
            } else {
                sent = await bot.telegram.sendMessage(Number(destGroup.chatId), message, {
                parse_mode: 'Markdown',
                reply_markup: keyboard,
                link_preview_options: { is_disabled: false },
                });
            }

            if (sent) {
                scheduleAutoDelete(bot, destGroup.chatId, sent.message_id, destPrefs.autoDeleteSeconds);
            }

            // Record forwarding
            await prisma.forwardedSignal.create({
                data: {
                signalId: signal.id,
                sourceGroupId: signal.chatId,
                destGroupId: destGroup.chatId,
                forwardedBy: ownerTelegramId,
                },
            });

            logger.info(`Signal ${signal.id} forwarded to group ${destGroup.chatId} for user ${ownerTelegramId}`);
        }
    }
  } catch (error) {
    logger.error(`Error forwarding signal ${signal.id}:`, error);
  }
};
