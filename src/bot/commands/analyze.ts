import { Context } from 'telegraf';
import { UIHelper } from '../../utils/ui';
import { getBasicTokenAnalysis, getDeepTokenAnalysis } from '../../analytics/tokenSniffer';

export const handleAnalyzeCommand = async (ctx: Context) => {
  const text = (ctx.message as any)?.text || '';
  const parts = text.split(' ').filter(Boolean);
  const mint = parts[1];

  if (!mint) {
    return ctx.reply('Usage: /analyze <mint>');
  }

  const basic = await getBasicTokenAnalysis(mint);
  const deep = await getDeepTokenAnalysis(mint);

  let message = UIHelper.header('DEEP TOKEN ANALYSIS', '🔍');
  message += `*${basic.name}* (${basic.symbol})\n`;
  message += `\`${mint}\`\n\n`;
  message += `Risk Score: *${basic.riskScore}/100* (${basic.riskLevel})\n`;
  message += `Top 10 Concentration: *${basic.top10Concentration.toFixed(1)}%*\n`;
  message += `Dev Holdings: *${basic.devHoldingsPercent.toFixed(1)}%*\n`;
  message += `Holders: *${basic.holderCount}*\n\n`;

  if (deep) {
    message += UIHelper.subHeader('TOP HOLDERS', '👑');
    deep.top10Holders.slice(0, 5).forEach((h, idx) => {
      message += `${idx + 1}. ${h.wallet.slice(0, 4)}..${h.wallet.slice(-4)} — ${h.percentage.toFixed(1)}%\n`;
    });

    message += UIHelper.subHeader('TRANSFER ANALYSIS', '🔁');
    message += `Transfer Recipients: ${deep.transferStats.totalTransferAddresses}\n`;
    message += `Never Bought: ${deep.transferStats.addressesNoPurchase}\n`;
    message += `Phishy Ratio: ${(deep.transferStats.phishyRatio * 100).toFixed(1)}%\n\n`;

    message += UIHelper.subHeader('POOL TIMELINE', '🧪');
    message += `Token Created: ${deep.tokenCreatedAt.toLocaleString()}\n`;
    if (deep.poolCreatedAt) {
      message += `Pool Created: ${deep.poolCreatedAt.toLocaleString()}\n`;
      message += `Pool Before Launch: ${deep.poolBeforeLaunch ? 'Yes' : 'No'}\n`;
    }
  } else {
    message += 'Deep analysis not available yet.\n';
  }

  return ctx.reply(message, { parse_mode: 'Markdown' });
};

