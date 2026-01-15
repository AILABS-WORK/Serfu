import { extractMints } from '../src/parsers/mint';
import { detectSignal } from '../src/ingest/classifier';

describe('Mint Extraction', () => {
  it('extracts valid base58 mints', async () => {
    const text = 'Buy DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 now!';
    const mints = await extractMints(text);
    expect(mints).toContain('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
  });

  it('ignores invalid strings', async () => {
    const text = 'Hello world this is not a mint';
    const mints = await extractMints(text);
    expect(mints).toHaveLength(0);
  });
});

describe('Signal Detection', () => {
  it('detects signal with keywords', async () => {
    const text = 'Signal: Buy DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
    const result = await detectSignal(text);
    expect(result.isSignal).toBe(true);
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('rejects without mint', async () => {
    const text = 'Buy this coin now LFG';
    const result = await detectSignal(text);
    expect(result.isSignal).toBe(false);
  });
});











