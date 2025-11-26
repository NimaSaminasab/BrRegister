import axios from 'axios';
import { load, CheerioAPI } from 'cheerio';
import type { Element } from 'cheerio';
import dotenv from 'dotenv';
import pdf from 'pdf-parse';

import { createPostgresClient, getPostgresEnvConfig } from './postgres';

dotenv.config();

interface AnnualReportDocument {
  title: string;
  url: string;
  type?: string | null;
  size?: number | null;
  pdfText?: string;
  pdfNumPages?: number;
  pdfInfo?: Record<string, unknown>;
}

interface AnnualReportPayload extends Record<string, unknown> {
  source: 'next-data' | 'dom';
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

const BASE_URL = 'https://virksomhet.brreg.no/nb/oppslag/enheter';
const YEARS_TO_KEEP = 5;
const USER_AGENT = 'br-register-annual-report-scraper/1.0 (+https://github.com/NimaSaminasab/BrRegister)';
const YEAR_REGEX = /^(19|20)\d{2}$/;
const STATEMENT_YEAR_FIELDS = ['year', 'år', 'aar', 'ar', 'reportingYear', 'statementYear', 'arsregnskapAar'];

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

      const limited = reports
        .sort((a, b) => b.year - a.year)
        .slice(0, YEARS_TO_KEEP);

      for (const report of limited) {
        await upsertAnnualReport(client, orgnr, report);
      }

      processed += 1;
      console.log(`[${orgnr}] Lagret ${limited.length} årsrapporter (${processed}/${organisasjonsnumre.length})`);
    } catch (error) {
      console.error(`[${orgnr}] Klarte ikke å hente årsregnskap`, error);
    }
  }

  await client.end();
  console.log('✅ Ferdig med scraping av årsregnskap');
}

async function fetchOrgNumbers(client: ReturnType<typeof createPostgresClient>): Promise<string[]> {
  const result = await client.query<{ organisasjonsnummer: string }>(
    'SELECT organisasjonsnummer FROM brreg_companies ORDER BY organisasjonsnummer ASC',
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
  const url = `${BASE_URL}/${orgnr}`;
  const response = await axios.get<string>(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'nb',
    },
    timeout: 20000,
  });

  const $ = load(response.data);
  const fromNextData = await extractAnnualReportsFromNextData(orgnr, $);

  if (fromNextData.length) {
    return fromNextData;
  }

  return await extractAnnualReportsFromDom(orgnr, $);
}

async function extractAnnualReportsFromNextData(orgnr: string, $: CheerioAPI): Promise<AnnualReport[]> {
  const nextDataRaw = $('#__NEXT_DATA__').first().text().trim();

  if (!nextDataRaw) {
    console.log(`[${orgnr}] Ingen __NEXT_DATA__ funnet`);
    return [];
  }

  try {
    const nextData = JSON.parse(nextDataRaw);
    console.log(`[${orgnr}] Parset __NEXT_DATA__, søker etter årsregnskap...`);
    
    // Debug: Let's check if we can find any relevant keys
    const dataStr = JSON.stringify(nextData);
    if (dataStr.includes('arsregnskap') || dataStr.includes('årsregnskap') || dataStr.includes('financialStatement')) {
      console.log(`[${orgnr}] Fant potensielle årsregnskap-nøkler i __NEXT_DATA__`);
    }
    
    const statements = findFinancialStatementsInPayload(nextData);
    console.log(`[${orgnr}] Fant ${statements.length} finansielle rapporter i __NEXT_DATA__`);
    
    if (!statements.length) {
      return [];
    }

    const annualReports: AnnualReport[] = [];
    for (const statement of statements) {
      const year = extractYearFromStatement(statement);
      if (!year) {
        continue;
      }

      const documents = await buildDocumentsWithPdf(statement.documents ?? [], orgnr, year);
      annualReports.push({
        year,
        data: {
          source: 'next-data',
          summary: sanitizeSummary(statement),
          documents,
          raw: statement as Record<string, unknown>,
        },
      });
    }

    return dedupeReports(annualReports);
  } catch (error) {
    console.warn('Klarte ikke å parse __NEXT_DATA__', error);
    return [];
  }
}

function findFinancialStatementsInPayload(payload: unknown): RawFinancialStatement[] {
  const statements: RawFinancialStatement[] = [];
  const stack: unknown[] = [payload];

  while (stack.length) {
    const value = stack.pop();
    if (!value) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const child of value) {
        stack.push(child);
      }
      continue;
    }

    if (typeof value !== 'object') {
      continue;
    }

    const obj = value as Record<string, unknown>;

    if (isFinancialStatementObject(obj)) {
      statements.push(obj as RawFinancialStatement);
      continue;
    }

    for (const child of Object.values(obj)) {
      stack.push(child);
    }
  }

  return statements;
}

