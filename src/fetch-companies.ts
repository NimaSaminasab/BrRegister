/**
 * Script for å hente alle bedrifter fra Brønnøysundregistrene
 * 
 * Dette scriptet henter alle tilgjengelige bedrifter ved å:
 * 1. Bruke oppdateringer-endepunktet for å få alle organisasjonsnumre
 * 2. Hente detaljert informasjon for hver bedrift
 * 
 * ALTERNATIV: Brønnøysundregistrene tilbyr også bulk-nedlasting av data.
 * Sjekk https://data.brreg.no/enhetsregisteret/api/dokumentasjon/no/index.html
 * for informasjon om bulk downloads som kan være raskere for initial import.
 */

import axios, { AxiosInstance, AxiosResponse } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { pipeline as streamPipeline } from 'stream/promises';
import { chain } from 'stream-chain';
import { parser } from 'stream-json';
import { streamArray } from 'stream-json/streamers/StreamArray';
import { Enhet, Oppdatering, ApiResponse } from './types';

const BRREG_API_BASE = 'https://data.brreg.no/enhetsregisteret/api';
const OUTPUT_DIR = path.join(__dirname, '../data');
const COMPANIES_FILE = path.join(OUTPUT_DIR, 'companies.json');
const ORGNUMMER_FILE = path.join(OUTPUT_DIR, 'organisasjonsnumre.json');
const BULK_GZIP_FILE = path.join(OUTPUT_DIR, 'enheter-bulk.json.gz');
const PAGINATION_PAGE_SIZE = 1000;
const MAX_PAGINATION_RETRIES = 5;

class PaginationLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaginationLimitError';
  }
}

// Rate limiting: maks 10 requests per sekund
const RATE_LIMIT_DELAY = 100; // ms mellom requests

class BrregFetcher {
  private client: AxiosInstance;
  private delay: number;

