
export class UIHelper {
  // Separators
  static separator(type: 'HEAVY' | 'LIGHT' | 'DOTTED' = 'HEAVY'): string {
    switch (type) {
      case 'LIGHT': return '──────────────────────\n';
      case 'DOTTED': return '......................\n';
      case 'HEAVY': default: return '━━━━━━━━━━━━━━━━━━━━━━\n';
    }
  }

  // Headers
  static header(text: string, icon: string = '🏁'): string {
    // Primary Header: Icon + Bold Uppercase
    return `${icon} **${text.toUpperCase()}**\n` + this.separator('HEAVY');
  }

  static subHeader(text: string, icon: string = '🔹'): string {
    // Secondary Header
    return `\n${icon} **${text}**\n`;
  }

  static sectionTitle(text: string): string {
    return `\n▫️ _${text}_\n`;
  }

  // Fields
  static field(key: string, value: string): string {
    return `*${key}:* ${value}`;
  }

  static keyValue(key: string, value: string, padding: number = 0): string {
    // For monospaced alignment if needed, though variable width font makes this hard in TG
    return `*${key}:* ${value}`;
  }

  // Formatting
  static formatCurrency(val: number): string {
    if (val === 0) return '`$0`';
    if (val < 0.000001) return `\`$${val.toExponential(2)}\``;
    if (val < 0.01) return `\`$${val.toFixed(6)}\``;
    if (val < 1) return `\`$${val.toFixed(4)}\``;
    return `\`$${val.toLocaleString('en-US', { maximumFractionDigits: 2 })}\``;
  }

  static formatPercent(val: number, bold: boolean = true): string {
    const sign = val > 0 ? '+' : '';
    const str = `${sign}${val.toFixed(1)}%`;
    return bold ? `*${str}*` : str;
  }

  static formatMultiple(val: number): string {
    return `\`${val.toFixed(2)}x\``;
  }

  static formatTimeAgo(date: Date): string {
    const diffMs = Date.now() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    return `${Math.floor(diffHours / 24)}d ago`;
  }

  // Visuals
  static progressBar(value: number, max: number, length: number = 8): string {
    const filled = Math.round((Math.min(value, max) / max) * length);
    return '█'.repeat(filled) + '░'.repeat(length - filled);
  }

  static getStatusIcon(pnl: number): string {
    if (pnl > 100) return '🚀';
    if (pnl > 0) return '🟢';
    if (pnl > -10) return '⚪'; // Neutral-ish
    return '🔴';
  }

  static pad(str: string, length: number): string {
    return str.padEnd(length, ' ');
  }
}