function isFinancialStatementObject(obj: Record<string, unknown>): boolean {
  if (!obj || typeof obj !== 'object') {
    return false;
  }

  const hasDocuments = Array.isArray(obj.documents);
  const hasYear = Boolean(extractYearFromStatement(obj));
  return hasDocuments && hasYear;
}

function extractYearFromStatement(statement: Record<string, unknown>): number | null {
  for (const key of STATEMENT_YEAR_FIELDS) {
    if (key in statement) {
      const raw = statement[key];
      const year = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
      if (!Number.isNaN(year) && YEAR_REGEX.test(String(year))) {
        return year;
      }
    }
  }

  if ('year' in statement) {
    const value = statement.year as number;
    if (!Number.isNaN(value)) {
      return value;
    }
  }

  const nested = (statement as RawFinancialStatement).summary;
  if (nested && typeof nested === 'object') {
    return extractYearFromStatement(nested as Record<string, unknown>);
  }

  return null;
}

function sanitizeSummary(statement: RawFinancialStatement): Record<string, unknown> | undefined {
  const summary = statement.summary;
  if (summary && typeof summary === 'object') {
    return summary as Record<string, unknown>;
  }
  return undefined;
}

async function buildDocumentsWithPdf(
  documents: RawFinancialDocument[],
  orgnr: string,
  year: number,
): Promise<AnnualReportDocument[]> {
  const result: AnnualReportDocument[] = [];

  for (const doc of documents) {
    const url = extractDocumentUrl(doc);
    if (!url) {
      continue;
    }

    const normalizedDoc: AnnualReportDocument = {
      title: doc.title ?? doc.name ?? doc.documentType ?? 'Dokument',
      url,
      type: doc.documentType ?? doc.type ?? null,
      size: doc.size ?? doc.fileSize ?? null,
    };

    try {
      const pdfData = await downloadAndParsePdf(url);
      normalizedDoc.pdfText = pdfData.text;
      normalizedDoc.pdfNumPages = pdfData.numPages;
      normalizedDoc.pdfInfo = pdfData.info;
    } catch (error) {
      console.warn(`[${orgnr}] Klarte ikke å laste ned PDF for ${year} (${normalizedDoc.title}):`, (error as Error).message);
    }

    result.push(normalizedDoc);
  }

  return result;
}

function extractDocumentUrl(doc: RawFinancialDocument): string | null {
  return doc.url ?? doc.href ?? doc.link ?? doc.downloadUrl ?? null;
}

async function downloadAndParsePdf(url: string): Promise<{ text: string; numPages: number; info: Record<string, unknown> }> {
  const response = await axios.get<ArrayBuffer>(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/pdf' },
    responseType: 'arraybuffer',
    timeout: 30000,
  });

  const buffer = Buffer.from(response.data);
  const parsed = await pdf(buffer);

  return {
    text: parsed.text?.trim() ?? '',
    numPages: parsed.numpages ?? 0,
    info: parsed.info ? (parsed.info as Record<string, unknown>) : {},
  };
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

async function extractAnnualReportsFromDom(orgnr: string, $: CheerioAPI): Promise<AnnualReport[]> {
  console.log(`[${orgnr}] Prøver DOM-ekstraksjon...`);
  
  // Try multiple selectors - the section might be in a div, article, or other container
  let possibleSections = $('section').filter((_: number, el: Element) => {
    const headingText = $(el).find('h2,h3,h4').first().text().toLowerCase();
    return headingText.includes('årsregnskap') || headingText.includes('arsregnskap');
  });

  // Also try divs with data attributes or specific classes
  if (!possibleSections.length) {
    possibleSections = $('div[class*="arsregnskap"], div[class*="årsregnskap"], article[class*="arsregnskap"]').filter((_: number, el: Element) => {
      const text = $(el).text().toLowerCase();
      return text.includes('årsregnskap') || text.includes('arsregnskap');
    });
  }

  // Look for any element containing "Årsregnskap" heading followed by year links
  if (!possibleSections.length) {
    $('h2, h3, h4, h5').each((_: number, heading: Element) => {
      const headingText = $(heading).text().toLowerCase();
      if (headingText.includes('årsregnskap') || headingText.includes('arsregnskap')) {
        const parent = $(heading).parent();
        if (parent.length) {
          possibleSections = possibleSections.add(parent);
        }
      }
    });
  }

  console.log(`[${orgnr}] Fant ${possibleSections.length} elementer med "årsregnskap"`);

  if (!possibleSections.length) {
    // Let's also check for any text containing "Årsregnskap" or years
    const allText = $('body').text().toLowerCase();
    if (allText.includes('årsregnskap') || allText.includes('arsregnskap')) {
      console.log(`[${orgnr}] Fant "årsregnskap" tekst i body, men ingen seksjon`);
      // Try to find years and links directly
      return await extractFromBodyText(orgnr, $);
    }
    return [];
  }

  const section = possibleSections.first();
  const reports: AnnualReport[] = [];

  for (const header of section.find('h3,h4,strong').toArray() as Element[]) {
    const headerText = $(header).text();
    const yearMatch = headerText.match(YEAR_REGEX);

    if (!yearMatch) {
      continue;
    }

    const year = Number(yearMatch[0]);
    const documents: AnnualReportDocument[] = [];
    const siblings = $(header).nextUntil('h3,h4,strong');

    const summary: Record<string, unknown> = {};

    siblings.find('dt').each((__: number, dt: Element) => {
      const key = $(dt).text().trim();
      const value = $(dt).next('dd').text().trim();
      if (key) {
        summary[key] = value;
      }
    });

    siblings.find('tr').each((__: number, row: Element) => {
      const cells = $(row).find('th,td');
      if (cells.length >= 2) {
        const key = $(cells[0]).text().trim();
        const value = $(cells[1]).text().trim();
        if (key) {
          summary[key] = value;
        }
      }
    });

    const link = siblings
      .find('a')
      .filter((__: number, anchor: Element) => $(anchor).text().toLowerCase().includes('innsendt årsregnskap'))
      .first()
      .attr('href');

    if (link) {
      try {
        const docs = await buildDocumentsWithPdf([{ title: 'Innsendt årsregnskap', url: link }], orgnr, year);
        documents.push(...docs);
      } catch (error) {
        console.warn(`[${orgnr}] Klarte ikke å hente PDF via DOM-lenke for ${year}:`, (error as Error).message);
      }
    }

    reports.push({
      year,
      data: {
        source: 'dom',
        summary,
        documents,
      },
    });
  }

  return reports;
}

