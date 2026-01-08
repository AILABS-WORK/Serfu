import { extractMints } from '../src/parsers/mint';
import { detectSignal } from '../src/ingest/classifier';

describe('Mint Extraction', () => {
  it('extracts valid base58 mints', () => {
    const text = 'Buy DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 now!';
    const mints = extractMints(text);
    expect(mints).toContain('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
  });

  it('ignores invalid strings', () => {
    const text = 'Hello world this is not a mint';
    const mints = extractMints(text);
    expect(mints).toHaveLength(0);
  });
});

describe('Signal Detection', () => {
  it('detects signal with keywords', () => {
    const text = 'Signal: Buy DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
    const result = detectSignal(text);
    expect(result.isSignal).toBe(true);
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('rejects without mint', () => {
    const text = 'Buy this coin now LFG';
    const result = detectSignal(text);
    expect(result.isSignal).toBe(false);
  });
});



