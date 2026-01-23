export interface RiskInputs {
  top10Concentration: number;
  devHoldingsPercent: number;
  tokenAgeHours: number;
  phishyRatio?: number;
  liquiditySol?: number;
}

export const calculateRiskScore = (inputs: RiskInputs): number => {
  let score = 0;

  if (inputs.top10Concentration > 70) score += 30;
  else if (inputs.top10Concentration > 50) score += 20;
  else if (inputs.top10Concentration > 30) score += 10;

  if (inputs.devHoldingsPercent > 10) score += 20;
  else if (inputs.devHoldingsPercent > 5) score += 15;
  else if (inputs.devHoldingsPercent > 2) score += 5;

  if (inputs.tokenAgeHours < 1) score += 15;
  else if (inputs.tokenAgeHours < 6) score += 10;
  else if (inputs.tokenAgeHours < 24) score += 5;

  if (inputs.phishyRatio !== undefined) {
    if (inputs.phishyRatio > 0.5) score += 20;
    else if (inputs.phishyRatio > 0.3) score += 15;
    else if (inputs.phishyRatio > 0.1) score += 5;
  }

  if (inputs.liquiditySol !== undefined) {
    if (inputs.liquiditySol < 1) score += 15;
    else if (inputs.liquiditySol < 5) score += 10;
    else if (inputs.liquiditySol < 10) score += 5;
  }

  return Math.min(100, score);
};

export const getRiskLevel = (score: number): 'LOW' | 'MEDIUM' | 'HIGH' => {
  if (score < 30) return 'LOW';
  if (score < 60) return 'MEDIUM';
  return 'HIGH';
};

