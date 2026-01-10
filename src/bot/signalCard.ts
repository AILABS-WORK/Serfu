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
  const vol24 =
    meta.volume24h ??
    (meta.stats24h && (meta.stats24h.buyVolume || meta.stats24h.sellVolume)
      ? (meta.stats24h.buyVolume || 0) + (meta.stats24h.sellVolume || 0)
      : undefined);
  const volume = formatNumber(vol24);
  const lp = formatNumber(meta.liquidity);
  const supplyVal = meta.supply ?? signal.entrySupply ?? null;
  const supply = supplyVal
    ? supplyVal.toLocaleString(undefined, { maximumFractionDigits: 2 })
    : 'N/A';
  const change5m = formatPercent(meta.priceChange5m ?? meta.stats5m?.priceChange);
  const change1h = formatPercent(meta.priceChange1h ?? meta.stats1h?.priceChange);
  const change24h = formatPercent(meta.priceChange24h ?? meta.stats24h?.priceChange);
  const livePrice = currentPrice ? formatPrice(currentPrice) : undefined;
  const ath = formatNumber(meta.ath);
  const icon = meta.image ? `[🖼️ Icon](${meta.image})` : 'N/A';
  const priceDelta = calcPercentDelta(currentPrice, entryPriceVal);
  const mcDelta = calcPercentDelta(currentMc ?? null, entryMcVal);
  const chain = meta.chain || 'Solana';
  const name = meta.name || 'Unknown';
  const symbol = meta.symbol || 'N/A';
  const holders = meta.holderCount ? meta.holderCount.toLocaleString() : 'N/A';
  const fdv = meta.fdv ? formatNumber(meta.fdv) : 'N/A';
  const organic =
    meta.organicScoreLabel || meta.organicScore !== undefined
      ? `${meta.organicScoreLabel || ''}${meta.organicScore !== undefined ? ` (${meta.organicScore.toFixed(0)})` : ''}`
      : 'N/A';
  const auditLines: string[] = [];
  if (meta.audit) {
    if (meta.audit.topHoldersPercentage !== undefined) auditLines.push(`Top Holders: ${meta.audit.topHoldersPercentage.toFixed(2)}%`);
    if (meta.audit.devBalancePercentage !== undefined) auditLines.push(`Dev Balance: ${meta.audit.devBalancePercentage.toFixed(2)}%`);
    if (meta.audit.devMigrations !== undefined) auditLines.push(`Dev Migrations: ${meta.audit.devMigrations}`);
    if (meta.audit.mintAuthorityDisabled !== undefined)
      auditLines.push(`Mint Auth: ${meta.audit.mintAuthorityDisabled ? '✅ disabled' : '⚠️ enabled'}`);
    if (meta.audit.freezeAuthorityDisabled !== undefined)
      auditLines.push(`Freeze Auth: ${meta.audit.freezeAuthorityDisabled ? '✅ disabled' : '⚠️ enabled'}`);
    if (meta.audit.isSus !== undefined) auditLines.push(`Risk: ${meta.audit.isSus ? '⚠️ Suspicious' : '✅ Clean'}`);
  }

  const flowLines: string[] = [];
  const flow = meta.stats1h || meta.stats5m || meta.stats24h;
  if (flow) {
    const shortTerm = meta.stats5m || meta.stats1h;
    const buys = shortTerm?.numBuys;
    const sells = shortTerm?.numSells;
    const orgBuyers = shortTerm?.numOrganicBuyers;
    const netBuyers = shortTerm?.numNetBuyers;
    const buyVol = shortTerm?.buyVolume;
    const sellVol = shortTerm?.sellVolume;
    if (buys !== undefined || sells !== undefined) flowLines.push(`Buys/Sells: ${buys ?? '–'}/${sells ?? '–'}`);
    if (buyVol !== undefined || sellVol !== undefined)
      flowLines.push(`Buy/Sell Vol: ${buyVol?.toFixed(2) ?? '–'}/${sellVol?.toFixed(2) ?? '–'}`);
    if (orgBuyers !== undefined || netBuyers !== undefined)
      flowLines.push(`Organic/Net Buyers: ${orgBuyers ?? '–'}/${netBuyers ?? '–'}`);
  }

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
🚀 *NEW CA SIGNAL*
${icon} *${name}* (${symbol}) · ${chain}
\`${signal.mint}\`

*Price*  ${formatPrice(entryPriceVal)} → ${livePrice || 'N/A'} (${priceDelta})
*MC*     ${entryMc} → ${mc} (${mcDelta})
*Age*    ${age} ${meta.launchpad ? `· Launchpad: ${meta.launchpad}` : ''}

*Market*
• Vol 24h: ${volume}   • LP: ${lp}   • Supply: ${supply}
• FDV: ${fdv}   • Holders: ${holders}   • ATH: ${ath}
• 5m: ${change5m}   • 1h: ${change1h}   • 24h: ${change24h}

*Flow*
${flowLines.length ? flowLines.join('\n') : 'No recent flow data'}

*Security*
${auditLines.length ? auditLines.join('\n') : 'No audit signals'}
• Organic: ${organic}   • Verified: ${meta.isVerified ? '✅' : '—'}

*Source* • ${groupName} · @${userName}
${socialLinks}

*Links:* [🔍 Solscan](https://solscan.io/token/${signal.mint}) · [📊 Axiom](https://app.axiom.xyz/token/${signal.mint}) · [📈 GMGN](https://gmgn.ai/sol/token/${signal.mint})
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
  const vol24 =
    meta.volume24h ??
    (meta.stats24h && (meta.stats24h.buyVolume || meta.stats24h.sellVolume)
      ? (meta.stats24h.buyVolume || 0) + (meta.stats24h.sellVolume || 0)
      : undefined);
  const volume = formatNumber(vol24);
  const lp = formatNumber(meta.liquidity);
  const change5m = formatPercent(meta.priceChange5m ?? meta.stats5m?.priceChange);
  const change1h = formatPercent(meta.priceChange1h ?? meta.stats1h?.priceChange);
  const change24h = formatPercent(meta.priceChange24h ?? meta.stats24h?.priceChange);
  const icon = meta.image ? `[🖼️ Icon](${meta.image})` : 'N/A';
  const chain = meta.chain || 'Solana';
  const name = meta.name || 'Unknown';
  const symbol = meta.symbol || 'N/A';
  const holders = meta.holderCount ? meta.holderCount.toLocaleString() : 'N/A';
  const fdv = meta.fdv ? formatNumber(meta.fdv) : 'N/A';
  const auditLines: string[] = [];
  if (meta.audit) {
    if (meta.audit.topHoldersPercentage !== undefined) auditLines.push(`Top Holders: ${meta.audit.topHoldersPercentage.toFixed(2)}%`);
    if (meta.audit.devBalancePercentage !== undefined) auditLines.push(`Dev Balance: ${meta.audit.devBalancePercentage.toFixed(2)}%`);
    if (meta.audit.devMigrations !== undefined) auditLines.push(`Dev Migrations: ${meta.audit.devMigrations}`);
    if (meta.audit.mintAuthorityDisabled !== undefined)
      auditLines.push(`Mint Auth: ${meta.audit.mintAuthorityDisabled ? '✅ disabled' : '⚠️ enabled'}`);
    if (meta.audit.freezeAuthorityDisabled !== undefined)
      auditLines.push(`Freeze Auth: ${meta.audit.freezeAuthorityDisabled ? '✅ disabled' : '⚠️ enabled'}`);
    if (meta.audit.isSus !== undefined) auditLines.push(`Risk: ${meta.audit.isSus ? '⚠️ Suspicious' : '✅ Clean'}`);
  }
  const flowLines: string[] = [];
  const flow = meta.stats1h || meta.stats5m || meta.stats24h;
  if (flow) {
    const shortTerm = meta.stats5m || meta.stats1h;
    const buys = shortTerm?.numBuys;
    const sells = shortTerm?.numSells;
    const orgBuyers = shortTerm?.numOrganicBuyers;
    const netBuyers = shortTerm?.numNetBuyers;
    const buyVol = shortTerm?.buyVolume;
    const sellVol = shortTerm?.sellVolume;
    if (buys !== undefined || sells !== undefined) flowLines.push(`Buys/Sells: ${buys ?? '–'}/${sells ?? '–'}`);
    if (buyVol !== undefined || sellVol !== undefined)
      flowLines.push(`Buy/Sell Vol: ${buyVol?.toFixed(2) ?? '–'}/${sellVol?.toFixed(2) ?? '–'}`);
    if (orgBuyers !== undefined || netBuyers !== undefined)
      flowLines.push(`Organic/Net Buyers: ${orgBuyers ?? '–'}/${netBuyers ?? '–'}`);
  }

  return `
🔁 *CA POSTED AGAIN*
${icon} *${name}* (${symbol}) · ${chain}
\`${signal.mint}\`

*Price*  ${entryPrice} (vs first: ${priceChange})
*MC*     ${mc} (vs first: ${mcChange})

*Market*
• Vol 24h: ${volume}   • LP: ${lp}   • Supply: ${supply}
• FDV: ${fdv}   • Holders: ${holders}
• 5m: ${change5m}   • 1h: ${change1h}   • 24h: ${change24h}

*Flow*
${flowLines.length ? flowLines.join('\n') : 'No recent flow data'}

*Security*
${auditLines.length ? auditLines.join('\n') : 'No audit signals'}

*First Mention* • ${firstGroupName} • ${firstSignal.detectedAt.toLocaleString()}
*This Mention*  • ${currentGroupName} • @${currentUserName}

*Links:* [🔍 Solscan](https://solscan.io/token/${signal.mint}) · [📊 Axiom](https://app.axiom.xyz/token/${signal.mint}) · [📈 GMGN](https://gmgn.ai/sol/token/${signal.mint})
  `.trim();
};

