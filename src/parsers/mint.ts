import bs58 from 'bs58';

// Basic regex for Base58 string of correct length
const BASE58_REGEX = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

export const extractMints = (text: string): string[] => {
  if (!text) return [];
  
  const matches = text.match(BASE58_REGEX);
  if (!matches) return [];

  // Filter for valid Solana public keys (32 bytes decoded)
  const validMints = matches.filter(candidate => {
    try {
      const decoded = bs58.decode(candidate);
      return decoded.length === 32;
    } catch {
      return false;
    }
  });

  // Deduplicate
  return [...new Set(validMints)];
};

