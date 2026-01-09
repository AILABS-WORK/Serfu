import { Signal } from '../generated/client/client';
import { TokenMeta } from '../providers/types';
import { prisma } from '../db';

// Format number with K/M/B suffixes
const formatNumber = (num: number | undefined | null): string => {
  if (!num) return 'N/A';
  if (num >= 1e9) return `$${(num / 1e9).toFixed(2)}B`;
  if (num >= 1e6) return `$${(num / 1e6).toFixed(2)}M`;
  if (num >= 1e3) return `$${(num / 1e3).toFixed(2)}K`;
  return `$${num.toFixed(2)}`;
};

// Format age
const formatAge = (createdAt: Date | undefined): string => {
  if (!createdAt) return 'N/A';
  const hours = Math.floor((Date.now() - createdAt.getTime()) / (1000 * 60 * 60));
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
};

// Format percentage
const formatPercent = (num: number | undefined | null): string => {
  if (num === undefined || num === null) return 'N/A';
  const sign = num >= 0 ? '+' : '';
  return `${sign}${num.toFixed(2)}%`;
};

const formatPrice = (value: number | undefined | null): string => {
  if (value === undefined || value === null) return 'Pending';
  if (value >= 1) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(8)}`;
};

const calcPercentDelta = (current?: number | null, entry?: number | null): string => {
  if (current === undefined || current === null || entry === undefined || entry === null || entry === 0) {
    return 'N/A';
  }
  const delta = ((current - entry) / entry) * 100;
  return formatPercent(delta);
};

// Check if this is a duplicate CA for an owner
export const checkDuplicateCA = async (mint: string, ownerId?: number): Promise<{
  isDuplicate: boolean;
  firstSignal?: Signal;
  firstGroupName?: string;
}> => {
  if (!ownerId) {
    return { isDuplicate: false };
  }

  const existingSignals = await prisma.signal.findMany({
    where: { 
      mint,
      group: { ownerId },
    },
    orderBy: { detectedAt: 'asc' },
    take: 1,
    include: { group: true },
  });

  if (existingSignals.length > 0) {
    const firstSignal = existingSignals[0];
    const isDuplicate = true;
    
    return {
      isDuplicate,
      firstSignal,
      firstGroupName: firstSignal.group?.name || 'Unknown Group',
    };
  }

  return { isDuplicate: false };
};

// Generate rich signal card for first mention
export const generateFirstSignalCard = (
  signal: Signal,
  meta: TokenMeta,
  groupName: string,
  userName: string
): string => {
  const age = formatAge(meta.createdAt);
  const currentPrice = meta.livePrice ?? (meta.marketCap && meta.supply ? meta.marketCap / meta.supply : signal.entryPrice ?? null);
  const currentMc = meta.liveMarketCap ?? meta.marketCap ?? (currentPrice && meta.supply ? currentPrice * meta.supply : undefined);
  const mc = formatNumber(currentMc);
  const entryPriceVal = signal.entryPrice ?? null;
  const entryMcVal = signal.entryMarketCap ?? (signal.entryPrice && signal.entrySupply ? signal.entryPrice * signal.entrySupply : null);
  const entryMc = formatNumber(entryMcVal);
  const volume = formatNumber(meta.volume24h);
  const lp = formatNumber(meta.liquidity);
  const supplyVal = meta.supply ?? signal.entrySupply ?? null;
  const supply = supplyVal
    ? supplyVal.toLocaleString(undefined, { maximumFractionDigits: 2 })
    : 'N/A';
  const change1h = formatPercent(meta.priceChange1h);
  const change24h = formatPercent(meta.priceChange24h);
  const livePrice = currentPrice ? formatPrice(currentPrice) : undefined;
  const ath = formatNumber(meta.ath);
  const icon = meta.image ? `[🖼️ Icon](${meta.image})` : 'N/A';
  const priceDelta = calcPercentDelta(currentPrice, entryPriceVal);
  const mcDelta = calcPercentDelta(currentMc ?? null, entryMcVal);

  // Build social links
  let socialLinks = '';
  if (meta.socialLinks) {
    const links = [];
    if (meta.socialLinks.website) links.push(`[🌐 Website](${meta.socialLinks.website})`);
    if (meta.socialLinks.twitter) links.push(`[🐦 Twitter](${meta.socialLinks.twitter})`);
    if (meta.socialLinks.telegram) links.push(`[💬 Telegram](${meta.socialLinks.telegram})`);
    if (meta.socialLinks.discord) links.push(`[🎮 Discord](${meta.socialLinks.discord})`);
    if (links.length > 0) {
      socialLinks = `\n*Social:* ${links.join(' • ')}`;
    }
  }

  return `
