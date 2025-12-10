import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import * as path from 'path';

import { fetchCompaniesFromPostgres } from './print-postgres-companies';
import { fetchAnnualReportsFromPostgres } from './fetch-annual-reports';
import { scrapePdfForYear } from './scrape-pdf';

dotenv.config();

const DEFAULT_PORT = Number(process.env.PORT ?? '3000');

export async function createApp() {
  const app = express();

  // Parse JSON bodies
  app.use(express.json());

  // Serve static files from public directory
  // __dirname in compiled code is dist/src, so we need to go up two levels
  const publicPath = path.join(__dirname, '../../public');
  app.use(express.static(publicPath));

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
      const err = error as Error;
      const isTimeout = err.message.includes('ETIMEDOUT') || err.message.includes('timeout');
      const isConnectionError = err.message.includes('ECONNREFUSED') || err.message.includes('connect');
      
      let errorMessage = 'Kunne ikke hente årsregnskap';
      if (isTimeout || isConnectionError) {
        errorMessage = 'Kunne ikke koble til databasen. Sjekk at databasen er tilgjengelig og at du har riktige tilgangsrettigheter.';
      }
      
      res.status(500).json({ 
        message: errorMessage,
        error: err.message,
        details: isTimeout || isConnectionError ? 'Database connection failed' : undefined
      });
    }
  });

  app.post('/api/scrape-pdf', async (req: Request, res: Response) => {
    try {
      const { orgnr, year } = req.body;
      
      if (!orgnr || !year) {
        return res.status(400).json({ 
          message: 'Mangler organisasjonsnummer eller år',
          error: 'orgnr og year er påkrevd'
        });
      }
      
      const orgnrClean = orgnr.replace(/\D+/g, '');
      const yearNum = parseInt(year.toString(), 10);
      
      if (!orgnrClean || isNaN(yearNum) || yearNum < 1990 || yearNum > new Date().getFullYear() + 1) {
        return res.status(400).json({ 
          message: 'Ugyldig organisasjonsnummer eller år',
          error: 'orgnr må være et gyldig organisasjonsnummer og year må være et gyldig årstall'
        });
      }
      
      console.log(`Scraping PDF for ${orgnrClean}, år ${yearNum}...`);
      const result = await scrapePdfForYear(orgnrClean, yearNum);
      
      if (result.success && result.aarsresultat !== null) {
        res.json({
          success: true,
          aarsresultat: result.aarsresultat,
          message: result.message,
        });
      } else {
        res.status(404).json({
          success: false,
          aarsresultat: null,
          message: result.message,
        });
      }
    } catch (error) {
      console.error('Failed to scrape PDF', error);
      const err = error as Error;
      res.status(500).json({ 
        message: 'Kunne ikke scrape PDF',
        error: err.message
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