  constructor(rateLimitDelay: number = RATE_LIMIT_DELAY) {
    this.client = axios.create({
      baseURL: BRREG_API_BASE,
      timeout: 30000,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'BR-register/1.0'
      }
    });
    this.delay = rateLimitDelay;
  }

  /**
   * Vent mellom requests for å unngå rate limiting
   */
  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Hent alle organisasjonsnumre fra oppdateringer-endepunktet
   * Dette gir oss en komplett liste over alle bedrifter
   */
  async fetchAllOrganisasjonsnumre(): Promise<string[]> {
    console.log('Henter alle organisasjonsnumre fra oppdateringer-endepunktet...');
    const organisasjonsnumre = new Set<string>();
    let page = 0;
    let hasMore = true;

    while (hasMore) {
      try {
        const response = await this.client.get<ApiResponse<Oppdatering>>(
          `/oppdateringer/enheter?page=${page}&size=1000`
        );

        const data = response.data;
        const oppdateringer = data._embedded?.oppdateringer || [];

        if (oppdateringer.length === 0) {
          hasMore = false;
          break;
        }

        oppdateringer.forEach(oppdatering => {
          organisasjonsnumre.add(oppdatering.organisasjonsnummer);
        });

        console.log(`Hentet side ${page + 1}, totalt ${organisasjonsnumre.size} unike organisasjonsnumre`);

        // Sjekk om det er flere sider
        if (data._links?.next) {
          page++;
          await this.sleep(this.delay);
        } else {
          hasMore = false;
        }
      } catch (error: any) {
        if (error.response?.status === 404) {
          hasMore = false;
        } else {
          console.error(`Feil ved henting av side ${page}:`, error.message);
          await this.sleep(this.delay * 5); // Vent litt lenger ved feil
        }
      }
    }

    return Array.from(organisasjonsnumre);
  }

  /**
   * Hent detaljert informasjon om en enkelt bedrift
   */
  async fetchEnhet(organisasjonsnummer: string): Promise<Enhet | null> {
    try {
      const response = await this.client.get<Enhet>(
        `/enheter/${organisasjonsnummer}`
      );
      await this.sleep(this.delay);
      return response.data;
    } catch (error: any) {
      if (error.response?.status === 404) {
        console.warn(`Bedrift ${organisasjonsnummer} ikke funnet`);
        return null;
      }
      console.error(`Feil ved henting av ${organisasjonsnummer}:`, error.message);
      return null;
    }
  }

  /**
   * Hent alle bedrifter med detaljert informasjon
   */
  async fetchAllCompanies(organisasjonsnumre: string[]): Promise<Enhet[]> {
    console.log(`Henter detaljert informasjon for ${organisasjonsnumre.length} bedrifter...`);
    const companies: Enhet[] = [];
    const batchSize = 100;

    for (let i = 0; i < organisasjonsnumre.length; i += batchSize) {
      const batch = organisasjonsnumre.slice(i, i + batchSize);
      console.log(`Henter batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(organisasjonsnumre.length / batchSize)} (${i + 1}-${Math.min(i + batchSize, organisasjonsnumre.length)} av ${organisasjonsnumre.length})`);

      const promises = batch.map(orgnr => this.fetchEnhet(orgnr));
      const results = await Promise.all(promises);

      results.forEach((company, index) => {
        if (company) {
          companies.push(company);
        }
      });

      // Lagre progresjon
      if ((i + batchSize) % 1000 === 0 || i + batchSize >= organisasjonsnumre.length) {
        await this.saveProgress(companies);
      }
    }

    return companies;
  }

  /**
   * Fallback: hent alle enheter direkte fra /enheter-endepunktet med paginering
   */
  async fetchAllCompaniesPaginated(existingCompanies: Enhet[] = []): Promise<Enhet[]> {
    console.log('Faller tilbake til paginert henting fra /enheter...');
    const companies: Enhet[] = [...existingCompanies];
    const seen = new Set(companies.map(company => company.organisasjonsnummer));
    let nextPath: string | undefined = `/enheter?page=0&size=${PAGINATION_PAGE_SIZE}`;
    let page = 0;
    let retries = 0;

    while (nextPath) {
      try {
        const response: AxiosResponse<ApiResponse<Enhet>> = await this.client.get<ApiResponse<Enhet>>(nextPath);

        const data = response.data;
        const enheter = data._embedded?.enheter || [];

        if (enheter.length === 0) {
          if (page === 0) {
            console.warn('Ingen enheter returnert fra /enheter-endepunktet.');
          }
          break;
        }

        let inserted = 0;
        for (const enhet of enheter) {
          if (!enhet.organisasjonsnummer) {
            continue;
          }
          if (!seen.has(enhet.organisasjonsnummer)) {
            companies.push(enhet);
            seen.add(enhet.organisasjonsnummer);
            inserted++;
          }
        }

        const totalPagesText = typeof data.page?.totalPages === 'number'
          ? `/${data.page.totalPages}`
          : '';
        console.log(
          `Hentet side ${page + 1}${totalPagesText}, ${inserted} nye enheter, totalt ${companies.length}`
        );

        // Lagre progresjon etter hver side for å kunne gjenoppta ved avbrudd
        await this.saveProgress(companies);

        nextPath = data._links?.next?.href;
        if (nextPath && nextPath.startsWith(BRREG_API_BASE)) {
          nextPath = nextPath.replace(BRREG_API_BASE, '');
        }

        if (nextPath) {
          page++;
          retries = 0;
          await this.sleep(this.delay);
        }
      } catch (error: any) {
        const errorDetail = error.response?.data || error.message || error;
        console.error(`Feil ved henting av side ${page} fra /enheter:`, errorDetail);

        const detailAsString =
          typeof errorDetail === 'string'
            ? errorDetail
            : JSON.stringify(errorDetail);
        if (detailAsString.includes('size * (page+1)')) {
          throw new PaginationLimitError(detailAsString);
        }

        retries += 1;
        if (retries >= MAX_PAGINATION_RETRIES) {
          console.error(`Avbryter etter ${retries} mislykkede forsøk på side ${page}.`);
          break;
        }
        await this.sleep(this.delay * 5);
      }
    }

    return companies;
  }

  /**
   * Laster ned hele enhetsregisteret via bulk-endepunktet og lagrer til fil
   */
  async downloadBulkDataset(): Promise<{ count: number }> {
    console.log('Laster ned komplett datasett via /enheter/lastned (kan ta flere minutter)...');
    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    const response: AxiosResponse<NodeJS.ReadableStream> = await this.client.get('/enheter/lastned', {
      responseType: 'stream',
      headers: {
        Accept: 'application/vnd.brreg.enhetsregisteret.enhet.v2+gzip;charset=UTF-8',
      },
    });

    const gzipStream = response.data;
    await streamPipeline(gzipStream, fs.createWriteStream(BULK_GZIP_FILE));
    console.log(`Bulkfil lagret til ${BULK_GZIP_FILE}`);

    await streamPipeline(
      fs.createReadStream(BULK_GZIP_FILE),
      zlib.createGunzip(),
      fs.createWriteStream(COMPANIES_FILE)
    );
    console.log(`Bulkfil pakket ut til ${COMPANIES_FILE}`);

    const count = await this.generateOrganisasjonsnumreFromFile();
    console.log(`Genererte organisasjonsnumre for ${count} bedrifter`);

    // Fjern gzip-fil for å spare plass
    if (fs.existsSync(BULK_GZIP_FILE)) {
      fs.unlinkSync(BULK_GZIP_FILE);
    }

    return { count };
  }

  /**
   * Leser companies.json strømmende og genererer organisasjonsnumre-fil
   */
  private async generateOrganisasjonsnumreFromFile(): Promise<number> {
    if (!fs.existsSync(COMPANIES_FILE)) {
      throw new Error(`Fant ikke ${COMPANIES_FILE} etter bulk-nedlasting.`);
    }

    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    return new Promise<number>((resolve, reject) => {
      const jsonPipeline = chain([
        fs.createReadStream(COMPANIES_FILE),
        parser(),
        streamArray(),
      ]);
      const writer = fs.createWriteStream(ORGNUMMER_FILE);

      let first = true;
      let count = 0;

      writer.write('[\n');

      jsonPipeline.on('data', (data: { value: Enhet }) => {
        const orgnr = data.value?.organisasjonsnummer;
        if (!orgnr) {
          return;
        }

        const entry = `${first ? '  ' : ',\n  '}"${orgnr}"`;
        writer.write(entry);
        first = false;
        count += 1;
      });

      jsonPipeline.on('end', () => {
        writer.write(first ? ']\n' : '\n]\n');
        writer.end(() => resolve(count));
      });

      jsonPipeline.on('error', (error: unknown) => {
        const err = error instanceof Error ? error : new Error(String(error));
        writer.destroy(err);
        reject(err);
      });

      writer.on('error', (error: unknown) => {
        const err = error instanceof Error ? error : new Error(String(error));
        jsonPipeline.destroy(err);
        reject(err);
      });

    });
  }

  /**
   * Lagre progresjon til fil
   */
  async saveProgress(companies: Enhet[]): Promise<void> {
    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    fs.writeFileSync(
      COMPANIES_FILE,
      JSON.stringify(companies, null, 2),
      'utf-8'
    );
    console.log(`Lagret ${companies.length} bedrifter til ${COMPANIES_FILE}`);
  }

  /**
   * Lagre organisasjonsnumre til fil
   */
  async saveOrganisasjonsnumre(organisasjonsnumre: string[]): Promise<void> {
    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    fs.writeFileSync(
      ORGNUMMER_FILE,
      JSON.stringify(organisasjonsnumre, null, 2),
      'utf-8'
    );
    console.log(`Lagret ${organisasjonsnumre.length} organisasjonsnumre til ${ORGNUMMER_FILE}`);
  }
}

