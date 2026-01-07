// Dynamic import for ESM module
let bs58: any;

const getBs58 = async () => {
  if (!bs58) {
    bs58 = await import('bs58');
  }
  return bs58.default || bs58;
};

// Basic regex for Base58 string of correct length
const BASE58_REGEX = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

export const extractMints = async (text: string): Promise<string[]> => {
  if (!text) return [];
  
  const matches = text.match(BASE58_REGEX);
  if (!matches) return [];

  const bs58Module = await getBs58();
  
  // Filter for valid Solana public keys (32 bytes decoded)
  const validMints = matches.filter(candidate => {
    try {
      const decoded = bs58Module.decode(candidate);
      return decoded.length === 32;
    } catch {
      return false;
    }
  });

  // Deduplicate
  return [...new Set(validMints)];
};
