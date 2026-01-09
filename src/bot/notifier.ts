import { Signal } from '../generated/client/client';
import { getBotInstance } from './instance';
import { logger } from '../utils/logger';
import { prisma } from '../db';
import { TokenMeta } from '../providers/types';
import { generateFirstSignalCard, generateDuplicateSignalCard } from './signalCard';
import { scheduleAutoDelete } from '../utils/messageCleanup';
import { provider } from '../providers';

interface DuplicateCheck {
  isDuplicate: boolean;
  firstSignal?: Signal;
  firstGroupName?: string;
}

export const notifySignal = async (
  signal: Signal, 
  meta?: TokenMeta,
  duplicateCheck?: DuplicateCheck
) => {
  try {
    const bot = getBotInstance();
    const chatId = signal.chatId;

    // Load group info if available
    const signalWithGroup = await prisma.signal.findUnique({
      where: { id: signal.id },
      include: { 
        group: { include: { owner: { include: { notificationSettings: true } } } }, 
        user: true 
      },
    });

    const groupName = signalWithGroup?.group?.name || 'Unknown Group';
    const userName = signalWithGroup?.user?.username || signalWithGroup?.user?.firstName || 'Unknown User';
    const ownerSettings = signalWithGroup?.group?.owner?.notificationSettings;
    const homeChatId = ownerSettings?.homeChatId;

    // Refresh live price/MC from provider to avoid stale data
    let metaWithLive: TokenMeta | undefined = meta
      ? {
          mint: meta.mint || signal.mint,
          name: meta.name || signal.name || 'Unknown',
          symbol: meta.symbol || signal.symbol || 'UNKNOWN',
          ...meta,
        }
      : {
          mint: signal.mint,
          name: signal.name || 'Unknown',
          symbol: signal.symbol || 'UNKNOWN',
        };
    try {
      const fresh = await provider.getQuote(signal.mint);
      const supply = meta?.supply ?? signal.entrySupply ?? undefined;
      metaWithLive = {
        mint: meta?.mint || signal.mint,
        name: meta?.name || signal.name || 'Unknown',
        symbol: meta?.symbol || signal.symbol || 'UNKNOWN',
        ...meta,
        livePrice: fresh.price,
        liveMarketCap: supply ? fresh.price * supply : meta?.liveMarketCap ?? meta?.marketCap,
      };
    } catch (err) {
      logger.debug(`Notifier: could not refresh price for ${signal.mint}:`, err);
    }

    let message: string;
    let keyboard: any;

    // Check if this is a duplicate
    if (duplicateCheck?.isDuplicate && duplicateCheck.firstSignal && metaWithLive) {
      // Generate duplicate card
      message = generateDuplicateSignalCard(
        signal,
        metaWithLive,
        duplicateCheck.firstSignal,
        duplicateCheck.firstGroupName || 'Unknown Group',
        groupName,
        userName
      );
      keyboard = {
        inline_keyboard: [
          [
            { text: '📈 Chart', callback_data: `chart:${signal.id}` },
            { text: '📊 Stats', callback_data: `stats:${signal.id}` },
          ],
          [
            { text: '🔍 View First Call', callback_data: `signal:${duplicateCheck.firstSignal.id}` },
            { text: '⭐ Watchlist', callback_data: `watchlist:${signal.id}` },
            { text: '🙈 Hide', callback_data: 'hide' },
          ],
        ],
      };
    } else if (metaWithLive) {
      // Generate rich first signal card
      message = generateFirstSignalCard(signal, metaWithLive, groupName, userName);
      keyboard = {
        inline_keyboard: [
          [
            { text: '📈 Chart', callback_data: `chart:${signal.id}` },
            { text: '📊 Stats', callback_data: `stats:${signal.id}` },
          ],
          [
            { text: '⭐ Watchlist', callback_data: `watchlist:${signal.id}` },
            { text: '🔔 Alerts', callback_data: `alerts:${signal.id}` },
            { text: '🙈 Hide', callback_data: 'hide' },
          ],
        ],
      };
    } else {
      // Fallback to basic message
      message = `
🚨 *ALPHA SIGNAL DETECTED* 🚨

*Token:* ${signal.name} (${signal.symbol})
*Mint:* \`${signal.mint}\`
*Entry:* $${signal.entryPrice?.toFixed(6) || 'Pending'}
*Group:* ${groupName}
*From:* @${userName}

[View on Solscan](https://solscan.io/token/${signal.mint})
      `.trim();
      keyboard = {
        inline_keyboard: [
          [
            { text: '📈 Chart', callback_data: `chart:${signal.id}` },
            { text: '📊 Stats', callback_data: `stats:${signal.id}` },
          ],
          [
            { text: '⭐ Watchlist', callback_data: `watchlist:${signal.id}` },
            { text: '🙈 Hide', callback_data: 'hide' },
          ],
        ],
      };
    }

    const sendWithCleanup = async (targetChatId: bigint, ttlSeconds?: number | null, hideButton = true) => {
      const sent = await bot.telegram.sendMessage(Number(targetChatId), message, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
      scheduleAutoDelete(bot, targetChatId, sent.message_id, ttlSeconds);
    };

    // Send to source chat always
    const sourcePrefs = await prisma.group.findFirst({
      where: { chatId },
      select: { autoDeleteSeconds: true, showHideButton: true },
    });
    if (sourcePrefs?.showHideButton === false) {
      // remove hide buttons
      if (keyboard?.inline_keyboard) {
        keyboard.inline_keyboard = keyboard.inline_keyboard.map((row: any[]) =>
          row.filter((btn) => btn.callback_data !== 'hide')
        );
      }
    }
    await sendWithCleanup(chatId, sourcePrefs?.autoDeleteSeconds ?? null, sourcePrefs?.showHideButton ?? true);

    // Optionally send to home chat based on settings
    if (homeChatId) {
      const wantHome =
        (!duplicateCheck?.isDuplicate && ownerSettings?.notifyHomeOnFirstCa) ||
        (duplicateCheck?.isDuplicate && ownerSettings?.notifyHomeOnRepost);

      if (wantHome && homeChatId !== chatId) {
        const homePrefs = await prisma.group.findFirst({
          where: { chatId: homeChatId },
          select: { autoDeleteSeconds: true, showHideButton: true },
        });
        let homeKeyboard = keyboard;
        if (homePrefs?.showHideButton === false && homeKeyboard?.inline_keyboard) {
          homeKeyboard.inline_keyboard = homeKeyboard.inline_keyboard.map((row: any[]) =>
            row.filter((btn) => btn.callback_data !== 'hide')
          );
        }
        // Avoid duplicate send of same signal to the same home chat
        const exists = await prisma.forwardedSignal.findUnique({
          where: {
            signalId_destGroupId: {
              signalId: signal.id,
              destGroupId: homeChatId,
            },
          },
        });
        if (!exists) {
          await sendWithCleanup(homeChatId, homePrefs?.autoDeleteSeconds ?? null, homePrefs?.showHideButton ?? true);
          await prisma.forwardedSignal.create({
            data: {
              signalId: signal.id,
              sourceGroupId: signal.chatId,
              destGroupId: homeChatId,
            },
          });
        }
      }
    }

    logger.info(`Notification sent for signal ${signal.id}`);
  } catch (error) {
    logger.error(`Failed to send notification for signal ${signal.id}:`, error);
  }
};

