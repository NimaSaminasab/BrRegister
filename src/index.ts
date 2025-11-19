/**
 * Main entry point for BR-register
 * Synkroniserer alle selskapene til PostgreSQL database-1
 */

import dotenv from 'dotenv';
import { syncToPostgres } from './sync-to-postgres';

dotenv.config();

async function main() {
  console.log('Starter synkronisering av alle selskapene til database-1...');
  await syncToPostgres();
  console.log('Synkronisering fullført!');
}

main().catch((error) => {
  console.error('Feil ved synkronisering:', error);
  process.exit(1);
});

