import { extractMints } from '../parsers/mint';

interface SignalDetectionResult {
  isSignal: boolean;
  mints: string[];
  confidence: number;
  templateId?: string;
}

const SIGNAL_KEYWORDS = ['signal', 'buy', 'entry', 'mc', 'market cap', 'lfg', 'ape', 'calls', 'setup'];

export const detectSignal = async (text: string): Promise<SignalDetectionResult> => {
  const mints = await extractMints(text);
  
  if (mints.length === 0) {
    return { isSignal: false, mints: [], confidence: 0 };
  }

  const lowerText = text.toLowerCase().trim();
  
  // Heuristic: Mint + Keywords (high confidence)
  const hasKeyword = SIGNAL_KEYWORDS.some(kw => lowerText.includes(kw));
  
  if (hasKeyword) {
    return {
      isSignal: true,
      mints,
      confidence: 0.9,
      templateId: 'heuristic_keyword'
    };
  }

  // If text is just a mint address (or very short), treat it as a signal
  // This is common in signal groups where people just post CAs
  const textWithoutMints = text.replace(new RegExp(mints.join('|'), 'gi'), '').trim();
  const isJustMint = textWithoutMints.length < 20; // Allow some whitespace/formatting
  
  if (isJustMint) {
    return {
      isSignal: true,
      mints,
      confidence: 0.7,
      templateId: 'standalone_mint'
    };
  }

  // If mint is present but with longer text, still treat as potential signal
  // (might be a signal with description)
  return {
    isSignal: true,
    mints,
    confidence: 0.6,
    templateId: 'mint_with_text'
  };
};
