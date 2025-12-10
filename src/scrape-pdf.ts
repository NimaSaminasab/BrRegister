import * as fs from 'fs';
import * as path from 'path';
import pdf from 'pdf-parse';
import axios from 'axios';
import { createPostgresClient, getPostgresEnvConfig } from './postgres';

// Temp-mappe for PDF-filer
const PDF_TEMP_DIR = path.join(__dirname, '../temp_pdfs');

// Opprett temp-mappe hvis den ikke eksisterer
if (!fs.existsSync(PDF_TEMP_DIR)) {
  fs.mkdirSync(PDF_TEMP_DIR, { recursive: true });
}

/**
 * Scraper PDF for et spesifikt organisasjonsnummer og år, og ekstrakterer årsresultat
 */
export async function scrapePdfForYear(
  orgnr: string,
  year: number
): Promise<{ aarsresultat: number | null; success: boolean; message: string }> {
  try {
    // Hent PDF via Next.js Server Action (samme som i scrape-annual-reports.ts)
    const nextActionId = "7fe7b594d072ac1557da402414c7b7b1f94a43fe62";
    const baseUrl = `https://virksomhet.brreg.no/nb/oppslag/enheter/${orgnr}`;
    
    console.log(`[${orgnr}] Scraper PDF for ${year}...`);
    
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
    
    const serverActionResponse = await axios.post(baseUrl, body, {
      headers: serverActionHeaders,
      timeout: 120000,
      validateStatus: (status: number) => status === 200 || status === 404 || status === 400 || status === 500,
      responseType: 'arraybuffer',
    });
    
    if (serverActionResponse.status !== 200) {
      const errorText = Buffer.from(serverActionResponse.data).toString('utf-8').substring(0, 200);
      return {
        aarsresultat: null,
        success: false,
        message: `Server returnerte status ${serverActionResponse.status}: ${errorText}`,
      };
    }
    
    const responseData = Buffer.from(serverActionResponse.data);
    
    // Prøv å parse som JSON først
    try {
      const responseText = responseData.toString('utf-8');
      const jsonData = JSON.parse(responseText);
      if (jsonData && typeof jsonData === 'object') {
        // Hvis det er JSON-data, hent årsresultat fra den
        const aarsresultat = extractAarsresultatFromJson(jsonData);
        if (aarsresultat !== null) {
          return {
            aarsresultat,
            success: true,
            message: `Fant årsresultat ${aarsresultat} i JSON-data`,
          };
        }
      }
    } catch (jsonError) {
      // Ikke JSON, sannsynligvis PDF-data - fortsett til PDF-parsing
    }
    
    // Parse PDF
    const pdfResult = await parsePdfAndExtractAarsresultat(orgnr, year, responseData);
    
    if (pdfResult.aarsresultat !== null) {
      // Oppdater database med det ekstraherte årsresultatet
      await updateAnnualReportInDatabase(orgnr, year, pdfResult.aarsresultat);
      
      return {
        aarsresultat: pdfResult.aarsresultat,
        success: true,
        message: `Fant årsresultat ${pdfResult.aarsresultat} i PDF`,
      };
    }
    
    return {
      aarsresultat: null,
      success: false,
      message: pdfResult.message || 'Kunne ikke ekstraktere årsresultat fra PDF',
    };
  } catch (error) {
    console.error(`[${orgnr}] Feil ved scraping av PDF for ${year}:`, (error as Error).message);
    return {
      aarsresultat: null,
      success: false,
      message: (error as Error).message,
    };
  }
}

/**
 * Parser PDF og ekstrakterer årsresultat
 */
