
export class UIHelper {
  static header(text: string, icon: string = '📊'): string {
    return `${icon} *${text.toUpperCase()}*\n` + this.separator();
  }

  static separator(): string {
    return '━━━━━━━━━━━━━━━━━━━━━━\n';
  }

  static subHeader(text: string): string {
    return `\n🔸 *${text}*\n`;
  }

  static field(key: string, value: string): string {
    return `*${key}:* \`${value}\``;
  }

  static formatCurrency(val: number): string {
    if (val === 0) return '$0';
    if (val < 0.000001) return `$${val.toExponential(2)}`;
    if (val < 0.01) return `$${val.toFixed(6)}`;
    if (val < 1) return `$${val.toFixed(4)}`;
    return `$${val.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  }

  static formatPercent(val: number): string {
    const sign = val > 0 ? '+' : '';
    return `${sign}${val.toFixed(1)}%`;
  }

  static formatMultiple(val: number): string {
    return `${val.toFixed(2)}x`;
  }

  static formatTimeAgo(date: Date): string {
    const diffMs = Date.now() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    return `${Math.floor(diffHours / 24)}d ago`;
  }

  static progressBar(value: number, max: number, length: number = 8): string {
    const filled = Math.round((Math.min(value, max) / max) * length);
    return '█'.repeat(filled) + '░'.repeat(length - filled);
  }

  static pad(str: string, length: number): string {
    return str.padEnd(length, ' ');
  }
}
