import { HeliusProvider } from './helius';

const API_KEY = process.env.HELIUS_API_KEY || '';

export const provider = new HeliusProvider(API_KEY);