async function parsePdfAndExtractAarsresultat(
  orgnr: string,
  year: number,
  pdfBuffer: Buffer
): Promise<{ aarsresultat: number | null; message: string }> {
  try {
    // Sjekk om responsen inneholder feilmelding
    const responseText = pdfBuffer.toString('utf-8', 0, Math.min(500, pdfBuffer.length));
    if (responseText.includes('Server action not found') || responseText.includes('error') || responseText.includes('Error')) {
      return {
        aarsresultat: null,
        message: `Server Action returnerte feilmelding: ${responseText.substring(0, 100)}`,
      };
    }
    
    // Finn PDF i responsen
    const pdfStart = pdfBuffer.indexOf('%PDF');
    if (pdfStart === -1) {
      return {
        aarsresultat: null,
        message: 'Ingen PDF funnet i respons',
      };
    }
    
    // Finn %%EOF marker
    const eofPos = pdfBuffer.lastIndexOf('%%EOF');
    if (eofPos === -1) {
      return {
        aarsresultat: null,
        message: 'PDF er ufullstendig (ingen %%EOF marker)',
      };
    }
    
    // Ekstraher PDF
    const pdfData = pdfBuffer.subarray(pdfStart, eofPos + 6);
    
    // Valider at det er en PDF
    if (!pdfData.toString('utf-8', 0, 4).startsWith('%PDF') || pdfData.length < 1000) {
      return {
        aarsresultat: null,
        message: 'Ugyldig PDF-data',
      };
    }
    
    // Lagre PDF til temp-fil
    const tempPdfPath = path.join(PDF_TEMP_DIR, `${orgnr}_${year}.pdf`);
    fs.writeFileSync(tempPdfPath, pdfData);
    
    try {
      // Parse PDF
      const pdfDoc = await pdf(pdfData);
      const pdfText = pdfDoc.text;
      
      // Ekstraher årsresultat fra PDF-teksten
      const aarsresultat = extractAarsresultatFromPdfText(pdfText, orgnr, year);
      
      // Slett temp-fil
      if (fs.existsSync(tempPdfPath)) {
        fs.unlinkSync(tempPdfPath);
      }
      
      if (aarsresultat !== null) {
        return {
          aarsresultat,
          message: `Fant årsresultat ${aarsresultat} i PDF-teksten`,
        };
      }
      
      return {
        aarsresultat: null,
        message: 'Kunne ikke finne årsresultat i PDF-teksten',
      };
    } catch (parseError) {
      // Slett temp-fil hvis parsing feiler
      if (fs.existsSync(tempPdfPath)) {
        try {
          fs.unlinkSync(tempPdfPath);
        } catch (e) {
          // Ignorer feil ved sletting
        }
      }
      throw parseError;
    }
  } catch (error) {
    return {
      aarsresultat: null,
      message: (error as Error).message,
    };
  }
}

/**
 * Ekstrakterer årsresultat fra PDF-tekst
 */
function extractAarsresultatFromPdfText(pdfText: string, orgnr: string, year: number): number | null {
  // Prøv forskjellige patterns for å finne årsresultat i PDF-teksten
  const aarsresultatPatterns = [
    // "Årsresultat: 348 197" eller "Årsresultat 348 197" (med mellomrom i tall)
    /årsresultat[:\s]+([-]?\d{1,3}(?:\s?\d{3})*(?:\s?\d{3})*)/i,
    // "Årsresultat: 348197" (uten mellomrom)
    /årsresultat[:\s]+([-]?\d{4,12})/i,
    // "Resultat for året: 348 197"
    /resultat\s+for\s+året[:\s]+([-]?\d{1,3}(?:\s?\d{3})*(?:\s?\d{3})*)/i,
    // "Årsresultatet er 348 197"
    /årsresultatet\s+er[:\s]+([-]?\d{1,3}(?:\s?\d{3})*(?:\s?\d{3})*)/i,
    // "Nettoresultat: 348 197"
    /nettoresultat[:\s]+([-]?\d{1,3}(?:\s?\d{3})*(?:\s?\d{3})*)/i,
    // "Resultat: 348 197"
    /resultat[:\s]+([-]?\d{1,3}(?:\s?\d{3})*(?:\s?\d{3})*)/i,
    // "Årsresultat" på en linje, tall på neste linje
    /årsresultat\s*\n\s*([-]?\d{1,3}(?:\s?\d{3})*(?:\s?\d{3})*)/i,
    // "Årsresultat" med punktum som tusen-separator: "348.197"
    /årsresultat[:\s]+([-]?\d{1,3}(?:\.\d{3})*(?:\.\d{3})*)/i,
    // "Årsresultat" med komma som desimal-separator (kan være feil formatert): "348,197"
    /årsresultat[:\s]+([-]?\d{1,3}(?:,\d{3})*(?:,\d{3})*)/i,
  ];
  
  for (const pattern of aarsresultatPatterns) {
    const match = pdfText.match(pattern);
    if (match && match[1]) {
      // Fjern mellomrom, punktum og komma (som tusen-separatorer) og konverter til tall
      let cleanedValue = match[1].replace(/\s+/g, '').replace(/\./g, '').replace(/,/g, '');
      const parsedValue = parseInt(cleanedValue, 10);
      if (!isNaN(parsedValue)) {
        console.log(`[${orgnr}] ✅ Fant årsresultat ${parsedValue} i PDF-teksten for ${year} (pattern match)`);
        return parsedValue;
      }
    }
  }
  
  // Hvis vi ikke fant årsresultat med patterns, prøv å finne det i tabell-format
  const lines = pdfText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toLowerCase();
    if (line.includes('årsresultat') || (line.includes('resultat') && (line.includes('år') || line.includes('året')))) {
      // Se på samme linje og neste linjer for å finne et tall
      for (let j = Math.max(0, i - 1); j < Math.min(i + 5, lines.length); j++) {
        const numberMatch = lines[j].match(/([-]?\d{1,3}(?:\s?\d{3})*(?:\s?\d{3})*)/);
        if (numberMatch) {
          let cleanedValue = numberMatch[1].replace(/\s+/g, '').replace(/\./g, '').replace(/,/g, '');
          const parsedValue = parseInt(cleanedValue, 10);
          if (!isNaN(parsedValue) && Math.abs(parsedValue) > 100) {
            console.log(`[${orgnr}] ✅ Fant årsresultat ${parsedValue} i PDF-teksten (linje ${j + 1}) for ${year}`);
            return parsedValue;
          }
        }
      }
    }
  }
  
  return null;
}

