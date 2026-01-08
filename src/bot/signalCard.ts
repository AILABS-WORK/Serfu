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
  const mc = formatNumber(meta.liveMarketCap ?? meta.marketCap);
  const volume = formatNumber(meta.volume24h);
  const lp = formatNumber(meta.liquidity);
  const supply = meta.supply ? `${(meta.supply / 1e9).toFixed(2)}B` : 'N/A';
  const change1h = formatPercent(meta.priceChange1h);
  const livePrice = meta.livePrice ? `$${meta.livePrice.toFixed(6)}` : undefined;
  const ath = formatNumber(meta.ath);
  const entryPrice = signal.entryPrice ? `$${signal.entryPrice.toFixed(6)}` : 'Pending';

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
*Entry Price:* ${entryPrice}
${livePrice ? `*Current Price:* ${livePrice}\n` : ''}

*Market Data:*
• *MC:* ${mc}
• *Volume 24h:* ${volume}
• *LP:* ${lp}
• *Supply:* ${supply}
• *1h Change:* ${change1h}
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
  const entryPrice = signal.entryPrice ? `$${signal.entryPrice.toFixed(6)}` : 'Pending';
  const mc = formatNumber(meta.marketCap);
  const firstPrice = firstSignal.entryPrice || 0;
  const currentPrice = signal.entryPrice || 0;
  const priceChange = firstPrice > 0 
    ? formatPercent(((currentPrice - firstPrice) / firstPrice) * 100)
    : 'N/A';

  return `
🔄 *CA POSTED AGAIN*

*Token:* ${meta.name || 'Unknown'} (${meta.symbol || 'N/A'})
*CA:* \`${signal.mint}\`
*Current MC:* ${mc}
*Current Price:* ${entryPrice}
*Change from First Call:* ${priceChange}

*First Mention:*
• *Group:* ${firstGroupName}
• *Time:* ${firstSignal.detectedAt.toLocaleString()}

*This Mention:*
• *Group:* ${currentGroupName}
• *From:* @${currentUserName}

*Links:*
[🔍 Solscan](https://solscan.io/token/${signal.mint}) • [📊 Axiom](https://app.axiom.xyz/token/${signal.mint}) • [📈 GMGN](https://gmgn.ai/sol/token/${signal.mint})
  `.trim();
};

