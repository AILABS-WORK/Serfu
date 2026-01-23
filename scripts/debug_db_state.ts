import { prisma } from '../src/db';

async function checkDbState() {
  console.log('Checking DB State...');
  
  const signals = await prisma.signal.findMany({
    take: 5,
    orderBy: { detectedAt: 'desc' },
    include: {
      metrics: true,
      group: true,
      user: true
    }
  });

  console.log(`Found ${signals.length} recent signals.`);
  
  for (const s of signals) {
    console.log(`Signal ${s.id} (${s.mint}):`);
    console.log(`  Group: ${s.group?.name} (ID: ${s.groupId})`);
    console.log(`  User: ${s.user?.username} (ID: ${s.userId})`);
    console.log(`  Entry: ${s.entryPrice}`);
    console.log(`  DetectedAt: ${s.detectedAt}`);
    
    if (s.metrics) {
      console.log(`  Metrics: ATH ${s.metrics.athMultiple}x, DD ${s.metrics.maxDrawdown}, Updated ${s.metrics.updatedAt}`);
    } else {
      console.log(`  Metrics: NONE`);
    }
  }
}

checkDbState()
  .catch(console.error)
  .finally(() => prisma.$disconnect());