/**
 * Ekstrakterer årsresultat fra JSON-data
 */
function extractAarsresultatFromJson(jsonData: Record<string, unknown>): number | null {
  // Prøv forskjellige steder i JSON-strukturen
  const paths = [
    ['resultatregnskapResultat', 'aarsresultat'],
    ['aarsresultat'],
    ['resultat', 'aarsresultat'],
    ['regnskap', 'resultat', 'aarsresultat'],
  ];
  
  for (const path of paths) {
    let value: unknown = jsonData;
    for (const key of path) {
      if (value && typeof value === 'object' && key in value) {
        value = (value as Record<string, unknown>)[key];
      } else {
        value = null;
        break;
      }
    }
    if (value !== null && typeof value === 'number') {
      return value;
    }
  }
  
  return null;
}

/**
 * Oppdaterer årsregnskap i databasen med ekstrahert årsresultat
 */
async function updateAnnualReportInDatabase(
  orgnr: string,
  year: number,
  aarsresultat: number
): Promise<void> {
  const postgresConfig = getPostgresEnvConfig();
  const client = createPostgresClient(postgresConfig);
  
  try {
    await client.connect();
    
    // Hent eksisterende data
    const result = await client.query<{ data: Record<string, unknown> }>(
      'SELECT data FROM brreg_annual_reports WHERE organisasjonsnummer = $1 AND ar = $2',
      [orgnr, year]
    );
    
    if (result.rows.length === 0) {
      // Opprett ny oppføring hvis den ikke eksisterer
      const newData: Record<string, unknown> = {
        source: 'pdf-scraped',
        raw: {
          year,
          hasJsonData: false,
          source: 'pdf-only',
          orgnr,
          resultatregnskapResultat: {
            aarsresultat,
          },
        },
      };
      
      await client.query(
        'INSERT INTO brreg_annual_reports (organisasjonsnummer, ar, data) VALUES ($1, $2, $3)',
        [orgnr, year, JSON.stringify(newData)]
      );
    } else {
      // Oppdater eksisterende data
      const existingData = result.rows[0].data;
      
      // Oppdater eller legg til årsresultat
      if (!existingData.raw || typeof existingData.raw !== 'object') {
        existingData.raw = {};
      }
      
      const raw = existingData.raw as Record<string, unknown>;
      if (!raw.resultatregnskapResultat || typeof raw.resultatregnskapResultat !== 'object') {
        raw.resultatregnskapResultat = {};
      }
      
      (raw.resultatregnskapResultat as Record<string, unknown>).aarsresultat = aarsresultat;
      
      await client.query(
        'UPDATE brreg_annual_reports SET data = $1 WHERE organisasjonsnummer = $2 AND ar = $3',
        [JSON.stringify(existingData), orgnr, year]
      );
    }
    
    console.log(`[${orgnr}] Oppdaterte årsregnskap for ${year} med årsresultat ${aarsresultat} i databasen`);
  } catch (error) {
    console.error(`[${orgnr}] Feil ved oppdatering av database for ${year}:`, (error as Error).message);
    throw error;
  } finally {
    await client.end();
  }
}