async function extractFromBodyText(orgnr: string, $: CheerioAPI): Promise<AnnualReport[]> {
  console.log(`[${orgnr}] Prøver å finne årsregnskap direkte fra body-tekst...`);
  const reports: AnnualReport[] = [];
  const foundYears = new Set<number>();
  
  // Look for year patterns followed by "Innsendt årsregnskap" links
  $('a').each((_: number, anchor: Element) => {
    const linkText = $(anchor).text().toLowerCase();
    const href = $(anchor).attr('href');
    
    if (linkText.includes('innsendt årsregnskap') || linkText.includes('innsendt arsregnskap')) {
      // Try to find the year near this link
      const parent = $(anchor).closest('div, section, article, li');
      const parentText = parent.text();
      
      // Look for year in the parent element
      const yearMatch = parentText.match(/\b(20\d{2}|19\d{2})\b/);
      if (yearMatch && href && !foundYears.has(Number(yearMatch[0]))) {
        const year = Number(yearMatch[0]);
        if (year >= 2000 && year <= new Date().getFullYear()) {
          foundYears.add(year);
          console.log(`[${orgnr}] Fant årsregnskap for ${year} via lenke: ${href}`);
          reports.push({
            year,
            data: {
              source: 'body-text-link',
              documents: [{ title: 'Innsendt årsregnskap', url: href }],
            },
          });
        }
      }
    }
  });
  
  // Also look for year headings followed by links
  $('h3, h4, strong, b').each((_: number, heading: Element) => {
    const headingText = $(heading).text();
    const yearMatch = headingText.match(YEAR_REGEX);
    
    if (yearMatch && !foundYears.has(Number(yearMatch[0]))) {
      const year = Number(yearMatch[0]);
      const nextSibling = $(heading).next();
      const link = nextSibling.find('a').filter((_: number, a: Element) => {
        const text = $(a).text().toLowerCase();
        return text.includes('innsendt årsregnskap') || text.includes('innsendt arsregnskap');
      }).first();
      
      if (link.length) {
        const href = link.attr('href');
        if (href) {
          foundYears.add(year);
          console.log(`[${orgnr}] Fant årsregnskap for ${year} via overskrift + lenke: ${href}`);
          reports.push({
            year,
            data: {
              source: 'heading-link',
              documents: [{ title: 'Innsendt årsregnskap', url: href }],
            },
          });
        }
      }
    }
  });
  
  // Now fetch PDFs for all found reports
  const reportsWithPdfs: AnnualReport[] = [];
  for (const report of reports) {
    try {
      const documents = await buildDocumentsWithPdf(report.data.documents ?? [], orgnr, report.year);
      reportsWithPdfs.push({
        year: report.year,
        data: {
          ...report.data,
          documents,
        },
      });
    } catch (error) {
      console.warn(`[${orgnr}] Klarte ikke å hente PDF for ${report.year}:`, (error as Error).message);
      // Still add the report without PDF
      reportsWithPdfs.push(report);
    }
  }
  
  return dedupeReports(reportsWithPdfs);
}

main().catch((error) => {
  console.error('Uventet feil under scraping av årsregnskap', error);
  process.exit(1);
});

