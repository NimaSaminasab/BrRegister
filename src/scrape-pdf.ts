import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import pdf from 'pdf-parse';
import axios from 'axios';
import { createWorker } from 'tesseract.js';
import { createPostgresClient, getPostgresEnvConfig } from './postgres';

const execAsync = promisify(exec);

// Temp-mappe for PDF-filer
const PDF_TEMP_DIR = path.join(__dirname, '../temp_pdfs');

// Log-fil for debugging
const LOG_FILE = path.join(__dirname, '../../ocr-debug.log');

// Hjelpefunksjon for å logge til både console og fil
function debugLog(message: string) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  
  // Log til console
  console.log(message);
  process.stdout.write(logMessage);
  
  // Log til fil (async, ikke blokker)
  fs.appendFile(LOG_FILE, logMessage, (err) => {
    if (err) {
      // Ignorer feil ved logging til fil
    }
  });
}

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
): Promise<{ aarsresultat: number | null; salgsinntekt: number | null; sumInntekter: number | null; success: boolean; message: string }> {
  try {
    // Først: Prøv å hente via API (raskere og mer pålitelig)
    console.log(`[${orgnr}] Prøver først å hente via API for ${year}...`);
    try {
      const apiUrl = `https://data.brreg.no/regnskapsregisteret/regnskap/${orgnr}?ar=${year}`;
      const apiResponse = await axios.get(apiUrl, {
        headers: { Accept: 'application/json' },
        timeout: 10000,
        validateStatus: (status: number) => status === 200 || status === 404,
      });
      
      if (apiResponse.status === 200 && apiResponse.data) {
        const data = Array.isArray(apiResponse.data) ? apiResponse.data[0] : apiResponse.data;
        if (data && typeof data === 'object') {
          // VIKTIG: Sjekk at dette faktisk er regnskap for det riktige året
          const periode = data.regnskapsperiode as Record<string, unknown> | undefined;
          const tilDato = periode?.tilDato as string | undefined;
          let actualYear: number | null = null;
          
          if (tilDato && typeof tilDato === 'string') {
            const yearMatch = tilDato.match(/(\d{4})/);
            if (yearMatch) {
              actualYear = parseInt(yearMatch[1], 10);
            }
          }
          
          // Hvis faktisk år ikke matcher ønsket år, hopp over denne dataen
          if (actualYear !== null && actualYear !== year) {
            console.log(`[${orgnr}] ⚠️ API returnerte regnskap for ${actualYear}, men vi søkte etter ${year}. Prøver PDF-download i stedet.`);
            // Fortsett til PDF-download
          } else {
            // Året matcher (eller vi kunne ikke bestemme året), prøv å hente årsresultat
            const aarsresultat = extractAarsresultatFromJson(data);
            if (aarsresultat !== null) {
              const yearInfo = actualYear ? ` (bekreftet år: ${actualYear})` : '';
              console.log(`[${orgnr}] ✅ Fant årsresultat ${aarsresultat} via API for ${year}${yearInfo}`);
              await updateAnnualReportInDatabase(orgnr, year, aarsresultat, null, null);
              return {
                aarsresultat,
                salgsinntekt: null,
                sumInntekter: null,
                success: true,
                message: `Fant årsresultat ${aarsresultat} via API`,
              };
            } else {
              console.log(`[${orgnr}] API returnerte data for ${year}, men kunne ikke finne årsresultat. Prøver PDF-download.`);
              // Fortsett til PDF-download
            }
          }
        }
      }
    } catch (apiError) {
      console.log(`[${orgnr}] API-henting feilet for ${year}, prøver PDF-download:`, (apiError as Error).message);
    }
    
    // Hvis API ikke fungerte, prøv PDF-download via Next.js Server Action
    // Prøv flere mulige action ID-er og URL-er
    const possibleActionIds = [
      "7fe7b594d072ac1557da402414c7b7b1f94a43fe62",
      // Legg til flere action ID-er hvis nødvendig
    ];
    
    const baseUrl = `https://virksomhet.brreg.no/nb/oppslag/enheter/${orgnr}`;
    const alternativeUrl = `https://virksomhet.brreg.no/api/regnskap/${orgnr}/${year}/pdf`;
    
    console.log(`[${orgnr}] Scraper PDF for ${year}...`);
    
    // Prøv først alternativ URL (hvis den eksisterer)
    try {
      const altResponse = await axios.get(alternativeUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/pdf, */*',
        },
        timeout: 120000,
        validateStatus: (status: number) => status === 200 || status === 404,
        responseType: 'arraybuffer',
      });
      
      if (altResponse.status === 200 && altResponse.data && (altResponse.data as ArrayBuffer).byteLength > 1000) {
        console.log(`[${orgnr}] ✅ Fant PDF via alternativ URL (${alternativeUrl})`);
        const pdfBuffer = Buffer.from(altResponse.data);
        const pdfResult = await parsePdfAndExtractAarsresultat(orgnr, year, pdfBuffer);
        return {
          ...pdfResult,
          success: pdfResult.aarsresultat !== null || pdfResult.salgsinntekt !== null || pdfResult.sumInntekter !== null,
        };
      }
    } catch (altError) {
      console.log(`[${orgnr}] Alternativ URL feilet: ${(altError as Error).message}`);
    }
    
    // Prøv Next.js Server Action med forskjellige action ID-er
    for (const nextActionId of possibleActionIds) {
      try {
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
        
        console.log(`[${orgnr}] Prøver Server Action med ID: ${nextActionId.substring(0, 10)}...`);
        
        const serverActionResponse = await axios.post(baseUrl, body, {
          headers: serverActionHeaders,
          timeout: 120000,
          validateStatus: (status: number) => status === 200 || status === 404 || status === 400 || status === 500,
          responseType: 'arraybuffer',
        });
    
        console.log(`[${orgnr}] Server Action respons status: ${serverActionResponse.status}`);
        console.log(`[${orgnr}] Response data størrelse: ${serverActionResponse.data ? (serverActionResponse.data as ArrayBuffer).byteLength : 0} bytes`);
        
        if (serverActionResponse.status === 200 && serverActionResponse.data && (serverActionResponse.data as ArrayBuffer).byteLength > 1000) {
          const responseData = Buffer.from(serverActionResponse.data);
          console.log(`[${orgnr}] ✅ Fant PDF via Server Action med ID: ${nextActionId.substring(0, 10)}...`);
          const pdfResult = await parsePdfAndExtractAarsresultat(orgnr, year, responseData);
          return {
            ...pdfResult,
            success: pdfResult.aarsresultat !== null || pdfResult.salgsinntekt !== null || pdfResult.sumInntekter !== null,
          };
        } else if (serverActionResponse.status !== 200) {
          const errorText = Buffer.from(serverActionResponse.data).toString('utf-8').substring(0, 200);
          console.log(`[${orgnr}] Server Action ${nextActionId.substring(0, 10)}... returnerte status ${serverActionResponse.status}: ${errorText.substring(0, 50)}`);
          // Fortsett til neste action ID
          continue;
        }
      } catch (actionError) {
        console.log(`[${orgnr}] Server Action ${nextActionId.substring(0, 10)}... feilet: ${(actionError as Error).message}`);
        // Fortsett til neste action ID
        continue;
      }
    }
    
    // Hvis alle Server Actions feilet, returner feil
    return {
      aarsresultat: null,
      salgsinntekt: null,
      sumInntekter: null,
      success: false,
      message: `Kunne ikke hente PDF for ${year}. Alle Server Actions returnerte 404 eller feilet.`,
    };
  } catch (error) {
    console.error(`[${orgnr}] Feil ved scraping av PDF for ${year}:`, (error as Error).message);
    return {
      aarsresultat: null,
      salgsinntekt: null,
      sumInntekter: null,
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
): Promise<{ aarsresultat: number | null; salgsinntekt: number | null; sumInntekter: number | null; message: string }> {
  try {
    console.log(`[${orgnr}] Parser PDF-buffer (størrelse: ${pdfBuffer.length} bytes) for ${year}...`);
    
    // Sjekk om responsen inneholder feilmelding
    const responseText = pdfBuffer.toString('utf-8', 0, Math.min(500, pdfBuffer.length));
    console.log(`[${orgnr}] Første 500 tegn av respons: ${responseText.substring(0, 200)}...`);
    
    if (responseText.includes('Server action not found') || responseText.includes('error') || responseText.includes('Error')) {
      const fullError = responseText.substring(0, 200);
      console.error(`[${orgnr}] Server Action returnerte feilmelding: ${fullError}`);
      return {
        aarsresultat: null,
        salgsinntekt: null,
        sumInntekter: null,
        message: `Server Action returnerte feilmelding: ${fullError}`,
      };
    }
    
    // Finn PDF i responsen
    const pdfStart = pdfBuffer.indexOf('%PDF');
    console.log(`[${orgnr}] PDF start posisjon: ${pdfStart}`);
    
    if (pdfStart === -1) {
      // Prøv å se om det er en feilmelding
      if (responseText.length < 500) {
        console.warn(`[${orgnr}] Ingen PDF funnet i respons for ${year}, respons: ${responseText.substring(0, 200)}`);
        return {
          aarsresultat: null,
          salgsinntekt: null,
          sumInntekter: null,
          message: `Ingen PDF funnet i respons. Respons: ${responseText.substring(0, 200)}`,
        };
      } else {
        console.warn(`[${orgnr}] Ingen PDF funnet i respons for ${year} (respons størrelse: ${pdfBuffer.length} bytes)`);
        return {
          aarsresultat: null,
          salgsinntekt: null,
          sumInntekter: null,
          message: `Ingen PDF funnet i respons (størrelse: ${pdfBuffer.length} bytes)`,
        };
      }
    }
    
    // Finn %%EOF marker
    const eofPos = pdfBuffer.lastIndexOf('%%EOF');
    console.log(`[${orgnr}] PDF EOF posisjon: ${eofPos}`);
    
    if (eofPos === -1) {
      console.warn(`[${orgnr}] PDF er ufullstendig (ingen %%EOF marker) for ${year}`);
      return {
        aarsresultat: null,
        salgsinntekt: null,
        sumInntekter: null,
        message: 'PDF er ufullstendig (ingen %%EOF marker)',
      };
    }
    
    // Ekstraher PDF
    const pdfData = pdfBuffer.subarray(pdfStart, eofPos + 6); // +6 for "%%EOF\n"
    console.log(`[${orgnr}] Ekstrahert PDF-data størrelse: ${pdfData.length} bytes`);
    
    // Valider at det er en PDF
    if (!pdfData.toString('utf-8', 0, 4).startsWith('%PDF') || pdfData.length < 1000) {
      console.warn(`[${orgnr}] Ugyldig PDF-data for ${year} (størrelse: ${pdfData.length} bytes)`);
      return {
        aarsresultat: null,
        salgsinntekt: null,
        sumInntekter: null,
        message: `Ugyldig PDF-data (størrelse: ${pdfData.length} bytes, minimum 1000 bytes forventet)`,
      };
    }
    
    // Lagre PDF til temp-fil
    const tempPdfPath = path.join(PDF_TEMP_DIR, `${orgnr}_${year}.pdf`);
    fs.writeFileSync(tempPdfPath, pdfData);
    
    try {
      // Parse PDF
      console.log(`[${orgnr}] Parser PDF (størrelse: ${pdfData.length} bytes)...`);
      
      let pdfDoc;
      try {
        pdfDoc = await pdf(pdfData);
      } catch (parseError) {
        console.error(`[${orgnr}] Feil ved PDF-parsing:`, (parseError as Error).message);
        return {
          aarsresultat: null,
          salgsinntekt: null,
          sumInntekter: null,
          message: `Feil ved PDF-parsing: ${(parseError as Error).message}`,
        };
      }
      
      const pdfText = pdfDoc.text;
      
      console.log(`[${orgnr}] PDF parsed. Tekst lengde: ${pdfText.length} tegn`);
      console.log(`[${orgnr}] PDF info: ${pdfDoc.info ? JSON.stringify(pdfDoc.info).substring(0, 200) : 'ingen info'}`);
      console.log(`[${orgnr}] PDF metadata: ${pdfDoc.metadata ? JSON.stringify(pdfDoc.metadata).substring(0, 200) : 'ingen metadata'}`);
      
      // Hvis PDF-teksten er for kort, kan det være at parsing feilet eller at det er en scanned PDF
      if (pdfText.length < 50) {
        console.warn(`[${orgnr}] PDF-tekst er veldig kort (${pdfText.length} tegn). Dette kan tyde på at PDF-en er tom, parsing feilet, eller at det er en scanned PDF.`);
        console.warn(`[${orgnr}] PDF-tekst innhold: "${pdfText}"`);
        console.warn(`[${orgnr}] PDF-tekst (hex): ${Buffer.from(pdfText).toString('hex').substring(0, 100)}`);
        
        // Prøv å se om PDF-en faktisk inneholder noe data
        const pdfHasContent = pdfData.length > 10000; // PDF-er er vanligvis større enn 10KB
        
        // Hvis PDF-en er stor men har lite tekst, kan det være en scanned PDF
        // Prøv OCR først, deretter søk etter journalnummer i metadata
        if (pdfHasContent) {
          console.log(`[${orgnr}] PDF er stor (${pdfData.length} bytes) men har lite tekst. Prøver OCR...`);
          
          // Prøv OCR på første siden av PDF-en
          try {
            debugLog(`[${orgnr}] Kaller performOCR for ${year}...`);
            const ocrText = await performOCR(tempPdfPath, orgnr, year);
            debugLog(`[${orgnr}] performOCR returnerte: ${ocrText ? `${ocrText.length} tegn` : 'null'}`);
            
            if (ocrText && ocrText.length > 50) {
              debugLog(`[${orgnr}] OCR ekstraherte ${ocrText.length} tegn fra PDF for ${year}`);
              debugLog(`[${orgnr}] OCR-tekst sample (første 1000 tegn): ${ocrText.substring(0, 1000)}`);
              
              const aarsresultat = extractAarsresultatFromPdfText(ocrText, orgnr, year);
              const salgsinntekt = extractSalgsinntektFromPdfText(ocrText, orgnr, year);
              const sumInntekter = extractSumInntekterFromPdfText(ocrText, orgnr, year);
              
              // Log hva OCR faktisk ekstraherte for debugging
              debugLog(`[${orgnr}] OCR-resultat for ${year}:`);
              debugLog(`[${orgnr}]   - Årsresultat: ${aarsresultat !== null ? aarsresultat : 'ikke funnet'}`);
              debugLog(`[${orgnr}]   - Salgsinntekt: ${salgsinntekt !== null ? salgsinntekt : 'ikke funnet'}`);
              debugLog(`[${orgnr}]   - Sum inntekter: ${sumInntekter !== null ? sumInntekter : 'ikke funnet'}`);
              console.log(`[${orgnr}]   - OCR-tekst inneholder "resultat": ${ocrText.toLowerCase().includes('resultat')}`);
              console.log(`[${orgnr}]   - OCR-tekst inneholder "årsresultat": ${ocrText.toLowerCase().includes('årsresultat')}`);
              console.log(`[${orgnr}]   - OCR-tekst inneholder "salgsinntekt": ${ocrText.toLowerCase().includes('salgsinntekt')}`);
              console.log(`[${orgnr}]   - OCR-tekst inneholder "omsetning": ${ocrText.toLowerCase().includes('omsetning')}`);
              console.log(`[${orgnr}]   - OCR-tekst inneholder "driftsinntekt": ${ocrText.toLowerCase().includes('driftsinntekt')}`);
              const lowerOcrText = ocrText.toLowerCase();
              const hasSum = lowerOcrText.includes('sum');
              const hasInntekter = lowerOcrText.includes('inntekter') || lowerOcrText.includes('inntekt');
              console.log(`[${orgnr}]   - OCR-tekst inneholder "sum": ${hasSum}`);
              console.log(`[${orgnr}]   - OCR-tekst inneholder "inntekter/inntekt": ${hasInntekter}`);
              console.log(`[${orgnr}]   - OCR-tekst inneholder "sum inntekter": ${hasSum && hasInntekter}`);
              
              // Prøv å finne alle tall i OCR-teksten for debugging
              const allNumbers = ocrText.match(/([-]?\d{1,3}(?:\s?\d{3})*(?:\s?\d{3})*)/g);
              if (allNumbers && allNumbers.length > 0) {
                const uniqueNumbers = [...new Set(allNumbers.slice(0, 10))];
                console.log(`[${orgnr}]   - Fant ${allNumbers.length} tall i OCR-teksten. Første 10 unike: ${uniqueNumbers.join(', ')}`);
                
                // Prøv å finne store tall som kan være "Sum inntekter" (vanligvis millioner)
                const largeNumbers = allNumbers.filter(num => {
                  const cleaned = num.replace(/\s+/g, '').replace(/\./g, '').replace(/,/g, '');
                  const parsed = parseInt(cleaned, 10);
                  return !isNaN(parsed) && parsed > 100000;
                });
                if (largeNumbers.length > 0) {
                  console.log(`[${orgnr}]   - Store tall (mulig "Sum inntekter"): ${largeNumbers.slice(0, 5).join(', ')}`);
                }
              }
              
              // Log en sample av OCR-teksten som inneholder "sum" eller "inntekter"
              if (hasSum || hasInntekter) {
                const lines = ocrText.split('\n');
                const relevantLines = lines.filter(line => 
                  line.toLowerCase().includes('sum') || 
                  line.toLowerCase().includes('inntekter') || 
                  line.toLowerCase().includes('inntekt')
                );
                if (relevantLines.length > 0) {
                  console.log(`[${orgnr}]   - Relevante linjer med "sum/inntekter" (første 5):`);
                  relevantLines.slice(0, 5).forEach((line, idx) => {
                    console.log(`[${orgnr}]     ${idx + 1}. "${line.substring(0, 150)}"`);
                  });
                }
              }
              
              if (aarsresultat !== null || salgsinntekt !== null || sumInntekter !== null) {
                // Oppdater database med det ekstraherte data
                await updateAnnualReportInDatabase(orgnr, year, aarsresultat, salgsinntekt, sumInntekter);
                
                // Slett temp-fil
                if (fs.existsSync(tempPdfPath)) {
                  fs.unlinkSync(tempPdfPath);
                }
                const foundItems = [];
                if (aarsresultat !== null) foundItems.push(`årsresultat ${aarsresultat}`);
                if (salgsinntekt !== null) foundItems.push(`salgsinntekt ${salgsinntekt}`);
                if (sumInntekter !== null) foundItems.push(`sum inntekter ${sumInntekter}`);
                return {
                  aarsresultat: aarsresultat,
                  salgsinntekt: salgsinntekt,
                  sumInntekter: sumInntekter,
                  message: `Fant ${foundItems.join(', ')} via OCR`,
                };
              } else {
                console.log(`[${orgnr}] ⚠️ OCR ekstraherte tekst, men kunne ikke finne årsresultat, salgsinntekt eller sum inntekter i teksten`);
                // Prøv å finne store tall som kan være salgsinntekt eller årsresultat
                const largeNumbers = ocrText.match(/([-]?\d{1,3}(?:\s?\d{3}){2,}(?:\s?\d{3})*)/g);
                if (largeNumbers && largeNumbers.length > 0) {
                  console.log(`[${orgnr}]   - Fant store tall i OCR-teksten (mulig årsresultat/salgsinntekt): ${largeNumbers.slice(0, 5).join(', ')}`);
                }
              }
            } else {
              console.log(`[${orgnr}] ⚠️ OCR ekstraherte lite tekst (${ocrText?.length || 0} tegn)`);
              if (ocrText && ocrText.length > 0) {
                console.log(`[${orgnr}] OCR-tekst (første 500 tegn): ${ocrText.substring(0, 500)}`);
                console.log(`[${orgnr}] OCR-tekst (hele): "${ocrText}"`);
              } else {
                console.log(`[${orgnr}] ⚠️ OCR returnerte null eller tom tekst`);
              }
            }
          } catch (ocrError) {
            console.error(`[${orgnr}] OCR feilet med feil:`, (ocrError as Error).message);
            console.error(`[${orgnr}] OCR feil stack:`, (ocrError as Error).stack);
          }
        } else {
          console.log(`[${orgnr}] PDF er ikke stor nok (${pdfData.length} bytes) for OCR`);
        }
        
        // Prøv å finne journalnummer i PDF-metadata eller info
        if (pdfHasContent && pdfDoc.info) {
          console.log(`[${orgnr}] PDF er stor (${pdfData.length} bytes) men har lite tekst. Prøver å finne journalnummer i PDF-metadata...`);
          const info = pdfDoc.info as Record<string, unknown>;
          
          // Søk etter journalnummer i PDF-info/metadata
          let journalNr: string | null = null;
          for (const [key, value] of Object.entries(info)) {
            if (typeof value === 'string' && /^\d{10}$/.test(value)) {
              journalNr = value;
              console.log(`[${orgnr}] Fant journalnummer ${journalNr} i PDF-metadata (${key})`);
              break;
            }
            // Prøv også å søke i verdien som tekst
            if (typeof value === 'string' && value.length > 0) {
              const journalMatch = value.match(/(\d{10})/);
              if (journalMatch) {
                journalNr = journalMatch[1];
                console.log(`[${orgnr}] Fant journalnummer ${journalNr} i PDF-metadata (${key}: ${value})`);
                break;
              }
            }
          }
          
          // Prøv også i metadata
          if (!journalNr && pdfDoc.metadata) {
            const metadata = pdfDoc.metadata as Record<string, unknown>;
            for (const [key, value] of Object.entries(metadata)) {
              if (typeof value === 'string' && /^\d{10}$/.test(value)) {
                journalNr = value;
                console.log(`[${orgnr}] Fant journalnummer ${journalNr} i PDF-metadata (${key})`);
                break;
              }
            }
          }
          
          // Hvis vi fant journalnummer, prøv å hente via API
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
                  // Sjekk at det er for riktig år
                  const periode = data.regnskapsperiode as Record<string, unknown> | undefined;
                  const tilDato = periode?.tilDato as string | undefined;
                  let actualYear: number | null = null;
                  
                  if (tilDato && typeof tilDato === 'string') {
                    const yearMatch = tilDato.match(/(\d{4})/);
                    if (yearMatch) {
                      actualYear = parseInt(yearMatch[1], 10);
                    }
                  }
                  
                  if (actualYear === year || actualYear === null) {
                    const aarsresultat = extractAarsresultatFromJson(data);
                    if (aarsresultat !== null) {
                      console.log(`[${orgnr}] ✅ Fant årsresultat ${aarsresultat} via API med journalnummer fra PDF-metadata for ${year}`);
                      await updateAnnualReportInDatabase(orgnr, year, aarsresultat, null, null);
                      return {
                        aarsresultat,
                        salgsinntekt: null,
                        sumInntekter: null,
                        message: `Fant årsresultat ${aarsresultat} via API med journalnummer fra PDF-metadata`,
                      };
                    }
                  }
                }
              }
            } catch (apiError) {
              console.log(`[${orgnr}] Feil ved API-henting med journalnummer fra PDF-metadata:`, (apiError as Error).message);
            }
          }
        }
        
        // Hvis OCR ikke fungerte, gi en informativ feilmelding
        const fullText = pdfText.replace(/"/g, '\\"').replace(/\n/g, '\\n').substring(0, 200);
        const hexPreview = Buffer.from(pdfText).toString('hex').substring(0, 100);
        
        let message = `PDF-tekst er for kort (${pdfText.length} tegn). `;
        message += `Innhold: "${fullText}". `;
        message += `Hex: ${hexPreview}... `;
        
        if (pdfHasContent) {
          message += `PDF-filen er ${pdfData.length} bytes, men inneholder lite eller ingen tekst. Dette kan tyde på at PDF-en kun inneholder bilder/scanned dokumenter. `;
          message += `OCR ble prøvd, men kunne ikke ekstraktere årsresultat. Sjekk server-loggen for detaljer.`;
        } else {
          message += `PDF-filen er også liten (${pdfData.length} bytes), noe som tyder på at PDF-en ikke ble lastet ned korrekt eller er en feilmelding.`;
        }
        
        return {
          aarsresultat: null,
          salgsinntekt: null,
          sumInntekter: null,
          message,
        };
      }
      
      // Ekstraher årsresultat, salgsinntekt og sum inntekter fra PDF-teksten
      const aarsresultat = extractAarsresultatFromPdfText(pdfText, orgnr, year);
      const salgsinntekt = extractSalgsinntektFromPdfText(pdfText, orgnr, year);
      const sumInntekter = extractSumInntekterFromPdfText(pdfText, orgnr, year);
      
      // Slett temp-fil
      if (fs.existsSync(tempPdfPath)) {
        fs.unlinkSync(tempPdfPath);
      }
      
      if (aarsresultat !== null || salgsinntekt !== null || sumInntekter !== null) {
        const foundItems = [];
        if (aarsresultat !== null) foundItems.push(`årsresultat ${aarsresultat}`);
        if (salgsinntekt !== null) foundItems.push(`salgsinntekt ${salgsinntekt}`);
        if (sumInntekter !== null) foundItems.push(`sum inntekter ${sumInntekter}`);
        return {
          aarsresultat: aarsresultat,
          salgsinntekt: salgsinntekt,
          sumInntekter: sumInntekter,
          message: `Fant ${foundItems.join(', ')} i PDF-teksten`,
        };
      }
      
      // Hvis vi ikke fant årsresultat, gi mer informasjon
      const textLength = pdfText.length;
      const hasResultat = pdfText.toLowerCase().includes('resultat');
      const hasRegnskap = pdfText.toLowerCase().includes('regnskap');
      const hasAarsresultat = pdfText.toLowerCase().includes('årsresultat');
      
      let debugInfo = `PDF-tekst lengde: ${textLength} tegn. `;
      debugInfo += `Inneholder "resultat": ${hasResultat}, "regnskap": ${hasRegnskap}, "årsresultat": ${hasAarsresultat}. `;
      
      // Prøv å finne noen tall i PDF-en for debugging
      const numbers = pdfText.match(/([-]?\d{1,3}(?:\s?\d{3})*(?:\s?\d{3})*)/g);
      if (numbers && numbers.length > 0) {
        const sampleNumbers = numbers.slice(0, 5).join(', ');
        debugInfo += `Fant tall i PDF: ${sampleNumbers}...`;
      }
      
        return {
          aarsresultat: null,
          salgsinntekt: null,
          sumInntekter: null,
          message: `Kunne ikke finne årsresultat i PDF-teksten. ${debugInfo}`,
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
      salgsinntekt: null,
      sumInntekter: null,
      message: (error as Error).message,
    };
  }
}

/**
 * Ekstrakterer årsresultat fra PDF-tekst
 */
function extractAarsresultatFromPdfText(pdfText: string, orgnr: string, year: number): number | null {
  // Log første del av PDF-teksten for debugging
  const textSample = pdfText.substring(0, Math.min(1000, pdfText.length));
  console.log(`[${orgnr}] PDF-tekst sample for ${year} (${pdfText.length} tegn totalt):\n${textSample.substring(0, 500)}...`);
  
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
    // "Resultatregnskap" - ofte brukt i norske årsregnskap
    /resultatregnskap[^\d]*([-]?\d{1,3}(?:\s?\d{3})*(?:\s?\d{3})*)/i,
    // "Resultat etter skatt" eller "Resultat etter skatt:"
    /resultat\s+etter\s+skatt[:\s]+([-]?\d{1,3}(?:\s?\d{3})*(?:\s?\d{3})*)/i,
    // "Årsresultat" med parenteser: "Årsresultat (348 197)"
    /årsresultat[^:]*\(([-]?\d{1,3}(?:\s?\d{3})*(?:\s?\d{3})*)\)/i,
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
  console.log(`[${orgnr}] Søker i ${lines.length} linjer for årsresultat...`);
  
  // Søk etter linjer som inneholder "Årsresultat" (prioriter denne)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toLowerCase();
    
    // Prioriter eksakt match på "årsresultat" (ikke bare "resultat")
    if (line.includes('årsresultat')) {
      console.log(`[${orgnr}] Fant "årsresultat"-linje ${i + 1} for ${year}: "${lines[i].substring(0, 150)}"`);
      
      // Først: Prøv å finne tall på samme linje som "Årsresultat"
      const sameLineMatch = lines[i].match(/årsresultat[^\d]*([-]?\d{1,3}(?:\s?\d{3})*(?:\s?\d{3})*)/i);
      if (sameLineMatch && sameLineMatch[1]) {
        let cleanedValue = sameLineMatch[1].replace(/\s+/g, '').replace(/\./g, '').replace(/,/g, '');
        const parsedValue = parseInt(cleanedValue, 10);
        if (!isNaN(parsedValue) && Math.abs(parsedValue) > 100) {
          console.log(`[${orgnr}] ✅ Fant årsresultat ${parsedValue} på samme linje som "Årsresultat" for ${year}`);
          return parsedValue;
        }
      }
      
      // Hvis ikke på samme linje, se på neste linje (ikke forrige, for å unngå å ta tall fra forrige seksjon)
      if (i + 1 < lines.length) {
        const nextLine = lines[i + 1];
        // Prøv å finne første tall på neste linje
        const nextLineMatch = nextLine.match(/([-]?\d{1,3}(?:\s?\d{3})*(?:\s?\d{3})*)/);
        if (nextLineMatch && nextLineMatch[1]) {
          let cleanedValue = nextLineMatch[1].replace(/\s+/g, '').replace(/\./g, '').replace(/,/g, '');
          const parsedValue = parseInt(cleanedValue, 10);
          if (!isNaN(parsedValue) && Math.abs(parsedValue) > 100) {
            console.log(`[${orgnr}] ✅ Fant årsresultat ${parsedValue} på linje etter "Årsresultat" for ${year}`);
            return parsedValue;
          }
        }
      }
    }
  }
  
  // Fallback: Søk etter andre resultat-relaterte ord (men være mer forsiktig)
  const resultatKeywords = ['resultat etter skatt', 'nettoresultat', 'resultat for året'];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toLowerCase();
    
    // Sjekk om linjen inneholder noen av nøkkelordene
    const hasKeyword = resultatKeywords.some(keyword => line.includes(keyword));
    
    if (hasKeyword) {
      console.log(`[${orgnr}] Fant resultat-linje ${i + 1} for ${year}: "${lines[i].substring(0, 100)}"`);
      
      // Prøv å finne tall på samme linje først
      const sameLineMatch = lines[i].match(/([-]?\d{1,3}(?:\s?\d{3})*(?:\s?\d{3})*)/);
      if (sameLineMatch && sameLineMatch[1]) {
        let cleanedValue = sameLineMatch[1].replace(/\s+/g, '').replace(/\./g, '').replace(/,/g, '');
        const parsedValue = parseInt(cleanedValue, 10);
        if (!isNaN(parsedValue) && Math.abs(parsedValue) > 100) {
          console.log(`[${orgnr}] ✅ Fant årsresultat ${parsedValue} i PDF-teksten (linje ${i + 1}) for ${year}`);
          return parsedValue;
        }
      }
    }
  }
  
  // Siste forsøk: Søk etter store tall i nærheten av "resultat" eller "regnskap"
  // Men være mer forsiktig - kun ta tall på samme linje eller neste linje
  console.log(`[${orgnr}] Prøver siste forsøk: søker etter store tall nær "resultat" eller "regnskap"...`);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toLowerCase();
    // Prioriter linjer som inneholder "resultat" (ikke bare "regnskap")
    if (line.includes('resultat')) {
      // Først prøv samme linje
      const sameLineMatch = lines[i].match(/([-]?\d{1,3}(?:\s?\d{3})*(?:\s?\d{3})*)/);
      if (sameLineMatch && sameLineMatch[1]) {
        let cleanedValue = sameLineMatch[1].replace(/\s+/g, '').replace(/\./g, '').replace(/,/g, '');
        const parsedValue = parseInt(cleanedValue, 10);
        if (!isNaN(parsedValue) && Math.abs(parsedValue) > 100) {
          console.log(`[${orgnr}] ✅ Fant mulig årsresultat ${parsedValue} på samme linje som "resultat" (linje ${i + 1}) for ${year}`);
          return parsedValue;
        }
      }
      
      // Hvis ikke, prøv neste linje (ikke forrige)
      if (i + 1 < lines.length) {
        const nextLineMatch = lines[i + 1].match(/([-]?\d{1,3}(?:\s?\d{3})*(?:\s?\d{3})*)/);
        if (nextLineMatch && nextLineMatch[1]) {
          let cleanedValue = nextLineMatch[1].replace(/\s+/g, '').replace(/\./g, '').replace(/,/g, '');
          const parsedValue = parseInt(cleanedValue, 10);
          if (!isNaN(parsedValue) && Math.abs(parsedValue) > 100) {
            console.log(`[${orgnr}] ✅ Fant mulig årsresultat ${parsedValue} på linje etter "resultat" (linje ${i + 2}) for ${year}`);
            return parsedValue;
          }
        }
      }
    }
  }
  
  console.log(`[${orgnr}] ⚠️ Kunne ikke finne årsresultat i PDF-teksten for ${year}`);
  return null;
}

/**
 * Ekstrakterer salgsinntekt fra PDF-tekst
 */
function extractSalgsinntektFromPdfText(pdfText: string, orgnr: string, year: number): number | null {
  // Log første del av PDF-teksten for debugging
  const textSample = pdfText.substring(0, Math.min(1000, pdfText.length));
  console.log(`[${orgnr}] Søker etter salgsinntekt i PDF-tekst for ${year} (${pdfText.length} tegn totalt)...`);
  
  // Prøv forskjellige patterns for å finne salgsinntekt i PDF-teksten
  const salgsinntektPatterns = [
    // "Salgsinntekt: 1 234 567" eller "Salgsinntekt 1 234 567" (med mellomrom i tall)
    /salgsinntekt[:\s]+([-]?\d{1,3}(?:\s?\d{3})*(?:\s?\d{3})*)/i,
    // "Salgsinntekt: 1234567" (uten mellomrom)
    /salgsinntekt[:\s]+([-]?\d{4,12})/i,
    // "Omsetning: 1 234 567"
    /omsetning[:\s]+([-]?\d{1,3}(?:\s?\d{3})*(?:\s?\d{3})*)/i,
    // "Omsetning: 1234567"
    /omsetning[:\s]+([-]?\d{4,12})/i,
    // "Salgsinntekt" med punktum som tusen-separator: "1.234.567"
    /salgsinntekt[:\s]+([-]?\d{1,3}(?:\.\d{3})*(?:\.\d{3})*)/i,
    // "Omsetning" med punktum som tusen-separator
    /omsetning[:\s]+([-]?\d{1,3}(?:\.\d{3})*(?:\.\d{3})*)/i,
    // "Salgsinntekt" på en linje, tall på neste linje
    /salgsinntekt\s*\n\s*([-]?\d{1,3}(?:\s?\d{3})*(?:\s?\d{3})*)/i,
    // "Omsetning" på en linje, tall på neste linje
    /omsetning\s*\n\s*([-]?\d{1,3}(?:\s?\d{3})*(?:\s?\d{3})*)/i,
    // "Driftsinntekt" - ofte brukt i norske årsregnskap
    /driftsinntekt[:\s]+([-]?\d{1,3}(?:\s?\d{3})*(?:\s?\d{3})*)/i,
    // "Totalinntekt" eller "Total inntekt"
    /total\s*inntekt[:\s]+([-]?\d{1,3}(?:\s?\d{3})*(?:\s?\d{3})*)/i,
    // "Inntekt" med store tall (vanligvis salgsinntekt er størst)
    /inntekt[:\s]+([-]?\d{1,3}(?:\s?\d{3})*(?:\s?\d{3})*)/i,
  ];
  
  for (const pattern of salgsinntektPatterns) {
    const match = pdfText.match(pattern);
    if (match && match[1]) {
      // Fjern mellomrom, punktum og komma (som tusen-separatorer) og konverter til tall
      let cleanedValue = match[1].replace(/\s+/g, '').replace(/\./g, '').replace(/,/g, '');
      const parsedValue = parseInt(cleanedValue, 10);
      if (!isNaN(parsedValue)) {
        console.log(`[${orgnr}] ✅ Fant salgsinntekt ${parsedValue} i PDF-teksten for ${year} (pattern match)`);
        return parsedValue;
      }
    }
  }
  
  // Hvis vi ikke fant salgsinntekt med patterns, prøv å finne det i tabell-format
  const lines = pdfText.split('\n');
  console.log(`[${orgnr}] Søker i ${lines.length} linjer for salgsinntekt...`);
  
  // Søk etter linjer som inneholder salgsinntekt-relaterte ord
  const salgsinntektKeywords = ['salgsinntekt', 'omsetning', 'driftsinntekt', 'total inntekt', 'totalinntekt'];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toLowerCase();
    
    // Sjekk om linjen inneholder noen av nøkkelordene
    const hasKeyword = salgsinntektKeywords.some(keyword => line.includes(keyword));
    
    if (hasKeyword) {
      console.log(`[${orgnr}] Fant "salgsinntekt/omsetning"-linje ${i + 1} for ${year}: "${line.substring(0, 100)}"`);
      
      // Se på samme linje og neste linjer for å finne et tall
      for (let j = Math.max(0, i - 1); j < Math.min(i + 5, lines.length); j++) {
        // Prøv å finne tall med tusen-separatorer (mellomrom, punktum, komma)
        const numberMatch = lines[j].match(/([-]?\d{1,3}(?:\s?\d{3})*(?:\s?\d{3})*)/);
        if (numberMatch) {
          let cleanedValue = numberMatch[1].replace(/\s+/g, '').replace(/\./g, '').replace(/,/g, '');
          const parsedValue = parseInt(cleanedValue, 10);
          // Salgsinntekt er vanligvis et stort tall (minst 1000)
          if (!isNaN(parsedValue) && parsedValue > 1000) {
            console.log(`[${orgnr}] ✅ Fant salgsinntekt ${parsedValue} i PDF-teksten (linje ${j + 1}) for ${year}`);
            return parsedValue;
          }
        }
      }
    }
  }
  
  console.log(`[${orgnr}] ⚠️ Kunne ikke finne salgsinntekt i PDF-teksten for ${year}`);
  return null;
}

