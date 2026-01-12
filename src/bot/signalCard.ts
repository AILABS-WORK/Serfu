import { Signal, Prisma } from '../generated/client';
import { TokenMeta } from '../providers/types';
import { prisma } from '../db';
import { analyzeHolders, WhaleAlert } from '../analytics/holders';

// Formatting helpers
const formatNumber = (num: number | undefined | null): string => {
  if (!num) return '—';
  if (num >= 1e9) return `$${(num / 1e9).toFixed(2)}B`;
  if (num >= 1e6) return `$${(num / 1e6).toFixed(2)}M`;
  if (num >= 1e3) return `$${(num / 1e3).toFixed(2)}K`;
  return `$${num.toFixed(2)}`;
};

const formatPercent = (num: number | undefined | null): string => {
  if (num === undefined || num === null) return '—';
  const sign = num >= 0 ? '+' : '';
  return `${sign}${num.toFixed(2)}%`;
};

const formatPrice = (value: number | undefined | null): string => {
  if (value === undefined || value === null) return 'Pending';
  if (value >= 1) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(8)}`; // More decimals for low cap
};

const calcPercentDelta = (current?: number | null, entry?: number | null): string => {
  if (!current || !entry) return '—';
  const delta = ((current - entry) / entry) * 100;
  return formatPercent(delta);
};

// Check duplicate logic (shared)
export const checkDuplicateCA = async (
  mint: string,
  ownerId?: number,
  groupId?: number,
  excludeSignalId?: number
): Promise<{
  isDuplicate: boolean;
  firstSignal?: Signal;
  firstGroupName?: string;
}> => {
  const whereClause: any = { mint };
  if (groupId) {
    whereClause.groupId = groupId; // group-scoped duplicate detection
  } else if (ownerId) {
    whereClause.group = { ownerId };
  } else {
    return { isDuplicate: false };
  }

  const existingSignals = await prisma.signal.findMany({
    where: whereClause,
    orderBy: { detectedAt: 'asc' },
    take: 1,
    include: { group: true },
  });

  if (existingSignals.length > 0) {
    const firstSignal = existingSignals[0];
    if (excludeSignalId && firstSignal.id === excludeSignalId) {
      return { isDuplicate: false };
    }
    return {
      isDuplicate: true,
      firstSignal,
      firstGroupName: firstSignal.group?.name || 'Unknown Group',
    };
  }

  return { isDuplicate: false };
};

// --- NEW LAYOUT GENERATORS ---

export const generateFirstSignalCard = async (
  signal: Signal,
  meta: TokenMeta,
  groupName: string,
  userName: string
): Promise<string> => {
  // Data prep
  const currentPrice = meta.livePrice ?? (meta.marketCap && meta.supply ? meta.marketCap / meta.supply : signal.entryPrice ?? null);
  const currentMc = meta.liveMarketCap ?? meta.marketCap ?? (currentPrice && meta.supply ? currentPrice * meta.supply : undefined);
  const entryPriceVal = signal.entryPrice ?? null;
  const entryMcVal = signal.entryMarketCap ?? (signal.entryPrice && signal.entrySupply ? signal.entryPrice * signal.entrySupply : null);
  
  const priceDelta = calcPercentDelta(currentPrice, entryPriceVal);
  const mcDelta = calcPercentDelta(currentMc ?? null, entryMcVal);
  
  const vol24 = meta.volume24h ??
    (meta.stats24h && (meta.stats24h.buyVolume || meta.stats24h.sellVolume)
      ? (meta.stats24h.buyVolume || 0) + (meta.stats24h.sellVolume || 0)
      : undefined);

  // Stats block
  const statsBlock = `
