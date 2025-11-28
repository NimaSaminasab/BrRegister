import axios, { AxiosError } from 'axios';

interface EnhetMetadata {
  stiftelsesdato?: string;
  stiftelsesdatoEnhetsregisteret?: string;
  sistInnsendtAarsregnskap?: string;
  sistInnsendtÅrsregnskap?: string;
  sistInnsendtArsregnskap?: string;
  sistInnsendtAarsregnskapEtterÅrstall?: string;
  sisteInnsendteÅr?: string;
  [key: string]: unknown;
}

export interface RegnskapApiEntry {
  year: number;
  documents: Array<Record<string, unknown>>;
  raw: Record<string, unknown>;
}

const REGNSKAP_API_BASE = 'https://data.brreg.no/regnskapsregisteret/regnskap';
const ENHETSREGISTERET_API_BASE = 'https://data.brreg.no/enhetsregisteret/api/enheter';
const DEFAULT_LOOKBACK_YEARS = 10;
const MIN_YEAR = 1990;

export async function fetchRegnskapApiEntries(orgnr: string, maxResults = 10): Promise<RegnskapApiEntry[]> {
  const { minYear, maxYear } = await deriveYearBounds(orgnr);
  const entries: RegnskapApiEntry[] = [];

  for (let year = maxYear; year >= minYear; year -= 1) {
    const entry = await fetchRegnskapForYear(orgnr, year);
    if (entry) {
      entries.push(entry);
      if (entries.length >= maxResults) {
        break;
      }
    }
  }

  return entries;
}

async function deriveYearBounds(orgnr: string): Promise<{ minYear: number; maxYear: number }> {
  const currentYear = new Date().getFullYear();
  let minYear = Math.max(MIN_YEAR, currentYear - DEFAULT_LOOKBACK_YEARS);
  let maxYear = currentYear;

  try {
    const metadata = await fetchCompanyMetadata(orgnr);
    const stiftYear = parseYear(metadata.stiftelsesdato || metadata.stiftelsesdatoEnhetsregisteret);
    if (stiftYear) {
      minYear = Math.max(stiftYear, MIN_YEAR);
    }

    const latestKeys = [
      'sistInnsendtAarsregnskap',
      'sistInnsendtÅrsregnskap',
      'sistInnsendtArsregnskap',
      'sistInnsendtAarsregnskapEtterÅrstall',
      'sisteInnsendteÅr',
    ];

    for (const key of latestKeys) {
      const value = metadata[key as keyof EnhetMetadata];
      const year = parseYear(value);
      if (year) {
        maxYear = Math.max(year, minYear);
        break;
      }
    }
  } catch (error) {
    console.warn(`[${orgnr}] Klarte ikke å hente metadata for årsspenn:`, (error as Error).message);
  }

  if (minYear > maxYear) {
    minYear = Math.max(MIN_YEAR, maxYear - DEFAULT_LOOKBACK_YEARS);
  }

  return { minYear, maxYear };
}

async function fetchCompanyMetadata(orgnr: string): Promise<EnhetMetadata> {
  const url = `${ENHETSREGISTERET_API_BASE}/${orgnr}`;
  const response = await axios.get<EnhetMetadata>(url, {
    headers: { Accept: 'application/json' },
    timeout: 10000,
  });
  return response.data || {};
}

async function fetchRegnskapForYear(orgnr: string, year: number): Promise<RegnskapApiEntry | null> {
  const params = [encodeURIComponent('år'), 'ar'];
  for (const paramKey of params) {
    const url = `${REGNSKAP_API_BASE}/${orgnr}?${paramKey}=${year}`;
    try {
      const response = await axios.get(url, {
        headers: { Accept: 'application/json' },
        timeout: 15000,
      });
      const normalized = normalizeRegnskapResponse(response.data, year);
      if (normalized) {
        return normalized;
      }
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 404) {
          continue;
        }
        console.warn(`[${orgnr}] Regnskapsregisteret API-feil (${year}):`, describeAxiosError(error));
      } else {
        console.warn(`[${orgnr}] Uventet API-feil (${year}):`, (error as Error).message);
      }
    }
  }
  return null;
}

function normalizeRegnskapResponse(data: unknown, fallbackYear: number): RegnskapApiEntry | null {
  if (!data) {
    return null;
  }

  const candidates = extractCandidateArray(data);
  if (!candidates.length) {
    return null;
  }

  for (const candidate of candidates) {
    const year = extractYearFromCandidate(candidate, fallbackYear);
    if (!year) {
      continue;
    }

    const documents = extractDocumentsFromCandidate(candidate);
    return {
      year,
      documents,
      raw: candidate,
    };
  }

  return null;
}

function extractCandidateArray(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) {
    return data.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object');
  }

  if (typeof data === 'object' && data !== null) {
    const record = data as Record<string, unknown>;
    if (Array.isArray(record.regnskap)) {
      return record.regnskap.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object');
    }
    return [record];
  }

  return [];
}

function extractYearFromCandidate(candidate: Record<string, unknown>, fallbackYear: number): number | null {
  const keys = ['regnskapsår', 'regnskapsar', 'regnskapsYear', 'år', 'ar', 'regnskapsAar'];
  for (const key of keys) {
    const year = parseYear(candidate[key]);
    if (year) {
      return year;
    }
  }
  
  // Prøv å hente året fra regnskapsperiode
  const periode = candidate.regnskapsperiode;
  if (periode && typeof periode === 'object') {
    const periodeObj = periode as Record<string, unknown>;
    const tilDato = periodeObj.tilDato || periodeObj.tilDato;
    const fraDato = periodeObj.fraDato || periodeObj.fraDato;
    const dateStr = String(tilDato || fraDato || '');
    const year = parseYear(dateStr);
    if (year) {
      return year;
    }
  }
  
  return parseYear(fallbackYear);
}

function extractDocumentsFromCandidate(candidate: Record<string, unknown>): Array<Record<string, unknown>> {
  const documents = candidate.dokumenter || candidate.documents || [];
  if (Array.isArray(documents)) {
    return documents.filter((doc): doc is Record<string, unknown> => Boolean(doc) && typeof doc === 'object');
  }
  return [];
}

function parseYear(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value);
  }

  if (typeof value === 'string') {
    const match = value.match(/(19|20)\d{2}/);
    if (match) {
      return Number(match[0]);
    }
  }

  return null;
}

function describeAxiosError(error: AxiosError): string {
  if (error.response) {
    return `status ${error.response.status} - ${JSON.stringify(error.response.data).slice(0, 200)}`;
  }
  if (error.request) {
    return 'ingen respons fra server';
  }
  return error.message;
}

