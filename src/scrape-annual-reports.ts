import dotenv from 'dotenv';
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';
import pdf from 'pdf-parse';

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

// Temp-mappe for PDF-filer
const PDF_TEMP_DIR = path.join(__dirname, '../temp_pdfs');

// Opprett temp-mappe hvis den ikke eksisterer
if (!fs.existsSync(PDF_TEMP_DIR)) {
  fs.mkdirSync(PDF_TEMP_DIR, { recursive: true });
}

// Hjelpefunksjon for å laste ned og parse PDF
async function downloadAndParsePdf(
  orgnr: string,
  year: number,
  pdfBuffer: Buffer,
  axios: any
): Promise<Record<string, unknown> | null> {
  try {
    // Finn PDF i responsen (samme som Python-koden)
    const pdfStart = pdfBuffer.indexOf('%PDF');
    if (pdfStart === -1) {
      console.warn(`[${orgnr}] Ingen PDF funnet i respons for ${year}`);
    return null;
  }

    // Finn %%EOF marker
    const eofPos = pdfBuffer.lastIndexOf('%%EOF');
    if (eofPos === -1) {
      console.warn(`[${orgnr}] PDF er ufullstendig (ingen %%EOF marker) for ${year}`);
      return null;
    }
    
    // Ekstraher PDF
    const pdfData = pdfBuffer.subarray(pdfStart, eofPos + 6); // +6 for "%%EOF\n"
    
    // Valider at det er en PDF
    if (!pdfData.toString('utf-8', 0, 4).startsWith('%PDF') || pdfData.length < 1000) {
      console.warn(`[${orgnr}] Ugyldig PDF-data for ${year}`);
      return null;
    }
    
    // Lagre PDF til temp-fil
    const tempPdfPath = path.join(PDF_TEMP_DIR, `${orgnr}_${year}.pdf`);
    fs.writeFileSync(tempPdfPath, pdfData);
    
    try {
      // Parse PDF
      const pdfDoc = await pdf(pdfData);
      const pdfText = pdfDoc.text;
      
      // Prøv å finne JSON-data i PDF-teksten
      // PDF-er kan inneholde JSON-data som tekst
      const jsonMatches = pdfText.match(/\{[\s\S]{100,100000}?"(?:regnskap|journalnr|regnskapsperiode)"[\s\S]{100,100000}?\}/g);
      if (jsonMatches && jsonMatches.length > 0) {
        for (const jsonStr of jsonMatches) {
          try {
            const jsonData = JSON.parse(jsonStr);
            if (jsonData && typeof jsonData === 'object' && (jsonData.journalnr || jsonData.regnskapsperiode)) {
              // Slett temp-fil
              fs.unlinkSync(tempPdfPath);
              return jsonData as Record<string, unknown>;
            }
          } catch (e) {
            // Ignorer JSON-parse-feil
          }
        }
      }
      
      // Prøv å finne journalnummer i PDF-teksten
      // Format kan være: "journalnr": "1234567890" eller journalnr: 1234567890
      const journalNrMatch = pdfText.match(/journalnr[":\s]+(\d{10})/i);
      const journalNr = journalNrMatch ? journalNrMatch[1] : null;
      
      // Slett temp-fil
      fs.unlinkSync(tempPdfPath);
      
      // Prøv å hente via API med journalnummer hvis vi fant det
      if (journalNr) {
        try {
          const apiUrl = `https://data.brreg.no/regnskapsregisteret/regnskap/${orgnr}?journalnr=${journalNr}`;
          const apiResponse = await axios.get(apiUrl, {
            headers: { Accept: 'application/json' },
            timeout: 10000,
            validateStatus: (status: number) => status === 200 || status === 404,
          });
          
          if (apiResponse.status === 200 && apiResponse.data) {
            const data = Array.isArray(apiResponse.data) ? apiResponse.data[0] : apiResponse.data;
            if (data && typeof data === 'object') {
              // Sjekk om faktisk år matcher
              const periode = data.regnskapsperiode as Record<string, unknown> | undefined;
              const tilDato = periode?.tilDato as string | undefined;
              if (tilDato && typeof tilDato === 'string') {
                const yearMatch = tilDato.match(/(\d{4})/);
                if (yearMatch && parseInt(yearMatch[1], 10) === year) {
                  return data as Record<string, unknown>;
                }
              }
              // Hvis år ikke matcher, returner data uansett (kan være at PDF-en er for et annet år)
              return data as Record<string, unknown>;
            }
          }
        } catch (apiError) {
          // Ignorer feil
        }
      }
      
      // Fallback: Prøv å hente via API (uten journalnummer, bare med år)
      const apiUrl = `https://data.brreg.no/regnskapsregisteret/regnskap/${orgnr}?ar=${year}`;
      const apiResponse = await axios.get(apiUrl, {
        headers: { Accept: 'application/json' },
        timeout: 10000,
        validateStatus: (status: number) => status === 200 || status === 404,
      });
      
      if (apiResponse.status === 200 && apiResponse.data) {
        const data = Array.isArray(apiResponse.data) ? apiResponse.data[0] : apiResponse.data;
        if (data && typeof data === 'object') {
          // Sjekk om faktisk år matcher
          const periode = data.regnskapsperiode as Record<string, unknown> | undefined;
          const tilDato = periode?.tilDato as string | undefined;
          if (tilDato && typeof tilDato === 'string') {
            const yearMatch = tilDato.match(/(\d{4})/);
            if (yearMatch && parseInt(yearMatch[1], 10) === year) {
              return data as Record<string, unknown>;
            }
          }
        }
      }
      
      return null;
    } catch (parseError) {
      // Slett temp-fil hvis parsing feiler
      if (fs.existsSync(tempPdfPath)) {
        fs.unlinkSync(tempPdfPath);
      }
      throw parseError;
    }
  } catch (error) {
    console.warn(`[${orgnr}] Feil ved PDF-download/parsing for ${year}:`, (error as Error).message);
    return null;
  }
}

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
  
  // Rydd opp temp PDF-filer
  try {
    if (fs.existsSync(PDF_TEMP_DIR)) {
      const files = fs.readdirSync(PDF_TEMP_DIR);
      for (const file of files) {
        const filePath = path.join(PDF_TEMP_DIR, file);
        try {
          fs.unlinkSync(filePath);
        } catch (e) {
          // Ignorer feil ved sletting
        }
      }
      try {
        fs.rmdirSync(PDF_TEMP_DIR);
      } catch (e) {
        // Ignorer feil hvis mappen ikke er tom
      }
    }
  } catch (cleanupError) {
    console.warn('Feil ved opprydding av temp PDF-filer:', (cleanupError as Error).message);
  }
  
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

// Hent årsregnskap fra nettsiden ved å parse HTML og finne JSON-data
async function extractFromWebsite(orgnr: string, axios: any): Promise<Array<{ year: number; documents: Array<Record<string, unknown>>; raw: Record<string, unknown> }>> {
  const entries: Array<{ year: number; documents: Array<Record<string, unknown>>; raw: Record<string, unknown> }> = [];
  
  try {
    // Bruk samme URL som Python-koden
    const url = `https://virksomhet.brreg.no/nb/oppslag/enheter/${orgnr}`;
    
    console.log(`[${orgnr}] Henter HTML fra ${url}...`);
    
    const response = await axios.get(url, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      timeout: 15000,
      validateStatus: (status: number) => status === 200 || status === 404,
    });
    
    if (response.status === 404) {
      console.log(`[${orgnr}] Nettside ikke funnet (404)`);
      return entries;
    }
    
    const html = response.data;
    if (!html || typeof html !== 'string') {
      console.log(`[${orgnr}] Ingen HTML-data mottatt`);
      return entries;
    }
    
    // Finn regnskapsAarResponse i HTML-en (samme som Python-koden)
    const regnskapsAarIdx = html.indexOf('regnskapsAarResponse');
    if (regnskapsAarIdx === -1) {
      console.log(`[${orgnr}] Fant ikke regnskapsAarResponse i HTML`);
      // Fallback til API-metoden
      return await extractYearsFromApiFallback(orgnr, axios);
    }
    
    // Ekstraher en større chunk med data for å finne både år og journalnummer
    const snippet = html.substring(regnskapsAarIdx, regnskapsAarIdx + 50000);
    
    // Prøv å parse regnskapsAarResponse som JSON først
    // Format kan være: regnskapsAarResponse = {...} eller "regnskapsAarResponse":{...}
    let regnskapsAarData: Record<string, unknown> | null = null;
    try {
      // Prøv å finne JSON-objektet
      const jsonMatch = snippet.match(/regnskapsAarResponse[^=]*=\s*({[\s\S]+?});/);
      if (jsonMatch) {
        regnskapsAarData = JSON.parse(jsonMatch[1]);
      } else {
        // Prøv annen format: "regnskapsAarResponse":{...}
        const jsonMatch2 = snippet.match(/"regnskapsAarResponse"\s*:\s*({[\s\S]+?})(?:,|\s*})/);
        if (jsonMatch2) {
          regnskapsAarData = JSON.parse(jsonMatch2[1]);
        }
      }
    } catch (e) {
      // Ignorer JSON-parse-feil
    }
    
    // Hvis vi fant JSON-data, prøv å hente regnskap derfra
    if (regnskapsAarData) {
      const regnskap = findRegnskapInData(regnskapsAarData, orgnr);
      if (regnskap && regnskap.length > 0) {
        for (const rs of regnskap) {
          const periode = rs.regnskapsperiode as Record<string, unknown> | undefined;
          const tilDato = periode?.tilDato as string | undefined;
          let year: number | null = null;
          if (tilDato && typeof tilDato === 'string') {
            const yearMatch = tilDato.match(/(\d{4})/);
            if (yearMatch) {
              year = parseInt(yearMatch[1], 10);
            }
          }
          if (year) {
            const documents = (rs.dokumenter || rs.documents || []) as Array<Record<string, unknown>>;
            entries.push({
              year,
              documents: Array.isArray(documents) ? documents : [],
              raw: rs,
            });
            console.log(`[${orgnr}] Fant regnskap for ${year} fra regnskapsAarResponse JSON (journalnr: ${rs.journalnr || rs.journalnummer || rs.id})`);
          }
        }
      }
    }
    
    // Finn alle år i snippet (pattern: year...YYYY)
    const yearPattern = /year.{1,10}?(\d{4})/g;
    const matches = snippet.matchAll(yearPattern);
    const foundYears: number[] = [];
    
    for (const match of matches) {
      const year = parseInt(match[1], 10);
      if (year >= 1990 && year <= new Date().getFullYear() + 1) {
        foundYears.push(year);
      }
    }
    
    // Fjern duplikater og sorter
    const uniqueYears = [...new Set(foundYears)].sort((a, b) => b - a);
    
    // Prøv å finne journalnummer for hvert år fra HTML-en
    // Pattern: year...YYYY...journalnr...NNNNNNNNN eller journalnr...NNNNNNNNN...year...YYYY
    const yearJournalMap = new Map<number, string>();
    for (const year of uniqueYears) {
      // Prøv flere patterns for å finne journalnummer knyttet til år
      const patterns = [
        new RegExp(`"year":${year}[^}]*?"journalnr":(\\d{10})`, 'g'),
        new RegExp(`"journalnr":(\\d{10})[^}]*?"year":${year}`, 'g'),
        new RegExp(`year[^}]*?${year}[^}]*?journalnr[^}]*?(\\d{10})`, 'g'),
        new RegExp(`journalnr[^}]*?(\\d{10})[^}]*?year[^}]*?${year}`, 'g'),
      ];
      
      for (const pattern of patterns) {
        const journalMatches = snippet.matchAll(pattern);
        for (const journalMatch of journalMatches) {
          const journalNr = journalMatch[1];
          if (journalNr && !yearJournalMap.has(year)) {
            yearJournalMap.set(year, journalNr);
            console.log(`[${orgnr}] Fant journalnummer ${journalNr} for år ${year} fra HTML`);
            break;
          }
        }
        if (yearJournalMap.has(year)) break;
      }
    }
    
    if (uniqueYears.length === 0) {
      console.log(`[${orgnr}] Fant ingen år i regnskapsAarResponse`);
      return await extractYearsFromApiFallback(orgnr, axios);
    }
    
    console.log(`[${orgnr}] Fant ${uniqueYears.length} tilgjengelige år fra nettsiden: ${uniqueYears.join(', ')}`);
    
    // Bruk Next.js Server Actions for å hente regnskap-data (samme som Python-koden)
    // Next.js Server Action ID for PDF download (samme som Python-koden)
    // Merk: Dette returnerer PDF-data, men vi prøver å få JSON-data via API i stedet
    const nextActionId = "7fe7b594d072ac1557da402414c7b7b1f94a43fe62";
    const baseUrl = `https://virksomhet.brreg.no/nb/oppslag/enheter/${orgnr}`;
    
    console.log(`[${orgnr}] Prøver å hente regnskap via Next.js Server Actions (samme som Python-koden)...`);
    
    // Prøv å hente regnskap for hvert år via Next.js Server Actions
    // Python-koden bruker POST med body: ["{orgnr}","{year}"]
    // Men siden vi trenger JSON-data, ikke PDFs, prøver vi å hente via API i stedet
    // Men først prøver vi å se om vi kan få JSON-data fra Server Action-responsen
    
    for (const year of uniqueYears) {
      // Hopp over hvis vi allerede har regnskap for dette året
      if (entries.some(e => e.year === year)) {
        continue;
      }
      
      try {
        // Prøv først å hente via Next.js Server Action (samme som Python-koden)
        // Men vi prøver å få JSON-data, ikke PDF-data
        const serverActionHeaders = {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/x-component, */*',
          'Accept-Encoding': 'gzip, deflate, br',
          'Accept-Language': 'nb-NO,nb;q=0.9,no;q=0.8,en;q=0.7',
          'Referer': baseUrl,
          'Next-Action': nextActionId,
          'Content-Type': 'text/plain;charset=UTF-8',
          'Origin': 'https://virksomhet.brreg.no',
        };
        
        const body = JSON.stringify([orgnr, year.toString()]);
        
        try {
          const serverActionResponse = await axios.post(baseUrl, body, {
            headers: serverActionHeaders,
            timeout: 120000,
            validateStatus: (status: number) => status === 200 || status === 404 || status === 400,
            responseType: 'arraybuffer', // For å kunne lese både JSON og PDF
          });
          
          if (serverActionResponse.status === 200) {
            const responseData = Buffer.from(serverActionResponse.data);
            
            // Prøv å parse som JSON først
            try {
              const responseText = responseData.toString('utf-8');
              const jsonData = JSON.parse(responseText);
              if (jsonData && typeof jsonData === 'object') {
                // Hvis det er JSON-data, bruk det
                const periode = jsonData.regnskapsperiode as Record<string, unknown> | undefined;
                const tilDato = periode?.tilDato as string | undefined;
                let actualYear: number | null = null;
                if (tilDato && typeof tilDato === 'string') {
                  const yearMatch = tilDato.match(/(\d{4})/);
                  if (yearMatch) {
                    actualYear = parseInt(yearMatch[1], 10);
                  }
                }
                if (!actualYear) {
                  actualYear = year;
                }
                
                const documents = (jsonData.dokumenter || jsonData.documents || []) as Array<Record<string, unknown>>;
                entries.push({
                  year: actualYear,
                  documents: Array.isArray(documents) ? documents : [],
                  raw: jsonData as Record<string, unknown>,
                });
                console.log(`[${orgnr}] Fant regnskap for ${actualYear} via Next.js Server Action (JSON) (journalnr: ${jsonData.journalnr || jsonData.journalnummer || jsonData.id})`);
                continue; // Hopp til neste år
              }
            } catch (jsonError) {
              // Ikke JSON, sannsynligvis PDF-data - last ned og parse PDF
              try {
                console.log(`[${orgnr}] Laster ned PDF for ${year}...`);
                const pdfData = await downloadAndParsePdf(orgnr, year, responseData, axios);
                if (pdfData) {
                  entries.push({
                    year,
                    documents: [],
                    raw: pdfData,
                  });
                  console.log(`[${orgnr}] Fant regnskap for ${year} via PDF-parsing (journalnr: ${pdfData.journalnr || pdfData.journalnummer || pdfData.id})`);
                  continue; // Hopp til neste år
                }
              } catch (pdfError) {
                console.warn(`[${orgnr}] Feil ved PDF-parsing for ${year}:`, (pdfError as Error).message);
              }
            }
          }
        } catch (serverActionError) {
          // Ignorer feil, prøv API-metoden i stedet
        }
        
        // Fallback: Prøv å hente via det offentlige API-et med journalnummer
        // Hvis vi har journalnummer fra HTML-en, bruk det
        if (yearJournalMap.has(year)) {
          const journalNr = yearJournalMap.get(year);
          if (journalNr) {
            try {
              const apiUrl = `https://data.brreg.no/regnskapsregisteret/regnskap/${orgnr}?journalnr=${journalNr}`;
              const apiResponse = await axios.get(apiUrl, {
                headers: { Accept: 'application/json' },
                timeout: 10000,
                validateStatus: (status: number) => status === 200 || status === 404,
              });
              
              if (apiResponse.status === 200 && apiResponse.data) {
                const data = Array.isArray(apiResponse.data) ? apiResponse.data[0] : apiResponse.data;
                if (data && typeof data === 'object') {
                  const documents = (data.dokumenter || data.documents || []) as Array<Record<string, unknown>>;
                  entries.push({
                    year,
                    documents: Array.isArray(documents) ? documents : [],
                    raw: data as Record<string, unknown>,
                  });
                  console.log(`[${orgnr}] Fant regnskap for ${year} via journalnummer ${journalNr}`);
                  continue; // Hopp til neste år
                }
              }
            } catch (apiError) {
              // Ignorer feil
            }
          }
        }
        
        console.log(`[${orgnr}] Kunne ikke hente regnskap for ${year}`);
        
      } catch (error) {
        // Ignorer feil for individuelle år
        console.warn(`[${orgnr}] Feil ved henting av regnskap for ${year}:`, (error as Error).message);
      }
    }
    
    // Prøv å hente regnskap via journalnummer hvis vi fant dem (fallback)
    if (yearJournalMap.size > 0) {
      console.log(`[${orgnr}] Fant ${yearJournalMap.size} journalnummer i HTML, prøver å hente regnskap via journalnummer...`);
      
      for (const [year, journalNr] of yearJournalMap.entries()) {
        // Hopp over hvis vi allerede har regnskap for dette året
        if (entries.some(e => e.year === year)) {
          continue;
        }

        try {
          // Prøv å hente regnskap via journalnummer
          const apiUrl = `https://data.brreg.no/regnskapsregisteret/regnskap/${orgnr}?journalnr=${journalNr}`;
          const apiResponse = await axios.get(apiUrl, {
            headers: { Accept: 'application/json' },
            timeout: 10000,
            validateStatus: (status: number) => status === 200 || status === 404,
          });
          
          if (apiResponse.status === 200 && apiResponse.data) {
            const data = Array.isArray(apiResponse.data) ? apiResponse.data[0] : apiResponse.data;
            if (data && typeof data === 'object') {
              const documents = (data.dokumenter || data.documents || []) as Array<Record<string, unknown>>;
              entries.push({
                year,
                documents: Array.isArray(documents) ? documents : [],
                raw: data as Record<string, unknown>,
              });
              console.log(`[${orgnr}] Fant regnskap for ${year} via journalnummer ${journalNr}`);
            }
          }
        } catch (error) {
          console.warn(`[${orgnr}] Feil ved henting av regnskap for ${year} via journalnummer:`, (error as Error).message);
        }
      }
    }
    
    // Prøv å finne faktiske regnskap-data i HTML-en
    // Next.js embedder ofte data i __NEXT_DATA__ script tag
    const $ = cheerio.load(html);
    const scriptTags = $('script').toArray();
    const seenJournalNumbers = new Set<string | number>();
    
    // Først prøv å finne __NEXT_DATA__
    for (const script of scriptTags) {
      const content = $(script).html() || '';
      
      // Prøv å finne __NEXT_DATA__ som ofte inneholder alle data
      if (content.includes('__NEXT_DATA__')) {
        try {
          // Extract JSON from __NEXT_DATA__ = {...}
          const nextDataMatch = content.match(/__NEXT_DATA__\s*=\s*({[\s\S]+?});/);
          if (nextDataMatch) {
            const nextData = JSON.parse(nextDataMatch[1]);
            
            // Søk i pageProps for regnskap-data
            if (nextData.props && nextData.props.pageProps) {
              const pageProps = nextData.props.pageProps as Record<string, unknown>;
              
              // Prøv å finne regnskap i pageProps
              const regnskap = findRegnskapInData(pageProps, orgnr);
              if (regnskap && regnskap.length > 0) {
                for (const rs of regnskap) {
                  const periode = rs.regnskapsperiode as Record<string, unknown> | undefined;
                  const tilDato = periode?.tilDato as string | undefined;
                  let year: number | null = null;
                  if (tilDato && typeof tilDato === 'string') {
                    const yearMatch = tilDato.match(/(\d{4})/);
          if (yearMatch) {
                      year = parseInt(yearMatch[1], 10);
                    }
                  }
                  if (year && uniqueYears.includes(year)) {
                    const journalNr = rs.journalnr || rs.journalnummer || rs.id;
                    if (journalNr && (typeof journalNr === 'string' || typeof journalNr === 'number') && seenJournalNumbers.has(journalNr)) {
                      continue; // Skip duplikat
                    }
                    if (journalNr && (typeof journalNr === 'string' || typeof journalNr === 'number')) {
                      seenJournalNumbers.add(journalNr);
                    }
                    const documents = (rs.dokumenter || rs.documents || []) as Array<Record<string, unknown>>;
                    entries.push({
                      year,
                      documents: Array.isArray(documents) ? documents : [],
                      raw: rs,
                    });
                    console.log(`[${orgnr}] Fant regnskap for ${year} fra __NEXT_DATA__ (journalnr: ${journalNr})`);
                  }
                }
              }
            }
          }
        } catch (e) {
          // Ignorer JSON-parse-feil
        }
      }
      
      // Prøv også å finne JSON-data som inneholder regnskap direkte
      if (content.includes('regnskap') || content.includes('aarsregnskap') || content.includes('årsregnskap')) {
        try {
          // Prøv å ekstrahere JSON-objekt - søk etter større JSON-strukturer
          // Bruk en mer permisiv pattern som kan fange opp nested JSON
          const jsonPattern = /\{[\s\S]{100,100000}?"(?:regnskap|aarsregnskap)"[\s\S]{100,100000}?\}/g;
          const jsonMatches = content.match(jsonPattern);
          if (jsonMatches) {
            for (const jsonStr of jsonMatches) {
              try {
                const data = JSON.parse(jsonStr);
                const regnskap = findRegnskapInData(data, orgnr);
                if (regnskap && regnskap.length > 0) {
                  for (const rs of regnskap) {
                    const periode = rs.regnskapsperiode as Record<string, unknown> | undefined;
                    const tilDato = periode?.tilDato as string | undefined;
                    let year: number | null = null;
                    if (tilDato && typeof tilDato === 'string') {
                      const yearMatch = tilDato.match(/(\d{4})/);
            if (yearMatch) {
                        year = parseInt(yearMatch[1], 10);
                      }
                    }
                    if (year && uniqueYears.includes(year)) {
                      const journalNr = rs.journalnr || rs.journalnummer || rs.id;
                      if (journalNr && (typeof journalNr === 'string' || typeof journalNr === 'number') && seenJournalNumbers.has(journalNr)) {
                        continue; // Skip duplikat
                      }
                      if (journalNr && (typeof journalNr === 'string' || typeof journalNr === 'number')) {
                        seenJournalNumbers.add(journalNr);
                      }
                      const documents = (rs.dokumenter || rs.documents || []) as Array<Record<string, unknown>>;
                      entries.push({
                        year,
                        documents: Array.isArray(documents) ? documents : [],
                        raw: rs,
                      });
                      console.log(`[${orgnr}] Fant regnskap for ${year} fra HTML JSON (journalnr: ${journalNr})`);
                    }
                  }
                }
              } catch (e) {
                // Ignorer JSON-parse-feil
              }
            }
          }
        } catch (e) {
          // Ignorer feil
        }
      }
    }
    
    // Hvis vi ikke fant regnskap i HTML, prøv å hente via API for hvert år
    // Men siden API-et returnerer samme regnskap for alle år, lagrer vi bare én per unikt journalnummer
    // Fyll opp seenJournalNumbers med de vi allerede har funnet fra HTML
    for (const entry of entries) {
      const journalNr = entry.raw.journalnr || entry.raw.journalnummer || entry.raw.id;
      if (journalNr && (typeof journalNr === 'string' || typeof journalNr === 'number')) {
        seenJournalNumbers.add(journalNr);
      }
    }
    
    // Prøv bare for år vi ikke allerede har
    const yearsToFetch = uniqueYears.filter(year => !entries.some(e => e.year === year));
    
    if (yearsToFetch.length > 0) {
      console.log(`[${orgnr}] Prøver å hente ${yearsToFetch.length} manglende år via API...`);
    }
    
    for (const year of yearsToFetch) {
      
      try {
        const apiUrl = `https://data.brreg.no/regnskapsregisteret/regnskap/${orgnr}?ar=${year}`;
        const apiResponse = await axios.get(apiUrl, {
          headers: { Accept: 'application/json' },
          timeout: 10000,
          validateStatus: (status: number) => status === 200 || status === 404,
        });
        
        if (apiResponse.status === 404) {
          continue; // Ingen regnskap for dette året
        }
        
        const data = apiResponse.data;
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
          const journalNr = candidateObj.journalnr || candidateObj.journalnummer || candidateObj.id;
          
          // Hvis vi allerede har sett dette journalnummeret, hopp over
          if (journalNr && (typeof journalNr === 'string' || typeof journalNr === 'number') && seenJournalNumbers.has(journalNr)) {
            continue;
          }
          
          // Hent faktisk år fra regnskapsperiode
          const periode = candidateObj.regnskapsperiode as Record<string, unknown> | undefined;
          const tilDato = periode?.tilDato as string | undefined;
          
          let actualYear: number | null = null;
          if (tilDato && typeof tilDato === 'string') {
            const yearMatch = tilDato.match(/(\d{4})/);
            if (yearMatch) {
              actualYear = parseInt(yearMatch[1], 10);
            }
          }
          
          if (!actualYear) {
            actualYear = year;
          }
          
          // Hvis faktisk år ikke er i listen over tilgjengelige år, hopp over
          if (!uniqueYears.includes(actualYear)) {
            continue;
          }
          
          // Hent dokumenter
          const documents = (candidateObj.dokumenter || candidateObj.documents || []) as Array<Record<string, unknown>>;
          
          entries.push({
            year: actualYear,
            documents: Array.isArray(documents) ? documents : [],
            raw: candidateObj,
          });
          
          if (journalNr && (typeof journalNr === 'string' || typeof journalNr === 'number')) {
            seenJournalNumbers.add(journalNr);
          }
          
          console.log(`[${orgnr}] Fant regnskap for ${actualYear} fra API (journalnr: ${journalNr})`);
        }
      } catch (error) {
        // Ignorer feil for individuelle år
        console.warn(`[${orgnr}] Feil ved henting av regnskap for ${year}:`, (error as Error).message);
      }
    }
    
    return entries;
  } catch (error) {
    console.warn(`[${orgnr}] Feil ved henting fra nettsiden:`, (error as Error).message);
    // Fallback til API-metoden
    return await extractYearsFromApiFallback(orgnr, axios);
  }
}

// Hjelpefunksjon for å finne regnskap i JSON-struktur
function findRegnskapInData(data: unknown, orgnr: string): Array<Record<string, unknown>> {
  const results: Array<Record<string, unknown>> = [];
  
  if (!data || typeof data !== 'object') {
    return results;
  }
  
  const obj = data as Record<string, unknown>;
  
  // Søk etter regnskap-felter
  if (obj.regnskap && Array.isArray(obj.regnskap)) {
    return obj.regnskap.filter((r): r is Record<string, unknown> => 
      typeof r === 'object' && r !== null
    );
  }
  
  if (obj.aarsregnskap && Array.isArray(obj.aarsregnskap)) {
    return obj.aarsregnskap.filter((r): r is Record<string, unknown> => 
      typeof r === 'object' && r !== null
    );
  }
  
  // Rekursivt søk i nested objekter
  for (const key in obj) {
    if (key.toLowerCase().includes('regnskap') || key.toLowerCase().includes('aarsregnskap')) {
      const value = obj[key];
      if (Array.isArray(value)) {
        return value.filter((r): r is Record<string, unknown> => 
          typeof r === 'object' && r !== null
        );
      }
    }
    if (typeof obj[key] === 'object' && obj[key] !== null) {
      const nested = findRegnskapInData(obj[key], orgnr);
      if (nested.length > 0) {
        results.push(...nested);
      }
    }
  }
  
  return results;
}

// Fallback: Hent år fra API (samme som Python-koden)
async function extractYearsFromApiFallback(orgnr: string, axios: any): Promise<Array<{ year: number; documents: Array<Record<string, unknown>>; raw: Record<string, unknown> }>> {
  const entries: Array<{ year: number; documents: Array<Record<string, unknown>>; raw: Record<string, unknown> }> = [];
  
  try {
    const url = `https://data.brreg.no/regnskapsregisteret/regnskap/${orgnr}`;
    const response = await axios.get(url, {
      headers: { Accept: 'application/json' },
      timeout: 10000,
    });
    
    if (response.status === 200 && response.data) {
      const data = Array.isArray(response.data) ? response.data : [response.data];
      
      for (const item of data) {
        if (!item || typeof item !== 'object') {
          continue;
        }
        
        const period = (item as Record<string, unknown>).regnskapsperiode as Record<string, unknown> | undefined;
        const tilDato = period?.tilDato as string | undefined;
        
        if (tilDato && typeof tilDato === 'string') {
          const yearMatch = tilDato.match(/(\d{4})/);
          if (yearMatch) {
            const year = parseInt(yearMatch[1], 10);
            const documents = ((item as Record<string, unknown>).dokumenter || (item as Record<string, unknown>).documents || []) as Array<Record<string, unknown>>;
            
            entries.push({
              year,
              documents: Array.isArray(documents) ? documents : [],
              raw: item as Record<string, unknown>,
            });
          }
        }
      }
    }
  } catch (error) {
    // Ignorer feil
  }
  
  return entries;
}


// Alle PDF-relaterte funksjoner er fjernet - vi bruker bare JSON-data fra API-et

async function extractFromRegnskapApi(orgnr: string): Promise<AnnualReport[]> {
  try {
    const entries: Array<{ year: number; documents: Array<Record<string, unknown>>; raw: Record<string, unknown> }> = [];
    const seenYearJournalPairs = new Set<string>(); // Kombinasjon av år og journalnummer for å unngå duplikater
    
    // Importer axios én gang
    const axios = (await import('axios')).default;
    
    // Først prøv å hente data fra nettsiden (kan ha flere årsregnskap)
    console.log(`[${orgnr}] Prøver å hente årsregnskap fra nettsiden...`);
    try {
      const websiteEntries = await extractFromWebsite(orgnr, axios);
      for (const entry of websiteEntries) {
        const journalNr = entry.raw.journalnr || entry.raw.journalnummer || entry.raw.id;
        const duplicateKey = `${entry.year}-${journalNr || 'unknown'}`;
        if (!seenYearJournalPairs.has(duplicateKey)) {
          seenYearJournalPairs.add(duplicateKey);
          entries.push(entry);
          console.log(`[${orgnr}] Fant regnskap for ${entry.year} fra nettsiden (journalnr: ${journalNr})`);
        }
      }
      if (websiteEntries.length > 0) {
        console.log(`[${orgnr}] Fant ${websiteEntries.length} årsregnskap fra nettsiden`);
      }
    } catch (error) {
      console.log(`[${orgnr}] Kunne ikke hente fra nettsiden:`, (error as Error).message);
    }
    
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
        // Logg hele strukturen for å se om det finnes lenker eller metadata
        console.log(`[${orgnr}] API-respons struktur:`, {
          isArray: Array.isArray(response.data),
          hasRegnskap: !!(response.data as Record<string, unknown>).regnskap,
          hasLinks: !!(response.data as Record<string, unknown>)._links,
          hasEmbedded: !!(response.data as Record<string, unknown>)._embedded,
          topLevelKeys: typeof response.data === 'object' && response.data !== null ? Object.keys(response.data as Record<string, unknown>).slice(0, 20) : [],
        });
        
        // Normaliser data til array-format
        const allRegnskap = Array.isArray(response.data) ? response.data : (response.data.regnskap ? response.data.regnskap : [response.data]);
        
        console.log(`[${orgnr}] Fant ${allRegnskap.length} regnskap uten år-parameter`);
        
        // Behandle alle regnskap
        for (const regnskap of allRegnskap) {
          if (!regnskap || typeof regnskap !== 'object') {
          continue;
        }

          const regnskapObj = regnskap as Record<string, unknown>;
          
          // Logg strukturen av første regnskap for debugging
          if (entries.length === 0) {
            console.log(`[${orgnr}] Første regnskap struktur:`, {
              keys: Object.keys(regnskapObj).slice(0, 30),
              hasLinks: !!(regnskapObj._links || regnskapObj.links),
              hasVirksomhet: !!regnskapObj.virksomhet,
              virksomhetKeys: regnskapObj.virksomhet && typeof regnskapObj.virksomhet === 'object' ? Object.keys(regnskapObj.virksomhet as Record<string, unknown>).slice(0, 20) : [],
            });
          }
          
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

