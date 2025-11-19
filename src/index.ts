/**
 * Main entry point for BR-register
 * Starter en HTTP-server som viser alle selskapene fra PostgreSQL
 */

import { startServer } from './server';

startServer().catch((error) => {
  console.error('Feil ved oppstart av server:', error);
  process.exit(1);
});

