import { extractMints } from '../parsers/mint';

interface SignalDetectionResult {
  isSignal: boolean;
  mints: string[];
  confidence: number;
  templateId?: string;
}

const SIGNAL_KEYWORDS = ['signal', 'buy', 'entry', 'mc', 'market cap', 'lfg', 'ape', 'calls', 'setup'];

export const detectSignal = (text: string): SignalDetectionResult => {
  const mints = extractMints(text);
  
  if (mints.length === 0) {
    return { isSignal: false, mints: [], confidence: 0 };
  }

  const lowerText = text.toLowerCase();
  
  // Heuristic: Mint + Keywords
  const hasKeyword = SIGNAL_KEYWORDS.some(kw => lowerText.includes(kw));
  
  if (hasKeyword) {
    return {
      isSignal: true,
      mints,
      confidence: 0.8,
      templateId: 'heuristic_v1'
    };
  }

  // If just a mint is posted, it might be a signal or just discussion.
  // For AlphaColor (Group), usually a mint post IS a signal if it's from the admin/channel.
  // Assuming "Bot is added to the AlphaColor group" implies broadly treating mints as potential signals.
  // Let's be slightly conservative: if it's JUST a mint (or short text), maybe yes?
  // PRD 4.2 says: "Fallback heuristic: presence of a valid Solana mint + one or more keywords"
  
  return {
    isSignal: false, // Strict per PRD fallback rule
    mints,
    confidence: 0.2
  };
};

