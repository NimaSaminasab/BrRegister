/**
 * Alternative approach: Prøv å hente alle årsregnskap via bulk-endepunkt eller journalnummer
 * 
 * Dette er en eksperimentell implementasjon som prøver alternative metoder
 * for å hente historiske årsregnskap når standard API ikke støtter det.
 */

import axios from 'axios';

const REGNSKAP_API_BASE = 'https://data.brreg.no/regnskapsregisteret';
const ENHETSREGISTERET_API_BASE = 'https://data.brreg.no/enhetsregisteret/api';

/**
 * Prøv å hente alle regnskap for en organisasjon uten å spesifisere år
 */
export async function fetchAllRegnskapForOrg(orgnr: string): Promise<unknown[]> {
  // Prøv ulike endepunkter
  const endpoints = [
    `/regnskap/${orgnr}`, // Uten år-parameter
    `/regnskap/${orgnr}/alle`, // Kanskje et "alle"-endepunkt
    `/regnskap?organisasjonsnummer=${orgnr}`, // Query-parameter
  ];

  for (const endpoint of endpoints) {
    try {
      const url = `${REGNSKAP_API_BASE}${endpoint}`;
      const response = await axios.get(url, {
        headers: { Accept: 'application/json' },
        timeout: 15000,
      });
      
      if (response.data) {
        const data = Array.isArray(response.data) ? response.data : [response.data];
        if (data.length > 0) {
          console.log(`[${orgnr}] Fant ${data.length} regnskap via ${endpoint}`);
          return data;
        }
      }
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        continue; // Prøv neste endepunkt
      }
      console.warn(`[${orgnr}] Feil ved ${endpoint}:`, (error as Error).message);
    }
  }

  return [];
}

/**
 * Prøv å hente regnskap via journalnummer (hvis vi har det)
 */
export async function fetchRegnskapByJournalNumber(journalnr: string | number): Promise<unknown | null> {
  try {
    const url = `${REGNSKAP_API_BASE}/regnskap/journal/${journalnr}`;
    const response = await axios.get(url, {
      headers: { Accept: 'application/json' },
      timeout: 15000,
    });
    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      return null;
    }
    console.warn(`Feil ved henting av journal ${journalnr}:`, (error as Error).message);
    return null;
  }
}

/**
 * Prøv å finne alle journalnummer for en organisasjon
 */
export async function findJournalNumbersForOrg(orgnr: string): Promise<(string | number)[]> {
  // Dette endepunktet eksisterer kanskje ikke, men verdt å prøve
  const endpoints = [
    `/regnskap/${orgnr}/journaler`,
    `/regnskap/${orgnr}/journalnummer`,
    `/regnskap/journaler?organisasjonsnummer=${orgnr}`,
  ];

  for (const endpoint of endpoints) {
    try {
      const url = `${REGNSKAP_API_BASE}${endpoint}`;
      const response = await axios.get(url, {
        headers: { Accept: 'application/json' },
        timeout: 15000,
      });
      
      if (response.data) {
        const data = Array.isArray(response.data) ? response.data : [response.data];
        const journalNumbers = data
          .map((item: unknown) => {
            if (typeof item === 'object' && item !== null) {
              const obj = item as Record<string, unknown>;
              return obj.journalnr || obj.journalnummer || obj.id;
            }
            return null;
          })
          .filter((jn: unknown): jn is string | number => jn !== null && jn !== undefined);
        
        if (journalNumbers.length > 0) {
          return journalNumbers;
        }
      }
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        continue;
      }
    }
  }

  return [];
}