/**
 * Ekstrakterer "Sum inntekter" fra PDF-tekst
 */
function extractSumInntekterFromPdfText(pdfText: string, orgnr: string, year: number): number | null {
  console.log(`[${orgnr}] Søker etter "Sum inntekter" i PDF-tekst for ${year} (${pdfText.length} tegn totalt)...`);
  
  // Prøv forskjellige patterns for å finne "Sum inntekter" i PDF-teksten
  const sumInntekterPatterns = [
    // "Sum inntekter: 8 524 493" eller "Sum inntekter 8 524 493" (med mellomrom i tall)
    /sum\s+inntekter[:\s]+([-]?\d{1,3}(?:\s?\d{3})*(?:\s?\d{3})*)/i,
    // "Sum inntekter: 8524493" (uten mellomrom)
    /sum\s+inntekter[:\s]+([-]?\d{4,12})/i,
    // "Sum inntekter" med punktum som tusen-separator: "8.524.493"
    /sum\s+inntekter[:\s]+([-]?\d{1,3}(?:\.\d{3})*(?:\.\d{3})*)/i,
    // "Sum inntekter" på en linje, tall på neste linje
    /sum\s+inntekter\s*\n\s*([-]?\d{1,3}(?:\s?\d{3})*(?:\s?\d{3})*)/i,
    // "Sum inntekter" med komma som tusen-separator
    /sum\s+inntekter[:\s]+([-]?\d{1,3}(?:,\d{3})*(?:,\d{3})*)/i,
    // "Sum inntekter" uten mellomrom mellom ord (OCR kan gjøre feil)
    /suminntekter[:\s]+([-]?\d{1,3}(?:\s?\d{3})*(?:\s?\d{3})*)/i,
    // "Sum inntekter" med store/små bokstaver variasjoner
    /[Ss]um\s+[Ii]nntekter[:\s]+([-]?\d{1,3}(?:\s?\d{3})*(?:\s?\d{3})*)/,
    // Søk etter linjer som inneholder både "sum" og "inntekter" (kan være på forskjellige steder)
    /sum.*inntekter.*?([-]?\d{1,3}(?:\s?\d{3})*(?:\s?\d{3})*)/i,
    /inntekter.*sum.*?([-]?\d{1,3}(?:\s?\d{3})*(?:\s?\d{3})*)/i,
  ];
  
  for (const pattern of sumInntekterPatterns) {
    const match = pdfText.match(pattern);
    if (match && match[1]) {
      // Fjern mellomrom, punktum og komma (som tusen-separatorer) og konverter til tall
      let cleanedValue = match[1].replace(/\s+/g, '').replace(/\./g, '').replace(/,/g, '');
      const parsedValue = parseInt(cleanedValue, 10);
      if (!isNaN(parsedValue)) {
        console.log(`[${orgnr}] ✅ Fant "Sum inntekter" ${parsedValue} i PDF-teksten for ${year} (pattern match)`);
        return parsedValue;
      }
    }
  }
  
  // Hvis vi ikke fant "Sum inntekter" med patterns, prøv å finne det i tabell-format
  const lines = pdfText.split('\n');
  console.log(`[${orgnr}] Søker i ${lines.length} linjer for "Sum inntekter"...`);
  
  // Søk etter linjer som inneholder "Sum inntekter" eller lignende
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toLowerCase();
    const originalLine = lines[i];
    
    // Sjekk om linjen inneholder "sum" og "inntekter" (kan være på forskjellige steder)
    const hasSum = line.includes('sum');
    const hasInntekter = line.includes('inntekter') || line.includes('inntekt');
    
    if (hasSum && hasInntekter) {
      console.log(`[${orgnr}] Fant "Sum inntekter"-linje ${i + 1} for ${year}: "${originalLine.substring(0, 150)}"`);
      
      // Se på samme linje først
      const sameLineMatch = originalLine.match(/([-]?\d{1,3}(?:\s?\d{3}){2,}(?:\s?\d{3})*)/);
      if (sameLineMatch) {
        let cleanedValue = sameLineMatch[1].replace(/\s+/g, '').replace(/\./g, '').replace(/,/g, '');
        const parsedValue = parseInt(cleanedValue, 10);
        if (!isNaN(parsedValue) && parsedValue > 1000) {
          console.log(`[${orgnr}] ✅ Fant "Sum inntekter" ${parsedValue} på samme linje (linje ${i + 1}) for ${year}`);
          return parsedValue;
        }
      }
      
      // Se på neste linjer for å finne et tall
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        // Prøv å finne tall med tusen-separatorer (mellomrom, punktum, komma)
        const numberMatch = lines[j].match(/([-]?\d{1,3}(?:\s?\d{3}){2,}(?:\s?\d{3})*)/);
        if (numberMatch) {
          let cleanedValue = numberMatch[1].replace(/\s+/g, '').replace(/\./g, '').replace(/,/g, '');
          const parsedValue = parseInt(cleanedValue, 10);
          // "Sum inntekter" er vanligvis et stort tall (minst 1000)
          if (!isNaN(parsedValue) && parsedValue > 1000) {
            console.log(`[${orgnr}] ✅ Fant "Sum inntekter" ${parsedValue} i PDF-teksten (linje ${j + 1}, etter "Sum inntekter"-linje) for ${year}`);
            return parsedValue;
          }
        }
      }
    }
  }
  
  // Siste forsøk: Søk etter store tall nær "sum" og "inntekter" (kan være på forskjellige linjer)
  console.log(`[${orgnr}] Prøver siste forsøk: søker etter store tall nær "sum" og "inntekter"...`);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toLowerCase();
    if (line.includes('sum') || line.includes('inntekter') || line.includes('inntekt')) {
      // Se på linjer i nærheten
      for (let j = Math.max(0, i - 2); j < Math.min(i + 3, lines.length); j++) {
        // Prøv å finne store tall (minst 6 siffer = minst 100 000)
        const largeNumberMatch = lines[j].match(/([-]?\d{1,3}(?:\s?\d{3}){2,}(?:\s?\d{3})*)/);
        if (largeNumberMatch) {
          let cleanedValue = largeNumberMatch[1].replace(/\s+/g, '').replace(/\./g, '').replace(/,/g, '');
          const parsedValue = parseInt(cleanedValue, 10);
          // "Sum inntekter" er vanligvis et stort tall (minst 100 000 for små bedrifter, ofte millioner)
          if (!isNaN(parsedValue) && parsedValue > 100000) {
            console.log(`[${orgnr}] ✅ Fant mulig "Sum inntekter" ${parsedValue} i PDF-teksten (linje ${j + 1}, nær "sum/inntekter") for ${year}`);
            return parsedValue;
          }
        }
      }
    }
  }
  
  console.log(`[${orgnr}] ⚠️ Kunne ikke finne "Sum inntekter" i PDF-teksten for ${year}`);
  return null;
}

