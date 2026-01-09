#!/usr/bin/env ts-node
/**
 * Script to create Prisma migrations
 * Usage: npx ts-node scripts/create-migration.ts [migration-name]
 */

import { execSync } from 'child_process';

const migrationName = process.argv[2] || 'update_schema';

console.log(`Creating migration: ${migrationName}...`);

try {
  execSync(`npx prisma migrate dev --name ${migrationName} --create-only`, {
    stdio: 'inherit',
  });
  console.log('✅ Migration created successfully!');
  console.log('📝 Review the migration file in prisma/migrations/');
  console.log('🚀 Apply it with: npx prisma migrate deploy');
} catch (error) {
  console.error('❌ Failed to create migration:', error);
  process.exit(1);
}