🚨 *NEW CA SIGNAL* 🚨

*Token:* ${meta.name || 'Unknown'} (${meta.symbol || 'N/A'})
*Ticker:* ${meta.symbol || 'N/A'}
*CA:* \`${signal.mint}\`
*Chain:* ${meta.chain || 'Solana'}
${meta.launchpad ? `*Launchpad:* ${meta.launchpad}\n` : ''}*Age:* ${age}
*Icon:* ${icon}
*Entry Price:* ${formatPrice(entryPriceVal)}
*Current Price:* ${livePrice || 'N/A'} (${priceDelta})
*Entry MC:* ${entryMc}
*Current MC:* ${mc} (${mcDelta})

*Market Data:*
• *Volume 24h:* ${volume}
• *LP:* ${lp}
• *Supply:* ${supply}
• *1h Change:* ${change1h}
• *24h Change:* ${change24h}
• *ATH:* ${ath}

*Source:*
• *Group:* ${groupName}
• *From:* @${userName}
${socialLinks}

*Links:*
[🔍 Solscan](https://solscan.io/token/${signal.mint}) • [📊 Axiom](https://app.axiom.xyz/token/${signal.mint}) • [📈 GMGN](https://gmgn.ai/sol/token/${signal.mint})
  `.trim();
};

// Generate card for duplicate CA
export const generateDuplicateSignalCard = (
  signal: Signal,
  meta: TokenMeta,
  firstSignal: Signal,
  firstGroupName: string,
  currentGroupName: string,
  currentUserName: string
): string => {
  const currentPriceVal = meta.livePrice ?? (meta.marketCap && meta.supply ? meta.marketCap / meta.supply : signal.entryPrice ?? null);
  const currentMcVal = meta.liveMarketCap ?? meta.marketCap ?? (currentPriceVal && meta.supply ? currentPriceVal * meta.supply : null);
  const entryPrice = formatPrice(currentPriceVal);
  const mc = formatNumber(currentMcVal);
  const firstPrice = firstSignal.entryPrice || null;
  const priceChange = calcPercentDelta(currentPriceVal, firstPrice);
  const entryMcVal = firstSignal.entryMarketCap ?? (firstSignal.entryPrice && firstSignal.entrySupply ? firstSignal.entryPrice * firstSignal.entrySupply : null);
  const mcChange = calcPercentDelta(currentMcVal, entryMcVal);
  const supply = meta.supply ? meta.supply.toLocaleString(undefined, { maximumFractionDigits: 2 }) : 'N/A';
  const volume = formatNumber(meta.volume24h);
  const lp = formatNumber(meta.liquidity);
  const change1h = formatPercent(meta.priceChange1h);
  const icon = meta.image ? `[🖼️ Icon](${meta.image})` : 'N/A';

  return `
🔄 *CA POSTED AGAIN*

*Token:* ${meta.name || 'Unknown'} (${meta.symbol || 'N/A'})
*CA:* \`${signal.mint}\`
*Current MC:* ${mc}
*Current Price:* ${entryPrice}
*Change from First Call:* ${priceChange}
*MC Change:* ${mcChange}
*Icon:* ${icon}

*First Mention:*
• *Group:* ${firstGroupName}
• *Time:* ${firstSignal.detectedAt.toLocaleString()}

*This Mention:*
• *Group:* ${currentGroupName}
• *From:* @${currentUserName}

*Market Data:*
• *Volume 24h:* ${volume}
• *LP:* ${lp}
• *Supply:* ${supply}
• *1h Change:* ${change1h}

*Links:*
[🔍 Solscan](https://solscan.io/token/${signal.mint}) • [📊 Axiom](https://app.axiom.xyz/token/${signal.mint}) • [📈 GMGN](https://gmgn.ai/sol/token/${signal.mint})
  `.trim();
};

