import dotenv from 'dotenv';

import { createPostgresClient, getPostgresEnvConfig } from './postgres';
import { fetchRegnskapApiEntries } from './regnskap-api';

dotenv.config();

interface AnnualReportDocument {
  title: string;
  url: string;
  type?: string | null;
  size?: number | null;
}

interface AnnualReportPayload extends Record<string, unknown> {
  source: 'regnskap-api';
  summary?: Record<string, unknown>;
  documents: AnnualReportDocument[];
  raw?: Record<string, unknown>;
}

interface AnnualReport {
  year: number;
  data: AnnualReportPayload;
}

interface RawFinancialStatement {
  year?: number;
  documents?: RawFinancialDocument[];
  [key: string]: unknown;
}

interface RawFinancialDocument {
  title?: string;
  documentType?: string;
  type?: string;
  name?: string;
  url?: string;
  href?: string;
  link?: string;
  downloadUrl?: string;
  size?: number;
  fileSize?: number;
  [key: string]: unknown;
}

const YEAR_REGEX = /^(19|20)\d{2}$/;

// PDF-relaterte funksjoner er fjernet

async function main() {
  const orgArgs = process.argv.slice(2).map((value) => value.replace(/\D+/g, '')).filter(Boolean);
  const postgresConfig = getPostgresEnvConfig();
  const client = createPostgresClient(postgresConfig);

  await client.connect();
  await ensureAnnualReportTable(client);

  const organisasjonsnumre = orgArgs.length ? orgArgs : await fetchOrgNumbers(client);

  console.log(`🔎 Skal skrape årsregnskap for ${organisasjonsnumre.length} enheter`);

  let processed = 0;
  for (const orgnr of organisasjonsnumre) {
    try {
      const reports = await fetchAnnualReports(orgnr);

      if (!reports.length) {
        console.warn(`[${orgnr}] Fant ingen årsregnskap i kildesiden`);
        continue;
      }

      const sorted = reports.sort((a, b) => b.year - a.year);

      for (const report of sorted) {
        await upsertAnnualReport(client, orgnr, report);
      }

      processed += 1;
      console.log(`[${orgnr}] Lagret ${sorted.length} årsrapporter (${processed}/${organisasjonsnumre.length})`);
    } catch (error) {
      console.error(`[${orgnr}] Klarte ikke å hente årsregnskap`, error);
    }
  }

  await client.end();
  console.log('✅ Ferdig med scraping av årsregnskap');
}

async function fetchOrgNumbers(client: ReturnType<typeof createPostgresClient>): Promise<string[]> {
  const result = await client.query<{ organisasjonsnummer: string }>(
    'SELECT organisasjonsnummer FROM brreg_companies ORDER BY organisasjonsnummer ASC LIMIT 10',
  );
  return result.rows.map((row) => row.organisasjonsnummer.replace(/\D+/g, '')).filter(Boolean);
}

