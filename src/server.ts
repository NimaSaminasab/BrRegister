import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import * as path from 'path';

import { fetchCompaniesFromPostgres } from './print-postgres-companies';
import { fetchAnnualReportsFromPostgres } from './fetch-annual-reports';

dotenv.config();

const DEFAULT_PORT = Number(process.env.PORT ?? '3000');

export async function createApp() {
  const app = express();

  // Serve static files from public directory
  app.use(express.static(path.join(__dirname, '../public')));

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

  app.get('/api/annual-reports', async (req: Request, res: Response) => {
    try {
      const organisasjonsnummer = req.query.orgnr as string | undefined;
      const reports = await fetchAnnualReportsFromPostgres(organisasjonsnummer);
      res.json(reports);
    } catch (error) {
      console.error('Failed to fetch annual reports', error);
      res.status(500).json({ 
        message: 'Kunne ikke hente årsregnskap', 
        error: (error as Error).message 
      });
    }
  });

  return app;
}

export async function startServer(port = DEFAULT_PORT) {
  const app = await createApp();

  return new Promise<void>((resolve, reject) => {
    const server = app.listen(port, () => {
      console.log(`🚀 Server kjører på http://localhost:${port}`);
      console.log(`   -> Besøk http://localhost:${port}/ for å se selskaper`);
      console.log(`   -> Besøk http://localhost:${port}/annual-reports.html for å se årsregnskap`);
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