/**
 * Hovedfunksjon
 */
async function main() {
  console.log('Starter henting av bedriftsdata fra Brønnøysundregistrene...\n');

  const fetcher = new BrregFetcher();

  try {
    // Steg 1: Hent alle organisasjonsnumre
    let organisasjonsnumre: string[] = [];

    // Prøv å laste fra fil hvis den eksisterer
    if (fs.existsSync(ORGNUMMER_FILE)) {
      console.log('Fant eksisterende organisasjonsnumre-fil, laster den...');
      const fileContent = fs.readFileSync(ORGNUMMER_FILE, 'utf-8');
      organisasjonsnumre = JSON.parse(fileContent);
      console.log(`Ladet ${organisasjonsnumre.length} organisasjonsnumre fra fil`);
    } else {
      organisasjonsnumre = await fetcher.fetchAllOrganisasjonsnumre();
      await fetcher.saveOrganisasjonsnumre(organisasjonsnumre);
    }

    // Dersom oppdateringer-endepunktet ikke gir resultater, fall tilbake til paginering
    if (organisasjonsnumre.length === 0) {
      console.warn('Ingen organisasjonsnumre funnet via /oppdateringer. Bruker paginering via /enheter i stedet.');

      let existingCompanies: Enhet[] = [];
      if (fs.existsSync(COMPANIES_FILE)) {
        const fileContent = fs.readFileSync(COMPANIES_FILE, 'utf-8');
        existingCompanies = JSON.parse(fileContent);
        if (existingCompanies.length > 0) {
          console.log(`Fortsetter med ${existingCompanies.length} tidligere lagrede bedrifter.`);
        }
      }

      try {
        const companies = await fetcher.fetchAllCompaniesPaginated(existingCompanies);
        await fetcher.saveProgress(companies);

        const allOrgnumre = Array.from(
          new Set(
            companies
              .map(company => company.organisasjonsnummer)
              .filter((orgnr): orgnr is string => Boolean(orgnr))
          )
        );
        await fetcher.saveOrganisasjonsnumre(allOrgnumre);

        console.log(`\n✅ Ferdig! Hentet totalt ${companies.length} bedrifter via paginering`);
        console.log(`Data lagret i: ${COMPANIES_FILE}`);
        return;
      } catch (error: any) {
        if (error instanceof PaginationLimitError) {
          console.warn('API-et begrenser paginering til 10 000 oppføringer per søk. Laster ned bulkfil i stedet...');
          const { count } = await fetcher.downloadBulkDataset();
          console.log(`\n✅ Ferdig! Hentet totalt ${count} bedrifter via bulkfil`);
          console.log(`Data lagret i: ${COMPANIES_FILE}`);
          console.log(`Organisasjonsnumre lagret i: ${ORGNUMMER_FILE}`);
          return;
        }
        throw error;
      }
    }

    // Steg 2: Hent detaljert informasjon for alle bedrifter
    let companies: Enhet[] = [];

    // Prøv å laste eksisterende data
    if (fs.existsSync(COMPANIES_FILE)) {
      console.log('Fant eksisterende bedriftsdata, laster den...');
      const fileContent = fs.readFileSync(COMPANIES_FILE, 'utf-8');
      companies = JSON.parse(fileContent);
      console.log(`Ladet ${companies.length} bedrifter fra fil`);

      // Finn organisasjonsnumre som mangler
      const existingOrgnumre = new Set(companies.map(c => c.organisasjonsnummer));
      const missingOrgnumre = organisasjonsnumre.filter(orgnr => !existingOrgnumre.has(orgnr));

      if (missingOrgnumre.length > 0) {
        console.log(`Henter ${missingOrgnumre.length} manglende bedrifter...`);
        const missingCompanies = await fetcher.fetchAllCompanies(missingOrgnumre);
        companies = [...companies, ...missingCompanies];
        await fetcher.saveProgress(companies);
      }
    } else {
      companies = await fetcher.fetchAllCompanies(organisasjonsnumre);
      await fetcher.saveProgress(companies);
    }

    console.log(`\n✅ Ferdig! Hentet totalt ${companies.length} bedrifter`);
    console.log(`Data lagret i: ${COMPANIES_FILE}`);
  } catch (error: any) {
    console.error('Feil i hovedfunksjon:', error);
    process.exit(1);
  }
}

// Kjør hvis kalt direkte
if (require.main === module) {
  main().catch(console.error);
}

export { BrregFetcher };

