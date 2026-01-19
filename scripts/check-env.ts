import dotenv from 'dotenv';
dotenv.config();

console.log('Checking environment variables...');
console.log('HELIUS_API_KEY present:', !!process.env.HELIUS_API_KEY, 'Length:', process.env.HELIUS_API_KEY?.length);
console.log('DATABASE_URL present:', !!process.env.DATABASE_URL);
console.log('REDIS_URL present:', !!process.env.REDIS_URL);
console.log('BOT_TOKEN present:', !!process.env.BOT_TOKEN);