async function ensureAnnualReportTable(client: ReturnType<typeof createPostgresClient>) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS brreg_annual_reports (
      organisasjonsnummer TEXT NOT NULL,
      ar INTEGER NOT NULL,
      data JSONB NOT NULL,
      scraped_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (organisasjonsnummer, ar)
    );
  `);
}

async function upsertAnnualReport(
  client: ReturnType<typeof createPostgresClient>,
  orgnr: string,
  report: AnnualReport,
) {
  await client.query(
    `
      INSERT INTO brreg_annual_reports (organisasjonsnummer, ar, data)
      VALUES ($1, $2, $3)
      ON CONFLICT (organisasjonsnummer, ar) DO UPDATE
      SET data = EXCLUDED.data,
          scraped_at = NOW();
    `,
    [orgnr, report.year, report.data],
  );
}

async function fetchAnnualReports(orgnr: string): Promise<AnnualReport[]> {
  const apiReports = await extractFromRegnskapApi(orgnr);
  
  if (apiReports.length) {
    console.log(`[${orgnr}] Fant ${apiReports.length} årsregnskap via Regnskapsregisteret API`);
    return apiReports;
  }

  // Hvis vi ikke fant noe via API, returner tom array
  console.warn(`[${orgnr}] Fant ingen årsregnskap via API`);
  return [];
}

// Alle PDF-relaterte funksjoner er fjernet - vi bruker bare JSON-data fra API-et

async function extractFromRegnskapApi(orgnr: string): Promise<AnnualReport[]> {
  try {
    const entries: Array<{ year: number; documents: Array<Record<string, unknown>>; raw: Record<string, unknown> }> = [];
    const seenYearJournalPairs = new Set<string>(); // Kombinasjon av år og journalnummer for å unngå duplikater
    
    // Importer axios én gang
    const axios = (await import('axios')).default;
    
    // Først prøv å hente alle regnskap uten år-parameter
    console.log(`[${orgnr}] Prøver å hente alle regnskap uten år-parameter...`);
    try {
      const url = `https://data.brreg.no/regnskapsregisteret/regnskap/${orgnr}`;
      const response = await axios.get(url, {
        headers: { Accept: 'application/json' },
        timeout: 15000,
        validateStatus: (status) => status === 200 || status === 404,
      });
      
      if (response.status === 200 && response.data) {
        // Normaliser data til array-format
        const allRegnskap = Array.isArray(response.data) ? response.data : (response.data.regnskap ? response.data.regnskap : [response.data]);
        
        console.log(`[${orgnr}] Fant ${allRegnskap.length} regnskap uten år-parameter`);
        
        // Behandle alle regnskap
        for (const regnskap of allRegnskap) {
          if (!regnskap || typeof regnskap !== 'object') {
            continue;
          }
          
          const regnskapObj = regnskap as Record<string, unknown>;
          
          // Hent faktisk år fra regnskapsperiode
          const periode = regnskapObj.regnskapsperiode as Record<string, unknown> | undefined;
          const tilDato = periode?.tilDato as string | undefined;
          const fraDato = periode?.fraDato as string | undefined;
          
          let actualYear: number | null = null;
          if (tilDato && typeof tilDato === 'string') {
            const yearMatch = tilDato.match(/(\d{4})/);
            if (yearMatch) {
              actualYear = parseInt(yearMatch[1], 10);
            }
          }
          if (!actualYear && fraDato && typeof fraDato === 'string') {
            const yearMatch = fraDato.match(/(\d{4})/);
            if (yearMatch) {
              actualYear = parseInt(yearMatch[1], 10);
            }
          }
          
          if (!actualYear || actualYear < 1990 || actualYear > new Date().getFullYear() + 1) {
            continue;
          }
          
          const journalNr = regnskapObj.journalnr || regnskapObj.journalnummer || regnskapObj.id;
          const duplicateKey = `${actualYear}-${journalNr || 'unknown'}`;
          
          if (seenYearJournalPairs.has(duplicateKey)) {
            continue;
          }
          seenYearJournalPairs.add(duplicateKey);
          
          const documents = (regnskapObj.dokumenter || regnskapObj.documents || []) as Array<Record<string, unknown>>;
          
          entries.push({
            year: actualYear,
            documents: Array.isArray(documents) ? documents : [],
            raw: regnskapObj,
          });
          
          console.log(`[${orgnr}] Fant regnskap for ${actualYear} (journalnr: ${journalNr})`);
        }
      }
    } catch (error) {
      console.log(`[${orgnr}] Kunne ikke hente alle regnskap uten år-parameter, prøver år-for-år...`);
    }
    
    // API-et returnerer ofte bare det nyeste regnskapet uten år-parameter
    // Derfor prøver vi alltid også år-for-år for å sikre at vi får alle tilgjengelige årsregnskap
    // Vi fortsetter selv om vi allerede har noen resultater
    console.log(`[${orgnr}] Prøver også år-for-år-henting for å finne alle tilgjengelige årsregnskap...`);
    
    // Hent alle årsregnskap ved å prøve hvert år systematisk
    const currentYear = new Date().getFullYear();
    const minYear = 1990; // Start fra 1990
    const maxYear = currentYear;
    
    console.log(`[${orgnr}] Henter årsregnskap for år ${minYear}-${maxYear}...`);
    
    // Prøv å hente regnskap for hvert år fra nåtid tilbake til minYear
    // Men start med de siste 10 årene først for å unngå for mange requests
    const yearsToCheck = [];
    for (let year = maxYear; year >= Math.max(minYear, maxYear - 10); year -= 1) {
      yearsToCheck.push(year);
    }
    
    let foundCount = 0;
    for (const year of yearsToCheck) {
      try {
        // Hent regnskap for dette året
        const url = `https://data.brreg.no/regnskapsregisteret/regnskap/${orgnr}?ar=${year}`;
        const response = await axios.get(url, {
          headers: { Accept: 'application/json' },
          timeout: 10000,
          validateStatus: (status) => status === 200 || status === 404, // Aksepter både 200 og 404
        });
        
        if (response.status === 404) {
          // Ingen regnskap for dette året
          continue;
        }
        
        const data = response.data;
        if (!data) {
          continue;
        }
        
        // Normaliser data til array-format
        const candidates = Array.isArray(data) ? data : (data.regnskap ? data.regnskap : [data]);
        
        for (const candidate of candidates) {
          if (!candidate || typeof candidate !== 'object') {
            continue;
          }
          
          const candidateObj = candidate as Record<string, unknown>;
          
          // Hent faktisk år fra regnskapsperiode
          const periode = candidateObj.regnskapsperiode as Record<string, unknown> | undefined;
          const tilDato = periode?.tilDato as string | undefined;
          const fraDato = periode?.fraDato as string | undefined;
          
          let actualYear: number | null = null;
          if (tilDato && typeof tilDato === 'string') {
            const yearMatch = tilDato.match(/(\d{4})/);
            if (yearMatch) {
              actualYear = parseInt(yearMatch[1], 10);
            }
          }
          if (!actualYear && fraDato && typeof fraDato === 'string') {
            const yearMatch = fraDato.match(/(\d{4})/);
            if (yearMatch) {
              actualYear = parseInt(yearMatch[1], 10);
            }
          }
          
          // Hvis vi ikke fant år fra periode, bruk requested year
          if (!actualYear) {
            actualYear = year;
          }
          
          // Hent journalnummer for logging
          const journalNr = candidateObj.journalnr || candidateObj.journalnummer || candidateObj.id;
          
          // Filtrer bort duplikater basert på år + journalnummer
          const duplicateKey = `${actualYear}-${journalNr || 'unknown'}`;
          
          if (seenYearJournalPairs.has(duplicateKey)) {
            // Dette er en eksakt duplikat (samme år + samme journalnummer)
            // Logg at vi hopper over duplikat
            if (actualYear !== year) {
              console.log(`[${orgnr}] Hoppet over duplikat: requested ${year}, fikk ${actualYear} (journalnr: ${journalNr})`);
            }
            continue;
          }
          seenYearJournalPairs.add(duplicateKey);
          
          // Hent dokumenter
          const documents = (candidateObj.dokumenter || candidateObj.documents || []) as Array<Record<string, unknown>>;
          
          entries.push({
            year: actualYear,
            documents: Array.isArray(documents) ? documents : [],
            raw: candidateObj,
          });
          
          foundCount++;
          // Logg hvert funnet regnskap for debugging
          console.log(`[${orgnr}] Fant regnskap for ${actualYear} (journalnr: ${journalNr}, requested year: ${year})`);
        }
      } catch (error) {
        // Ignorer feil for individuelle år, fortsett til neste år
        if (axios.isAxiosError(error)) {
          const status = error.response?.status;
          if (status === 404) {
            continue; // Ingen regnskap for dette året
          }
        }
        // For andre feil, logg men fortsett
        console.warn(`[${orgnr}] Feil ved henting av regnskap for ${year}:`, (error as Error).message);
      }
    }
    
    console.log(`[${orgnr}] Fant totalt ${entries.length} årsregnskap (${foundCount} nye fra år-for-år-henting)`);
    
    if (!entries.length) {
      console.log(`[${orgnr}] Ingen årsregnskap funnet i Regnskapsregisteret API`);
      return [];
    }

    const reports: AnnualReport[] = [];
    const processedYearJournalPairs = new Set<string>();
    
    // Sorter entries etter år (nyeste først)
    entries.sort((a, b) => b.year - a.year);
    
    for (const entry of entries) {
      if (!entry.year) {
        continue;
      }
      
      // Bruk år + journalnummer for å unngå duplikater, men tillat flere regnskap for samme år hvis journalnummer er forskjellig
      const journalNr = entry.raw.journalnr || entry.raw.journalnummer || entry.raw.id;
      const uniqueKey = `${entry.year}-${journalNr || 'unknown'}`;
      
      if (processedYearJournalPairs.has(uniqueKey)) {
        continue; // Skip eksakt duplikat
      }
      processedYearJournalPairs.add(uniqueKey);

      // Logg hva API-et faktisk returnerer
      console.log(`[${orgnr}] API-entry for ${entry.year}:`, {
        hasDocuments: !!entry.documents,
        documentCount: entry.documents?.length || 0,
        hasRaw: !!entry.raw,
        rawKeys: entry.raw ? Object.keys(entry.raw).slice(0, 10) : [],
      });
      
      const rawDocs = mapApiDocumentsToRaw(entry.documents);
      console.log(`[${orgnr}] Mapped ${rawDocs.length} dokumenter fra API for ${entry.year}`);
      
      // Konverter rawDocs til AnnualReportDocument[]
      const documents: AnnualReportDocument[] = rawDocs.map(doc => ({
        title: doc.title || `Årsregnskap ${entry.year}`,
        url: doc.url || `https://data.brreg.no/regnskapsregisteret/regnskap/${orgnr}?ar=${entry.year}`,
        type: doc.type || 'regnskap-json',
        size: doc.size,
      }));
      
      // Hvis vi ikke har dokumenter, lag en standard dokument med API-URL
      if (documents.length === 0) {
        console.log(`[${orgnr}] Lagrer JSON-data fra API for ${entry.year}`);
        documents.push({
          title: `Årsregnskap ${entry.year}`,
          url: `https://data.brreg.no/regnskapsregisteret/regnskap/${orgnr}?ar=${entry.year}`,
          type: 'regnskap-json',
        });
      }

      reports.push({
        year: entry.year,
        data: {
          source: 'regnskap-api',
          summary: entry.raw,
          documents,
          raw: entry.raw,
        },
      });
    }

    if (reports.length > 0) {
      const years = reports.map(r => r.year).join(', ');
      console.log(`[${orgnr}] Fant ${reports.length} årsregnskap via Regnskapsregisteret API (år: ${years})`);
    }

    return dedupeReports(reports);
  } catch (error) {
    console.warn(`[${orgnr}] Feil ved henting fra Regnskapsregisteret API:`, (error as Error).message);
    return [];
  }
}

