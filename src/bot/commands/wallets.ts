import { Context } from 'telegraf';
import { bitquery } from '../../providers/bitquery';
import { solana } from '../../providers/solana';
import { UIHelper } from '../../utils/ui';
import { findSmartMoney } from '../../analytics/smartMoney';

export const handleWalletCommand = async (ctx: Context) => {
  const text = (ctx.message as any)?.text || '';
  const parts = text.split(' ').filter(Boolean);
  const wallet = parts[1];

  if (!wallet) return ctx.reply('Usage: /wallet <address>');

  const stats = await bitquery.getWalletPnL(wallet);
  if (stats.length === 0) {
    return ctx.reply('No wallet stats found.');
  }

  let message = UIHelper.header('WALLET ANALYSIS', '👤');
  message += `Wallet: \`${wallet}\`\n\n`;
  stats.slice(0, 5).forEach((s) => {
    message += `• *${s.token.symbol}* PnL: ${UIHelper.formatMarketCap(s.pnl)} | ROI: ${UIHelper.formatPercent(s.roi)}\n`;
  });

  return ctx.reply(message, { parse_mode: 'Markdown' });
};

export const handleWhalesCommand = async (ctx: Context) => {
  const text = (ctx.message as any)?.text || '';
  const parts = text.split(' ').filter(Boolean);
  const mint = parts[1];
  if (!mint) return ctx.reply('Usage: /whales <mint>');

  const holders = await solana.getTopHolders(mint, 10);
  if (holders.length === 0) {
    return ctx.reply('No holder data found.');
  }

  let message = UIHelper.header('TOP HOLDERS', '🐋');
  message += `Mint: \`${mint}\`\n\n`;
  holders.forEach((h, idx) => {
    message += `${idx + 1}. ${h.address.slice(0, 4)}..${h.address.slice(-4)} — ${h.percentage.toFixed(2)}%\n`;
  });

  return ctx.reply(message, { parse_mode: 'Markdown' });
};

export const handleSmartMoneyCommand = async (ctx: Context) => {
  const wallets = await findSmartMoney(10);
  if (wallets.length === 0) {
    return ctx.reply('No smart money data yet.');
  }

  let message = UIHelper.header('SMART MONEY', '💸');
  wallets.forEach((w, idx) => {
    message += `${idx + 1}. ${w.wallet.slice(0, 4)}..${w.wallet.slice(-4)} — winRate ${(w.winRate * 100).toFixed(0)}% | avg ${w.avgMultiple.toFixed(2)}x\n`;
  });

  return ctx.reply(message, { parse_mode: 'Markdown' });
};

