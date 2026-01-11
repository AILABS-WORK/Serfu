// Dynamic imports for ESM modules
let ChartJSNodeCanvas: any;

const getChartModules = async () => {
  if (!ChartJSNodeCanvas) {
    const chartjsNodeCanvas = await import('chartjs-node-canvas');
    ChartJSNodeCanvas = chartjsNodeCanvas.ChartJSNodeCanvas;
  }
  return { ChartJSNodeCanvas };
};

import { PriceSample, Signal, Prisma } from '../generated/client';

const width = 800;
const height = 400;
const chartCallback = (ChartJS: any) => {
    // Optional: Global config
};

export const renderChart = async (signal: Signal, samples: PriceSample[]): Promise<Buffer> => {
  if (samples.length === 0) {
    throw new Error('No samples to chart');
  }

  const { ChartJSNodeCanvas } = await getChartModules();
  const chartJSNodeCanvas = new ChartJSNodeCanvas({ width, height, chartCallback });

  const sortedSamples = [...samples].sort((a, b) => a.sampledAt.getTime() - b.sampledAt.getTime());
  
  const labels = sortedSamples.map(s => {
    return s.sampledAt.toISOString().substring(11, 16);
  });
  
  const dataPoints = sortedSamples.map(s => s.price);
  const entryPrice = signal.entryPrice || dataPoints[0];

  const configuration: any = {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: `${signal.symbol || 'Token'} Price`,
          data: dataPoints,
          borderColor: 'rgb(75, 192, 192)',
          tension: 0.1,
          pointRadius: 0
        },
        {
            label: 'Entry',
            data: Array(labels.length).fill(entryPrice),
            borderColor: 'rgb(54, 162, 235)',
            borderDash: [5, 5],
            pointRadius: 0
        }
      ]
    },
    options: {
      plugins: {
        title: {
          display: true,
          text: `${signal.name} (${signal.mint}) - ${signal.category || 'General'}`
        }
      },
      scales: {
        y: {
            beginAtZero: false
        }
      }
    }
  };

  return chartJSNodeCanvas.renderToBuffer(configuration);
};