function mapApiDocumentsToRaw(documents: Array<Record<string, unknown>>): RawFinancialDocument[] {
  const results: RawFinancialDocument[] = [];
  const seen = new Set<string>();

  for (const doc of documents) {
    const flattened = flattenApiDocument(doc);
    for (const candidate of flattened) {
      const url = extractUrlFromDocument(candidate);
      if (!url || seen.has(url)) {
        continue;
      }
      seen.add(url);
      results.push({
        title: extractTitleFromDocument(candidate),
        url,
        type: extractTypeFromDocument(candidate),
        size: extractSizeFromDocument(candidate),
      });
    }
  }

  return results;
}

function flattenApiDocument(doc: Record<string, unknown>): Array<Record<string, unknown>> {
  const flattened: Array<Record<string, unknown>> = [doc];
  const nestedLinkKeys = ['lenker', 'links', 'vedlegg', 'vedleggLenker'];

  for (const key of nestedLinkKeys) {
    const nested = doc[key];
    if (Array.isArray(nested)) {
      for (const link of nested) {
        if (link && typeof link === 'object') {
          flattened.push({ ...doc, ...(link as Record<string, unknown>) });
        }
      }
    }
  }

  return flattened;
}

function extractUrlFromDocument(doc: Record<string, unknown>): string | null {
  const fields = ['downloadUrl', 'url', 'href', 'lenke', 'link', 'adresse'];
  for (const field of fields) {
    const value = doc[field];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function extractTitleFromDocument(doc: Record<string, unknown>): string {
  const fields = ['tittel', 'title', 'navn', 'name', 'dokumentType', 'documentType'];
  for (const field of fields) {
    const value = doc[field];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return 'Innsendt årsregnskap';
}

function extractTypeFromDocument(doc: Record<string, unknown>): string | undefined {
  const fields = ['dokumentType', 'documentType', 'type', 'format'];
  for (const field of fields) {
    const value = doc[field];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function extractSizeFromDocument(doc: Record<string, unknown>): number | undefined {
  const fields = ['storrelse', 'størrelse', 'size', 'filstorrelse', 'fileSize'];
  for (const field of fields) {
    const value = doc[field];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = Number(value.replace(/\D+/g, ''));
      if (!Number.isNaN(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }
  return undefined;
}

function dedupeReports(reports: AnnualReport[]): AnnualReport[] {
  const map = new Map<number, AnnualReport>();
  for (const report of reports) {
    if (!report.year || Number.isNaN(report.year)) {
      continue;
    }
    map.set(report.year, report);
  }
  return Array.from(map.values());
}

main().catch((error) => {
  console.error('Uventet feil under scraping av årsregnskap', error);
  process.exit(1);
});