📊 *MARKET STATS*
💰 Price: \`${formatPrice(currentPrice)}\` (${priceDelta})
🧢 MC: \`${formatNumber(currentMc)}\` (${mcDelta})
💧 Liq: \`${formatNumber(meta.liquidity)}\` • Vol: \`${formatNumber(vol24)}\`
📈 5m: \`${formatPercent(meta.priceChange5m ?? meta.stats5m?.priceChange)}\` • 1h: \`${formatPercent(meta.priceChange1h ?? meta.stats1h?.priceChange)}\` • 24h: \`${formatPercent(meta.priceChange24h ?? meta.stats24h?.priceChange)}\`
  `.trim();

  // Security & Holders Block
  const audit = meta.audit || {};
  const isMintDisabled = audit.mintAuthorityDisabled ? '✅' : '⚠️';
  const isFreezeDisabled = audit.freezeAuthorityDisabled ? '✅' : '⚠️';
  
  // Analyze Holders asynchronously (fetching Top 10)
  // This might delay card generation by ~1s but provides the requested data
  let whaleAlerts: WhaleAlert[] = [];
  let topHoldersText = '';
  
  try {
    const { solana } = await import('../providers/solana');
    const holders = await solana.getTopHolders(signal.mint, 10); // Get top 10 for display
    
    if (holders.length > 0) {
        topHoldersText = '\n👑 *TOP HOLDERS*\n';
        // Display top 10 inline
        const percentages = holders.map(h => `\`${h.percentage.toFixed(1)}%\``).join(', ');
        topHoldersText += `${percentages}\n`;
    }

    // Run deep analysis (Whale Cross-Check)
    // We do this after displaying basic holders to not block too long, or do we want alerts IN the card?
    // User asked for it IN the card.
    whaleAlerts = await analyzeHolders(signal.id, signal.mint);

  } catch (err) {
    // Ignore holder fetch errors to not break card
  }

  let alertBlock = '';
  if (whaleAlerts.length > 0) {
    alertBlock = '\n⚠️ *WHALE ALERT*\n';
    whaleAlerts.slice(0, 3).forEach(alert => {
        alertBlock += `• Top Holder #${alert.rankInCurrent} also held *${alert.matchedSignalName}* (${alert.matchedAthMultiple.toFixed(1)}x)\n`;
    });
  }

  const securityBlock = `
🛡️ *SECURITY*
🔒 Auth: Mint ${isMintDisabled} • Freeze ${isFreezeDisabled}
✅ Verified: ${meta.isVerified ? 'Yes' : 'No'}
  `.trim();

  // Flow block (if available)
  let flowBlock = '';
  const flow = meta.stats1h || meta.stats5m;
  if (flow) {
    const buys = flow.numBuys ?? 0;
    const sells = flow.numSells ?? 0;
    const volBuy = flow.buyVolume ?? 0;
    const volSell = flow.sellVolume ?? 0;
    flowBlock = `
🌊 *FLOW (1h)*
Buys: \`${buys}\` ($${formatNumber(volBuy)})
Sells: \`${sells}\` ($${formatNumber(volSell)})
    `.trim();
  }

  // Links block
  const linkList: string[] = [];
  linkList.push(`[Solscan](https://solscan.io/token/${signal.mint})`);
  linkList.push(`[Axiom](https://app.axiom.xyz/token/${signal.mint})`);
  linkList.push(`[GMGN](https://gmgn.ai/sol/token/${signal.mint})`);
  linkList.push(`[Photon](https://photon-sol.tinyastro.io/en/lp/${signal.mint})`);
  linkList.push(`[BullX](https://bullx.io/terminal?chainId=1399811149&address=${signal.mint})`);

  if (meta.socialLinks) {
    if (meta.socialLinks.twitter) linkList.push(`[Twitter](${meta.socialLinks.twitter})`);
    if (meta.socialLinks.telegram) linkList.push(`[Telegram](${meta.socialLinks.telegram})`);
    if (meta.socialLinks.website) linkList.push(`[Website](${meta.socialLinks.website})`);
  }

  if (meta.launchpad === 'pump.fun' || meta.tags?.includes('pump')) {
    linkList.push(`[PumpFun](https://pump.fun/${signal.mint})`);
  } else if (meta.launchpad === 'moonshot') {
    linkList.push(`[Moonshot](https://moonshot.money/token/${signal.mint})`);
  }

  const linksBlock = linkList.length > 0 
    ? `🔗 ${linkList.join(' • ')}`
    : '';

  const header = `🚀 *NEW SIGNAL DETECTED*`;
  const tokenIdent = `*${meta.name || 'Unknown'}* (${meta.symbol || 'N/A'})`;
  const caLine = `\`${signal.mint}\``;
  const displayUser = (userName === 'Unknown User' || !signal.userId) ? groupName : `@${userName}`;
  const sourceLine = `Source: ${groupName} • ${displayUser}`;

  return `
${header}
${tokenIdent}
${caLine}

${statsBlock}

${securityBlock}
${topHoldersText}${alertBlock}
${flowBlock ? '\n' + flowBlock : ''}

${sourceLine}
${linksBlock}
  `.trim();
};

export const generateDuplicateSignalCard = (
  signal: Signal,
  meta: TokenMeta,
  firstSignal: Signal,
  firstGroupName: string,
  currentGroupName: string,
  currentUserName: string
): string => {
  const currentPrice = meta.livePrice ?? (meta.marketCap && meta.supply ? meta.marketCap / meta.supply : signal.entryPrice ?? null);
  const currentMc = meta.liveMarketCap ?? meta.marketCap ?? (currentPrice && meta.supply ? currentPrice * meta.supply : undefined);
  const firstPrice = firstSignal.entryPrice || null;
  const priceChange = calcPercentDelta(currentPrice, firstPrice);
  const displayUser = (currentUserName === 'Unknown User' || !signal.userId) ? currentGroupName : `@${currentUserName}`;
  
  const statsBlock = `
📊 *LIVE STATS*
💰 Price: \`${formatPrice(currentPrice)}\` (vs First: ${priceChange})
🧢 MC: \`${formatNumber(currentMc)}\`
📈 1h: \`${formatPercent(meta.priceChange1h ?? meta.stats1h?.priceChange)}\` • 24h: \`${formatPercent(meta.priceChange24h ?? meta.stats24h?.priceChange)}\`
  `.trim();

  const linkList: string[] = [];
  linkList.push(`[Solscan](https://solscan.io/token/${signal.mint})`);
  linkList.push(`[GMGN](https://gmgn.ai/sol/token/${signal.mint})`);
  linkList.push(`[Photon](https://photon-sol.tinyastro.io/en/lp/${signal.mint})`);
  
  if (meta.socialLinks) {
    if (meta.socialLinks.twitter) linkList.push(`[Twitter](${meta.socialLinks.twitter})`);
    if (meta.socialLinks.telegram) linkList.push(`[Telegram](${meta.socialLinks.telegram})`);
  }

  const linksBlock = linkList.length > 0 ? `🔗 ${linkList.join(' • ')}` : '';

  return `
🔁 *MENTIONED AGAIN*
*${meta.name || 'Unknown'}* (${meta.symbol || 'N/A'})
\`${signal.mint}\`

${statsBlock}

First: ${firstGroupName} (${firstSignal.detectedAt.toLocaleTimeString()})
Now: ${currentGroupName} • ${displayUser}

${linksBlock}
  `.trim();
};
