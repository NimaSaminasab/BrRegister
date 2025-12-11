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

  // Log all requests for debugging - MUST be first middleware
  app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - Request received`);
    console.log(`  Headers:`, JSON.stringify(req.headers));
    next();
  });

  // Parse JSON bodies
  app.use(express.json());

  // API routes må komme FØR static file serving for å unngå konflikter
  // Serve static files from public directory
  // __dirname in compiled code is dist/src, so we need to go up two levels
  const publicPath = path.join(__dirname, '../../public');
  
  // API routes - må være før static files
  const apiRouter = express.Router();
  
  // Test route to verify API router is working
  apiRouter.get('/test', (_req: Request, res: Response) => {
    console.log('✅ GET /api/test mottatt');
    res.json({ message: 'API router fungerer!', timestamp: new Date().toISOString() });
  });
  
  apiRouter.post('/scrape-pdf', async (req: Request, res: Response) => {
    console.log('📥 POST /api/scrape-pdf mottatt');
    console.log('Request body:', JSON.stringify(req.body));
    
    try {
      const { orgnr, year } = req.body;
      
      console.log(`Parsed: orgnr=${orgnr}, year=${year}`);
      
      if (!orgnr || !year) {
        console.log('❌ Mangler organisasjonsnummer eller år');
        return res.status(400).json({ 
          message: 'Mangler organisasjonsnummer eller år',
          error: 'orgnr og year er påkrevd'
        });
      }
      
      const orgnrClean = orgnr.replace(/\D+/g, '');
      const yearNum = parseInt(year.toString(), 10);
      
      console.log(`Cleaned: orgnrClean=${orgnrClean}, yearNum=${yearNum}`);
      
      if (!orgnrClean || isNaN(yearNum) || yearNum < 1990 || yearNum > new Date().getFullYear() + 1) {
        console.log('❌ Ugyldig organisasjonsnummer eller år');
        return res.status(400).json({ 
          message: 'Ugyldig organisasjonsnummer eller år',
          error: 'orgnr må være et gyldig organisasjonsnummer og year må være et gyldig årstall'
        });
      }
      
      console.log(`✅ Starter scraping PDF for ${orgnrClean}, år ${yearNum}...`);
      const result = await scrapePdfForYear(orgnrClean, yearNum);
      console.log(`✅ Scraping fullført. Resultat:`, JSON.stringify(result));
      
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

  // Mount API router - MUST be before static files
  app.use('/api', apiRouter);
  console.log('✅ API router mounted at /api');

  // Deretter static file serving - only handles GET requests for files
  app.use(express.static(publicPath, { 
    // Don't handle POST/PUT/DELETE requests
    setHeaders: (res, path) => {
      console.log(`Static file serving: ${path}`);
    }
  }));
  console.log('✅ Static files mounted');

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

  // Catch-all for unmatched routes (after static files)
  app.use((req: Request, res: Response) => {
    console.warn(`⚠️ 404: ${req.method} ${req.path} - Route not found`);
    res.status(404).json({ 
      error: 'Not Found',
      path: req.path,
      method: req.method
    });
  });

  return app;
}

export async function startServer(port = DEFAULT_PORT) {
  const app = await createApp();
  const host = process.env.HOST || '0.0.0.0'; // Lytter på alle interfaces for ekstern tilgang

  return new Promise<void>((resolve, reject) => {
    const server = app.listen(port, host, () => {
      console.log(`🚀 Server kjører på http://${host}:${port}`);
      console.log(`   -> Besøk http://localhost:${port}/ for å se selskaper`);
      console.log(`   -> Besøk http://localhost:${port}/annual-reports.html for å se årsregnskap`);
      console.log(`   -> Ekstern tilgang: http://<EC2-IP>:${port}/annual-reports.html`);
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

