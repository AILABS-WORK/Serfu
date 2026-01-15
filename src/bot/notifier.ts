import { Signal, Prisma } from '../generated/client';
import { getBotInstance } from './instance';
import { logger } from '../utils/logger';
import { prisma } from '../db';
import { TokenMeta } from '../providers/types';
import { generateFirstSignalCard, generateDuplicateSignalCard } from './signalCard';
import { scheduleAutoDelete } from '../utils/messageCleanup';
import { provider } from '../providers';
import { UIHelper } from '../utils/ui';

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
    const baseMeta: TokenMeta = {
      mint: meta?.mint || signal.mint,
      name: meta?.name || signal.name || 'Unknown',
      symbol: meta?.symbol || signal.symbol || 'UNKNOWN',
      decimals: meta?.decimals,
      image: meta?.image,
      marketCap: meta?.marketCap,
      volume24h: meta?.volume24h,
      liquidity: meta?.liquidity,
      supply: meta?.supply,
      priceChange1h: meta?.priceChange1h,
      priceChange24h: meta?.priceChange24h,
      ath: meta?.ath,
      athDate: meta?.athDate,
      socialLinks: meta?.socialLinks,
      launchpad: meta?.launchpad,
      createdAt: meta?.createdAt,
      chain: meta?.chain,
      livePrice: meta?.livePrice,
      liveMarketCap: meta?.liveMarketCap,
      // Pass through new fields
      audit: meta?.audit,
      stats5m: meta?.stats5m,
      stats1h: meta?.stats1h,
      stats6h: meta?.stats6h,
      stats24h: meta?.stats24h,
      holderCount: meta?.holderCount,
      fdv: meta?.fdv,
      isVerified: meta?.isVerified,
      organicScore: meta?.organicScore,
      organicScoreLabel: meta?.organicScoreLabel,
    };
    let metaWithLive: TokenMeta = baseMeta;
    try {
      const fresh = await provider.getQuote(signal.mint);
      const supply = meta?.supply ?? signal.entrySupply ?? undefined;
      metaWithLive = {
        ...baseMeta,
        livePrice: fresh.price,
        liveMarketCap: supply ? fresh.price * supply : baseMeta.liveMarketCap ?? baseMeta.marketCap,
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
            { text: '🔄 Refresh', callback_data: `refresh:${signal.id}` },
            { text: '🙈 Hide', callback_data: 'hide' },
          ],
        ],
      };
    } else if (metaWithLive) {
      // Generate rich first signal card
      message = await generateFirstSignalCard(signal, metaWithLive, groupName, userName);
      keyboard = {
        inline_keyboard: [
          [
            { text: '📈 Chart', callback_data: `chart:${signal.id}` },
            { text: '📊 Stats', callback_data: `stats:${signal.id}` },
          ],
          [
            { text: '🐋 Analyze Holders', callback_data: `analyze_holders:${signal.id}` },
          ],
          [
            { text: '⭐ Watch', callback_data: `watchlist_add:${signal.id}` },
            { text: '🔄 Refresh', callback_data: `refresh:${signal.id}` },
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
*Entry MC:* ${signal.entryMarketCap ? UIHelper.formatMarketCap(signal.entryMarketCap) : 'N/A'}
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
            { text: '🐋 Analyze Holders', callback_data: `analyze_holders:${signal.id}` },
          ],
          [
            { text: '⭐ Watch', callback_data: `watchlist_add:${signal.id}` },
            { text: '🙈 Hide', callback_data: 'hide' },
          ],
        ],
      };
    }

    const sendWithCleanup = async (targetChatId: bigint, ttlSeconds?: number | null, hideButton = true) => {
      let sent;
      // Prefer sendPhoto if image available
      if (metaWithLive?.image) {
        try {
          sent = await bot.telegram.sendPhoto(Number(targetChatId), metaWithLive.image, {
            caption: message,
            parse_mode: 'Markdown',
            reply_markup: keyboard,
          });
        } catch (err) {
          logger.warn(`Failed to send photo for signal ${signal.id}, fallback to text: ${err}`);
          // Fallback
          sent = await bot.telegram.sendMessage(Number(targetChatId), message, {
            parse_mode: 'Markdown',
            reply_markup: keyboard,
            link_preview_options: { is_disabled: false }, // show preview if possible
          });
        }
      } else {
        sent = await bot.telegram.sendMessage(Number(targetChatId), message, {
          parse_mode: 'Markdown',
          reply_markup: keyboard,
        });
      }
      
      if (sent) {
        scheduleAutoDelete(bot, targetChatId, sent.message_id, ttlSeconds);
      }
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
          row.filter((btn: any) => btn.callback_data !== 'hide')
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
        let homeKeyboard = JSON.parse(JSON.stringify(keyboard)); // clone
        if (homePrefs?.showHideButton === false && homeKeyboard?.inline_keyboard) {
          homeKeyboard.inline_keyboard = homeKeyboard.inline_keyboard.map((row: any[]) =>
            row.filter((btn: any) => btn.callback_data !== 'hide')
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
          // Use the homeKeyboard for home chat
          const originalKeyboard = keyboard;
          keyboard = homeKeyboard; // swap temporarily
          await sendWithCleanup(homeChatId, homePrefs?.autoDeleteSeconds ?? null, homePrefs?.showHideButton ?? true);
          keyboard = originalKeyboard; // swap back
          
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
