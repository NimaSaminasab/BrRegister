import * as fs from 'fs';
import * as path from 'path';
import pdf from 'pdf-parse';
import axios from 'axios';
import { createWorker } from 'tesseract.js';
import { fromPath } from 'pdf2pic';
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
              await updateAnnualReportInDatabase(orgnr, year, aarsresultat);
              return {
                aarsresultat,
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
    
    console.log(`[${orgnr}] Server Action respons status: ${serverActionResponse.status}`);
    console.log(`[${orgnr}] Response data størrelse: ${serverActionResponse.data ? (serverActionResponse.data as ArrayBuffer).byteLength : 0} bytes`);
    
    if (serverActionResponse.status !== 200) {
      const errorText = Buffer.from(serverActionResponse.data).toString('utf-8').substring(0, 200);
      console.error(`[${orgnr}] Server returnerte feil status ${serverActionResponse.status}: ${errorText}`);
      return {
        aarsresultat: null,
        success: false,
        message: `Server returnerte status ${serverActionResponse.status}: ${errorText}`,
      };
    }
    
    const responseData = Buffer.from(serverActionResponse.data);
    
    // Log første del av responsen for debugging
    const responsePreview = responseData.toString('utf-8', 0, Math.min(200, responseData.length));
    console.log(`[${orgnr}] Response preview (første 200 tegn): ${responsePreview}`);
    
    // Sjekk om det er en PDF
    if (!responseData.toString('utf-8', 0, 4).includes('%PDF') && responseData.length < 1000) {
      // Det ser ikke ut som en PDF, kan være en feilmelding
      const fullResponse = responseData.toString('utf-8');
      console.error(`[${orgnr}] Respons ser ikke ut som en PDF. Full respons: ${fullResponse.substring(0, 500)}`);
      return {
        aarsresultat: null,
        success: false,
        message: `Server returnerte ikke en PDF. Respons: ${fullResponse.substring(0, 200)}`,
      };
    }
    
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
    
    // Hvis PDF-parsing feilet, prøv å se om vi kan finne journalnummer og hente via API
    if (pdfResult.message.includes('for kort') || pdfResult.message.includes('tom')) {
      console.log(`[${orgnr}] PDF-parsing feilet for ${year}, prøver å finne journalnummer og hente via API...`);
      
      // Prøv å hente alle regnskap for organisasjonsnummeret og finne det riktige året
      try {
        const allRegnskapUrl = `https://data.brreg.no/regnskapsregisteret/regnskap/${orgnr}`;
        const allRegnskapResponse = await axios.get(allRegnskapUrl, {
          headers: { Accept: 'application/json' },
          timeout: 10000,
          validateStatus: (status: number) => status === 200 || status === 404,
        });
        
        if (allRegnskapResponse.status === 200 && allRegnskapResponse.data) {
          const allRegnskap = Array.isArray(allRegnskapResponse.data) 
            ? allRegnskapResponse.data 
            : [allRegnskapResponse.data];
          
          // Finn regnskap for det spesifikke året
          for (const regnskap of allRegnskap) {
            if (!regnskap || typeof regnskap !== 'object') continue;
            
            const periode = regnskap.regnskapsperiode as Record<string, unknown> | undefined;
            const tilDato = periode?.tilDato as string | undefined;
            let regnskapYear: number | null = null;
            
            if (tilDato && typeof tilDato === 'string') {
              const yearMatch = tilDato.match(/(\d{4})/);
              if (yearMatch) {
                regnskapYear = parseInt(yearMatch[1], 10);
              }
            }
            
            if (regnskapYear === year) {
              const aarsresultat = extractAarsresultatFromJson(regnskap);
              if (aarsresultat !== null) {
                console.log(`[${orgnr}] ✅ Fant årsresultat ${aarsresultat} via alle regnskap API for ${year}`);
                await updateAnnualReportInDatabase(orgnr, year, aarsresultat);
                return {
                  aarsresultat,
                  success: true,
                  message: `Fant årsresultat ${aarsresultat} via alle regnskap API`,
                };
              }
            }
          }
        }
      } catch (fallbackError) {
        console.log(`[${orgnr}] Fallback API-henting feilet:`, (fallbackError as Error).message);
      }
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
    console.log(`[${orgnr}] Parser PDF-buffer (størrelse: ${pdfBuffer.length} bytes) for ${year}...`);
    
    // Sjekk om responsen inneholder feilmelding
    const responseText = pdfBuffer.toString('utf-8', 0, Math.min(500, pdfBuffer.length));
    console.log(`[${orgnr}] Første 500 tegn av respons: ${responseText.substring(0, 200)}...`);
    
    if (responseText.includes('Server action not found') || responseText.includes('error') || responseText.includes('Error')) {
      const fullError = responseText.substring(0, 200);
      console.error(`[${orgnr}] Server Action returnerte feilmelding: ${fullError}`);
      return {
        aarsresultat: null,
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
          message: `Ingen PDF funnet i respons. Respons: ${responseText.substring(0, 200)}`,
        };
      } else {
        console.warn(`[${orgnr}] Ingen PDF funnet i respons for ${year} (respons størrelse: ${pdfBuffer.length} bytes)`);
        return {
          aarsresultat: null,
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
            const ocrText = await performOCR(tempPdfPath, orgnr, year);
            if (ocrText && ocrText.length > 100) {
              console.log(`[${orgnr}] OCR ekstraherte ${ocrText.length} tegn fra PDF for ${year}`);
              const aarsresultat = extractAarsresultatFromPdfText(ocrText, orgnr, year);
              if (aarsresultat !== null) {
                // Oppdater database med det ekstraherte årsresultatet
                await updateAnnualReportInDatabase(orgnr, year, aarsresultat);
                
                // Slett temp-fil
                if (fs.existsSync(tempPdfPath)) {
                  fs.unlinkSync(tempPdfPath);
                }
                return {
                  aarsresultat,
                  message: `Fant årsresultat ${aarsresultat} via OCR`,
                };
              } else {
                console.log(`[${orgnr}] OCR ekstraherte tekst, men kunne ikke finne årsresultat`);
              }
            } else {
              console.log(`[${orgnr}] OCR ekstraherte lite tekst (${ocrText?.length || 0} tegn)`);
            }
          } catch (ocrError) {
            console.warn(`[${orgnr}] OCR feilet:`, (ocrError as Error).message);
          }
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
                      return {
                        aarsresultat,
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
        
        // Vis hele PDF-teksten i feilmeldingen (kan være viktig for debugging)
        const fullText = pdfText.replace(/"/g, '\\"').replace(/\n/g, '\\n').substring(0, 200);
        const hexPreview = Buffer.from(pdfText).toString('hex').substring(0, 100);
        
        let message = `PDF-tekst er for kort (${pdfText.length} tegn). `;
        message += `Innhold: "${fullText}". `;
        message += `Hex: ${hexPreview}... `;
        
        if (pdfHasContent) {
          message += `PDF-filen er ${pdfData.length} bytes, men inneholder lite eller ingen tekst. Dette kan tyde på at PDF-en kun inneholder bilder/scanned dokumenter som krever OCR.`;
        } else {
          message += `PDF-filen er også liten (${pdfData.length} bytes), noe som tyder på at PDF-en ikke ble lastet ned korrekt eller er en feilmelding.`;
        }
        
        return {
          aarsresultat: null,
          message,
        };
      }
      
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
  
  // Søk etter linjer som inneholder resultat-relaterte ord
  const resultatKeywords = ['årsresultat', 'resultatregnskap', 'nettoresultat', 'resultat etter skatt', 'resultat for året'];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toLowerCase();
    
    // Sjekk om linjen inneholder noen av nøkkelordene
    const hasKeyword = resultatKeywords.some(keyword => line.includes(keyword));
    
    if (hasKeyword || (line.includes('resultat') && (line.includes('år') || line.includes('året')))) {
      console.log(`[${orgnr}] Fant "resultat"-linje ${i + 1} for ${year}: "${line.substring(0, 100)}"`);
      
      // Se på samme linje og neste linjer for å finne et tall
      for (let j = Math.max(0, i - 1); j < Math.min(i + 5, lines.length); j++) {
        // Prøv å finne tall med tusen-separatorer (mellomrom, punktum, komma)
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
  
  // Siste forsøk: Søk etter store tall i nærheten av "resultat" eller "regnskap"
  console.log(`[${orgnr}] Prøver siste forsøk: søker etter store tall nær "resultat" eller "regnskap"...`);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toLowerCase();
    if (line.includes('resultat') || line.includes('regnskap')) {
      // Se på linjer i nærheten
      for (let j = Math.max(0, i - 2); j < Math.min(i + 3, lines.length); j++) {
        // Prøv å finne alle tall i linjen
        const allNumbers = lines[j].match(/([-]?\d{1,3}(?:\s?\d{3})*(?:\s?\d{3})*)/g);
        if (allNumbers) {
          for (const numStr of allNumbers) {
            let cleanedValue = numStr.replace(/\s+/g, '').replace(/\./g, '').replace(/,/g, '');
            const parsedValue = parseInt(cleanedValue, 10);
            // Årsresultat er vanligvis et stort tall (minst 1000, men kan være negativt)
            if (!isNaN(parsedValue) && Math.abs(parsedValue) > 1000) {
              console.log(`[${orgnr}] ✅ Fant mulig årsresultat ${parsedValue} i PDF-teksten (linje ${j + 1}, nær "resultat/regnskap") for ${year}`);
              return parsedValue;
            }
          }
        }
      }
    }
  }
  
  console.log(`[${orgnr}] ⚠️ Kunne ikke finne årsresultat i PDF-teksten for ${year}`);
  return null;
}

/**
 * Utfører OCR på PDF for å ekstraktere tekst fra scanned dokumenter
 */
async function performOCR(pdfPath: string, orgnr: string, year: number): Promise<string | null> {
  try {
    console.log(`[${orgnr}] Starter OCR på PDF for ${year}...`);
    
    // Konverter første siden av PDF til bilde
    const options = {
      density: 300,           // Høy oppløsning for bedre OCR
      saveFilename: `${orgnr}_${year}`,
      savePath: PDF_TEMP_DIR,
      format: 'png',
      width: 2000,
      height: 2000,
    };
    
    const convert = fromPath(pdfPath, options);
    const imageResult = await convert(1, { responseType: 'image' }); // Konverter første side
    
    // pdf2pic returnerer et objekt med path eller buffer
    let imagePath: string;
    if (typeof imageResult === 'string') {
      imagePath = imageResult;
    } else if (imageResult && typeof imageResult === 'object' && 'path' in imageResult) {
      imagePath = (imageResult as { path: string }).path;
    } else {
      console.warn(`[${orgnr}] Kunne ikke konvertere PDF til bilde for ${year}`);
      return null;
    }
    
    if (!imagePath || !fs.existsSync(imagePath)) {
      console.warn(`[${orgnr}] Bilde-fil eksisterer ikke: ${imagePath}`);
      return null;
    }
    
    console.log(`[${orgnr}] PDF konvertert til bilde: ${imagePath}`);
    
    // Utfør OCR på bildet med norsk språk
    const worker = await createWorker('nor', 1, {
      logger: (m: { status: string; progress: number }) => {
        if (m.status === 'recognizing text') {
          console.log(`[${orgnr}] OCR progress: ${Math.round(m.progress * 100)}%`);
        }
      },
    });
    
    const { data: { text } } = await worker.recognize(imagePath);
    await worker.terminate();
    
    // Rydd opp bilde-fil
    if (fs.existsSync(imagePath)) {
      try {
        fs.unlinkSync(imagePath);
      } catch (e) {
        // Ignorer feil ved sletting
      }
    }
    
    console.log(`[${orgnr}] OCR fullført. Ekstraherte ${text.length} tegn fra PDF for ${year}`);
    return text;
  } catch (error) {
    console.error(`[${orgnr}] Feil ved OCR for ${year}:`, (error as Error).message);
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

