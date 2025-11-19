import express, { Request, Response } from 'express';
import dotenv from 'dotenv';

import { fetchCompaniesFromPostgres } from './print-postgres-companies';

dotenv.config();

const DEFAULT_PORT = Number(process.env.PORT ?? '3000');

export async function createApp() {
  const app = express();

  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  app.get('/companies', async (_req: Request, res: Response) => {
    try {
      const companies = await fetchCompaniesFromPostgres();
      res.json(companies);
    } catch (error) {
      console.error('Failed to fetch companies', error);
      res.status(500).json({ message: 'Kunne ikke hente selskaper', error: (error as Error).message });
    }
  });

  return app;
}

export async function startServer(port = DEFAULT_PORT) {
  const app = await createApp();

  return new Promise<void>((resolve, reject) => {
    const server = app.listen(port, () => {
      console.log(`🚀 Server kjører på http://localhost:${port}`);
      console.log(`   -> Besøk http://localhost:${port}/companies for å se alle selskaper`);
      resolve();
    });

    server.on('error', (error) => {
      reject(error);
    });
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error('Kunne ikke starte serveren:', error);
    process.exit(1);
  });
}

