import { Signal } from '../generated/client/client';
import { TokenMeta } from '../providers/types';
import { prisma } from '../db';

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

export const generateFirstSignalCard = (
  signal: Signal,
  meta: TokenMeta,
  groupName: string,
  userName: string
): string => {
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

  // Security block
  const audit = meta.audit || {};
  const isMintDisabled = audit.mintAuthorityDisabled ? '✅' : '⚠️';
  const isFreezeDisabled = audit.freezeAuthorityDisabled ? '✅' : '⚠️';
  const top10 = audit.topHoldersPercentage ? `${audit.topHoldersPercentage.toFixed(1)}%` : '—';
  const devBal = audit.devBalancePercentage ? `${audit.devBalancePercentage.toFixed(1)}%` : '—';
  
  const securityBlock = `
🛡️ *SECURITY*
🔒 Auth: Mint ${isMintDisabled} • Freeze ${isFreezeDisabled}
👥 Top 10: \`${top10}\` • Dev: \`${devBal}\`
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

  // Header
  const header = `🚀 *NEW SIGNAL DETECTED*`;
  const tokenIdent = `*${meta.name || 'Unknown'}* (${meta.symbol || 'N/A'})`;
  const caLine = `\`${signal.mint}\``;
  const sourceLine = `Source: ${groupName} • @${userName}`;
  const links = `[Solscan](https://solscan.io/token/${signal.mint}) • [Axiom](https://app.axiom.xyz/token/${signal.mint}) • [GMGN](https://gmgn.ai/sol/token/${signal.mint})`;

  return `
${header}
${tokenIdent}
${caLine}

${statsBlock}

${securityBlock}
${flowBlock ? '\n' + flowBlock : ''}

${sourceLine}
${links}
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
  // Reuse logic but simpler header
  const currentPrice = meta.livePrice ?? (meta.marketCap && meta.supply ? meta.marketCap / meta.supply : signal.entryPrice ?? null);
  const currentMc = meta.liveMarketCap ?? meta.marketCap ?? (currentPrice && meta.supply ? currentPrice * meta.supply : undefined);
  const firstPrice = firstSignal.entryPrice || null;
  const priceChange = calcPercentDelta(currentPrice, firstPrice);
  
  // Stats block
  const statsBlock = `
📊 *LIVE STATS*
💰 Price: \`${formatPrice(currentPrice)}\` (vs First: ${priceChange})
🧢 MC: \`${formatNumber(currentMc)}\`
📈 1h: \`${formatPercent(meta.priceChange1h ?? meta.stats1h?.priceChange)}\` • 24h: \`${formatPercent(meta.priceChange24h ?? meta.stats24h?.priceChange)}\`
  `.trim();

  return `
🔁 *MENTIONED AGAIN*
*${meta.name || 'Unknown'}* (${meta.symbol || 'N/A'})
\`${signal.mint}\`

${statsBlock}

First: ${firstGroupName} (${firstSignal.detectedAt.toLocaleTimeString()})
Now: ${currentGroupName} • @${currentUserName}

[Solscan](https://solscan.io/token/${signal.mint}) • [GMGN](https://gmgn.ai/sol/token/${signal.mint})
  `.trim();
};
