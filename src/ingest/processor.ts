import { RawMessage } from '../generated/client';
import { detectSignal } from './classifier';
import { createSignal, getSignalByMint } from '../db/signals';
import { provider } from '../providers';
import { logger } from '../utils/logger';
import { prisma } from '../db';

import { notifySignal } from '../bot/notifier';

export const processMessage = async (message: RawMessage) => {
  const { rawText, chatId, messageId } = message;
  
  const detection = detectSignal(rawText);
  
  // Update raw message with detection result
  await prisma.rawMessage.update({
    where: { id: message.id },
    data: {
      isSignal: detection.isSignal,
      parseConfidence: detection.confidence,
      parsedTemplateId: detection.templateId
    }
  });

  if (!detection.isSignal || detection.mints.length === 0) {
    return;
  }

  // Handle first mint found (simplification for v1, usually 1 mint per signal)
  const mint = detection.mints[0];

  try {
    // Check if signal already exists for this message? 
    // DB constraint unique(chatId, messageId) handles duplicates on creation.
    // But we might have processed it already.
    
    // Fetch Metadata
    const meta = await provider.getTokenMeta(mint);
    
    // Fetch Price (Entry)
    let entryPrice: number | null = null;
    let entryProvider = 'helius';
    let trackingStatus: 'ACTIVE' | 'ENTRY_PENDING' = 'ACTIVE';

    try {
      const quote = await provider.getQuote(mint);
      entryPrice = quote.price;
      entryProvider = quote.source;
    } catch (err) {
      logger.warn(`Failed to fetch entry price for ${mint}:`, err);
      trackingStatus = 'ENTRY_PENDING';
    }

    // Create Signal
    const signal = await createSignal({
      chatId,
      messageId,
      mint,
      category: 'General', // TODO: Parse category from text
      name: meta.name,
      symbol: meta.symbol,
      entryPrice,
      entryPriceAt: entryPrice ? new Date() : null,
      entryPriceProvider: entryProvider,
      trackingStatus,
      detectedAt: new Date(),
    });

    logger.info(`Signal created: ${signal.id} for ${mint} at ${entryPrice}`);

    // Send Telegram Notification
    await notifySignal(signal);

  } catch (error) {
    if ((error as any).code === 'P2002') {
      logger.debug('Signal already exists for this message');
    } else {
      logger.error('Error creating signal:', error);
    }
  }
};