/**
 * Utfører OCR på PDF for å ekstraktere tekst fra scanned dokumenter
 */
async function performOCR(pdfPath: string, orgnr: string, year: number): Promise<string | null> {
  try {
    debugLog(`[${orgnr}] Starter OCR på PDF for ${year}...`);
    debugLog(`[${orgnr}] PDF path: ${pdfPath}`);
    debugLog(`[${orgnr}] PDF eksisterer: ${fs.existsSync(pdfPath)}`);
    
    if (!fs.existsSync(pdfPath)) {
      debugLog(`[${orgnr}] ⚠️ PDF-fil eksisterer ikke: ${pdfPath}`);
      return null;
    }
    
    // Konverter første siden av PDF til bilde ved å bruke Ghostscript direkte
    const imagePath = path.join(PDF_TEMP_DIR, `${orgnr}_${year}.1.png`);
    
    debugLog(`[${orgnr}] Konverterer PDF side 1 til bilde ved å bruke Ghostscript...`);
    debugLog(`[${orgnr}] Output bilde: ${imagePath}`);
    
    try {
      // Bruk Ghostscript direkte: gs -dNOPAUSE -dBATCH -sDEVICE=png16m -r300 -dFirstPage=1 -dLastPage=1 -sOutputFile=output.png input.pdf
      const gsCommand = `gs -dNOPAUSE -dBATCH -sDEVICE=png16m -r300 -dFirstPage=1 -dLastPage=1 -sOutputFile="${imagePath}" "${pdfPath}"`;
      debugLog(`[${orgnr}] Kjører kommando: ${gsCommand}`);
      
      const { stdout, stderr } = await execAsync(gsCommand, {
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        timeout: 60000, // 60 sekunder timeout
      });
      
      if (stdout) {
        debugLog(`[${orgnr}] Ghostscript stdout: ${stdout}`);
      }
      if (stderr) {
        debugLog(`[${orgnr}] Ghostscript stderr: ${stderr}`);
      }
      
      debugLog(`[${orgnr}] PDF konvertert til bilde: ${imagePath}`);
    } catch (convertError: any) {
      debugLog(`[${orgnr}] ❌ Feil ved konvertering av PDF til bilde: ${convertError.message}`);
      if (convertError.stderr) {
        debugLog(`[${orgnr}] Ghostscript stderr: ${convertError.stderr}`);
      }
      if (convertError.stdout) {
        debugLog(`[${orgnr}] Ghostscript stdout: ${convertError.stdout}`);
      }
      debugLog(`[${orgnr}] Error stack: ${convertError.stack}`);
      debugLog(`[${orgnr}] Dette kan tyde på at Ghostscript ikke er installert. Installer med: sudo dnf install -y ghostscript`);
      return null;
    }
    
    debugLog(`[${orgnr}] Sjekker om bilde-fil eksisterer: ${imagePath}`);
    if (!fs.existsSync(imagePath)) {
      debugLog(`[${orgnr}] ⚠️ Bilde-fil eksisterer ikke: ${imagePath}`);
      // Prøv å finne filer i temp-mappen
      const filesInTemp = fs.readdirSync(PDF_TEMP_DIR);
      debugLog(`[${orgnr}] Filer i temp-mappen: ${filesInTemp.join(', ')}`);
      return null;
    }
    
    debugLog(`[${orgnr}] PDF konvertert til bilde: ${imagePath}`);
    
    // Utfør OCR på bildet med norsk språk
    debugLog(`[${orgnr}] Starter Tesseract OCR på bilde: ${imagePath}`);
    
    let worker;
    try {
      debugLog(`[${orgnr}] Oppretter Tesseract worker med norsk språk...`);
      // Bruk færre threads og reduser minnebruk
      worker = await createWorker('nor', 1, {
        logger: (m: { status: string; progress: number }) => {
          if (m.status === 'recognizing text') {
            debugLog(`[${orgnr}] OCR progress: ${Math.round(m.progress * 100)}%`);
          } else if (m.status) {
            debugLog(`[${orgnr}] OCR status: ${m.status}`);
          }
        },
        // Reduser minnebruk ved å bruke færre threads
        gzip: false,
      });
      debugLog(`[${orgnr}] Tesseract worker opprettet`);
    } catch (workerError) {
      debugLog(`[${orgnr}] ❌ Feil ved opprettelse av Tesseract worker: ${(workerError as Error).message}`);
      debugLog(`[${orgnr}] Error stack: ${(workerError as Error).stack}`);
      debugLog(`[${orgnr}] Dette kan tyde på at tesseract.js ikke kan laste ned sin binary. Prøv å installere tesseract manuelt eller sjekk internett-tilkobling.`);
      return null;
    }
    
    let ocrResult;
    try {
      debugLog(`[${orgnr}] Starter OCR-recognition på bilde...`);
      ocrResult = await worker.recognize(imagePath);
      debugLog(`[${orgnr}] OCR-recognition fullført`);
    } catch (recognizeError) {
      debugLog(`[${orgnr}] ❌ Feil ved OCR-recognition: ${(recognizeError as Error).message}`);
      debugLog(`[${orgnr}] Error stack: ${(recognizeError as Error).stack}`);
      try {
        await worker.terminate();
      } catch (e) {
        // Ignorer feil ved terminering
      }
      return null;
    }
    
    const text = ocrResult.data.text;
    debugLog(`[${orgnr}] OCR ekstraherte ${text.length} tegn`);
    
    // Log sample av OCR-teksten for debugging
    if (text && text.length > 0) {
      debugLog(`[${orgnr}] OCR-tekst sample (første 500 tegn): "${text.substring(0, 500)}"`);
      debugLog(`[${orgnr}] OCR-tekst inneholder "sum": ${text.toLowerCase().includes('sum')}`);
      debugLog(`[${orgnr}] OCR-tekst inneholder "inntekter": ${text.toLowerCase().includes('inntekter')}`);
      debugLog(`[${orgnr}] OCR-tekst inneholder "resultat": ${text.toLowerCase().includes('resultat')}`);
      
      // Prøv å finne tall i OCR-teksten
      const numbers = text.match(/([-]?\d{1,3}(?:\s?\d{3})*(?:\s?\d{3})*)/g);
      if (numbers && numbers.length > 0) {
        debugLog(`[${orgnr}] Fant ${numbers.length} tall i OCR-teksten. Første 10: ${numbers.slice(0, 10).join(', ')}`);
      }
    } else {
      debugLog(`[${orgnr}] ⚠️ OCR returnerte tom tekst!`);
    }
    
    try {
      await worker.terminate();
      debugLog(`[${orgnr}] Tesseract worker terminert`);
    } catch (terminateError) {
      debugLog(`[${orgnr}] ⚠️ Feil ved terminering av worker: ${(terminateError as Error).message}`);
    }
    
    // Rydd opp bilde-fil
    if (fs.existsSync(imagePath)) {
      try {
        fs.unlinkSync(imagePath);
        debugLog(`[${orgnr}] Bilde-fil slettet: ${imagePath}`);
      } catch (e) {
        debugLog(`[${orgnr}] ⚠️ Feil ved sletting av bilde-fil: ${(e as Error).message}`);
      }
    }
    
    debugLog(`[${orgnr}] OCR fullført. Ekstraherte ${text.length} tegn fra PDF for ${year}`);
    return text;
  } catch (error) {
    debugLog(`[${orgnr}] ❌ Feil ved OCR for ${year}: ${(error as Error).message}`);
    debugLog(`[${orgnr}] Error stack: ${(error as Error).stack}`);
    return null;
  }
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
  aarsresultat: number | null,
  salgsinntekt: number | null = null,
  sumInntekter: number | null = null
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
            ...(aarsresultat !== null ? { aarsresultat } : {}),
            ...(salgsinntekt !== null ? { salgsinntekt } : {}),
            ...(sumInntekter !== null ? { sumInntekter } : {}),
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
      
      const resultatregnskapResultat = raw.resultatregnskapResultat as Record<string, unknown>;
      if (aarsresultat !== null) {
        resultatregnskapResultat.aarsresultat = aarsresultat;
      }
      if (salgsinntekt !== null) {
        resultatregnskapResultat.salgsinntekt = salgsinntekt;
      }
      if (sumInntekter !== null) {
        resultatregnskapResultat.sumInntekter = sumInntekter;
      }
      
      await client.query(
        'UPDATE brreg_annual_reports SET data = $1 WHERE organisasjonsnummer = $2 AND ar = $3',
        [JSON.stringify(existingData), orgnr, year]
      );
    }
    
    const updates = [];
    if (aarsresultat !== null) updates.push(`årsresultat ${aarsresultat}`);
    if (salgsinntekt !== null) updates.push(`salgsinntekt ${salgsinntekt}`);
    if (sumInntekter !== null) updates.push(`sum inntekter ${sumInntekter}`);
    console.log(`[${orgnr}] Oppdaterte årsregnskap for ${year} med ${updates.join(', ')} i databasen`);
  } catch (error) {
    console.error(`[${orgnr}] Feil ved oppdatering av database for ${year}:`, (error as Error).message);
    throw error;
  } finally {
    await client.end();
  }
}

