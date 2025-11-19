/**
 * Main entry point for BR-register
 * Leser alle selskapene fra PostgreSQL database-1 og skriver dem ut som JSON
 */

import dotenv from 'dotenv';
import { printCompaniesAsJson } from './print-postgres-companies';

dotenv.config();

async function main() {
  console.log('Leser alle selskaper fra database-1 og skriver dem ut som JSON...');
  await printCompaniesAsJson();
  console.log('Ferdig!');
}

main().catch((error) => {
  console.error('Feil ved uthenting av data:', error);
  process.exit(1);
});

