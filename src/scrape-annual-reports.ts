import axios from 'axios';
import { load, CheerioAPI } from 'cheerio';
import type { Element } from 'cheerio';
import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import pdf from 'pdf-parse';
import puppeteer from 'puppeteer';

import { createPostgresClient, getPostgresEnvConfig } from './postgres';
import { fetchRegnskapApiEntries } from './regnskap-api';

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
  source: 'next-data' | 'dom' | 'body-text-link' | 'heading-link' | 'element-search' | 'regex-pattern' | 'puppeteer-js' | 'regnskap-api';
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
const BASE_DOMAIN = 'https://virksomhet.brreg.no';
const YEARS_TO_KEEP = 5;
const USER_AGENT = 'br-register-annual-report-scraper/1.0 (+https://github.com/NimaSaminasab/BrRegister)';
const YEAR_REGEX = /^(19|20)\d{2}$/;
const STATEMENT_YEAR_FIELDS = ['year', 'år', 'aar', 'ar', 'reportingYear', 'statementYear', 'arsregnskapAar'];
const PDF_TEMP_DIR = path.join(__dirname, '../temp-pdfs');

function isPlaceholderUrl(url?: string | null): boolean {
  if (!url) {
    return true;
  }

  const normalized = url.trim().toLowerCase();
  return (
    !normalized ||
    normalized === '#' ||
    normalized.startsWith('javascript:') ||
    normalized.startsWith('about:')
  );
}

function normalizeDocumentUrl(rawUrl?: string | null): string | null {
  if (!rawUrl || isPlaceholderUrl(rawUrl)) {
    return null;
  }

  const trimmed = rawUrl.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  if (trimmed.startsWith('//')) {
    return `https:${trimmed}`;
  }

  if (trimmed.startsWith('/')) {
    return `${BASE_DOMAIN}${trimmed}`;
  }

  return `${BASE_DOMAIN}/${trimmed.replace(/^\/+/, '')}`;
}

function isLikelyPdfUrl(rawUrl?: string | null): boolean {
  if (!rawUrl || isPlaceholderUrl(rawUrl)) {
    return false;
  }

  const value = rawUrl.trim().toLowerCase();
  return value.includes('.pdf');
}

async function main() {
  // Opprett temp-mappe for PDF-filer hvis den ikke eksisterer
  if (!fs.existsSync(PDF_TEMP_DIR)) {
    fs.mkdirSync(PDF_TEMP_DIR, { recursive: true });
  }

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
  
  // Rydd opp eventuelle gjenværende PDF-filer i temp-mappen
  try {
    const remainingFiles = fs.readdirSync(PDF_TEMP_DIR);
    for (const file of remainingFiles) {
      const filePath = path.join(PDF_TEMP_DIR, file);
      try {
        fs.unlinkSync(filePath);
        console.log(`Slettet gjenværende fil: ${file}`);
      } catch (error) {
        console.warn(`Klarte ikke å slette ${file}:`, (error as Error).message);
      }
    }
    // Prøv å slette mappen hvis den er tom
    try {
      fs.rmdirSync(PDF_TEMP_DIR);
    } catch {
      // Ignorer hvis mappen ikke er tom eller ikke kan slettes
    }
  } catch (error) {
    // Ignorer feil ved opprydding
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
  
  // Hvis vi har API-data, prøv alltid å hente PDF-lenker fra virksomhetssiden
  // Dette sikrer at vi får PDF-lenker selv om API-et ikke gir dem direkte
  if (apiReports.length) {
    console.log(`[${orgnr}] Fant ${apiReports.length} årsregnskap via Regnskapsregisteret API, søker etter PDF-lenker fra virksomhetssiden...`);
    
    // Sjekk først om API-rapportene allerede har PDF-lenker som er lastet ned
    const hasPdfData = apiReports.some(report => 
      report.data.documents?.some(doc => doc.pdfText || (doc.url && isLikelyPdfUrl(doc.url) && doc.pdfText))
    );
    
    if (!hasPdfData) {
      // Prøv å hente PDF-lenker fra virksomhetssiden og legge dem til eksisterende rapporter
      try {
        const pdfReports = await extractPdfLinksFromVirksomhetPage(orgnr, apiReports);
        if (pdfReports.length > 0) {
          // Sjekk om vi faktisk fikk PDF-lenker
          const hasPdfLinks = pdfReports.some(report => 
            report.data.documents?.some(doc => doc.url && isLikelyPdfUrl(doc.url))
          );
          
          if (hasPdfLinks) {
            console.log(`[${orgnr}] Fant PDF-lenker fra virksomhetssiden, laster ned...`);
            return pdfReports;
          }
        }
      } catch (error) {
        console.warn(`[${orgnr}] Feil ved henting av PDF-lenker fra virksomhetssiden:`, (error as Error).message);
      }
    } else {
      console.log(`[${orgnr}] API-rapporter har allerede PDF-data, bruker dem`);
      return apiReports;
    }
    
    // Hvis vi ikke fant PDF-lenker, returner API-rapportene uansett
    console.log(`[${orgnr}] Ingen PDF-lenker funnet på virksomhetssiden, bruker API-data`);
    return apiReports;
  }

  const url = `${BASE_URL}/${orgnr}`;
  
  console.log(`[${orgnr}] Bruker Puppeteer for å laste dynamisk innhold...`);
  
  // Use Puppeteer to get the fully rendered page
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  
  try {
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'nb-NO,nb;q=0.9',
    });
    
    // Navigate and wait for content to load
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    
    // Wait a bit more for any lazy-loaded content
    await new Promise((resolve) => setTimeout(resolve, 2000));
    
    // Try to expand the "Årsregnskap" section if it's collapsed
    try {
      // Look for button/link containing "årsregnskap" text using XPath
      const buttons = await page.$x("//button[contains(translate(text(), 'Å', 'å'), 'årsregnskap')] | //a[contains(translate(text(), 'Å', 'å'), 'årsregnskap')] | //div[@role='button' and contains(translate(text(), 'Å', 'å'), 'årsregnskap')]");
      for (const button of buttons) {
        try {
          await button.click();
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } catch (e) {
          // Ignore click errors
        }
      }
    } catch (error) {
      // Button might not exist or already expanded
      console.log(`[${orgnr}] Kunne ikke ekspandere årsregnskap-seksjon (kan allerede være åpen)`);
    }
    
    // Wait for any dynamic content to load
    await new Promise((resolve) => setTimeout(resolve, 2000));
    
    // Try to extract PDF links directly from the page using JavaScript
    const pdfLinks = await page.evaluate(() => {
      const links: Array<{ year: number; url: string; text: string }> = [];
      const allLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>('a'));

      for (const link of allLinks) {
        const href = link.getAttribute('href');
        const text = link.textContent?.toLowerCase() ?? '';

        if (!href) {
          continue;
        }

        const normalizedHref = href.trim();
        const lowerHref = normalizedHref.toLowerCase();

        if (
          !normalizedHref ||
          normalizedHref === '#' ||
          normalizedHref.startsWith('#') ||
          lowerHref.startsWith('javascript:') ||
          lowerHref.startsWith('about:')
        ) {
          continue;
        }

        if (!lowerHref.includes('.pdf')) {
          continue;
        }

        let year: number | null = null;
        let parent: Element | null = link.parentElement;
        let depth = 0;

        while (parent && depth < 5) {
          const parentText = parent.textContent ?? '';
          const yearMatch = parentText.match(/\b(20\d{2})\b/);
          if (yearMatch) {
            const candidateYear = parseInt(yearMatch[1], 10);
            if (candidateYear >= 2000 && candidateYear <= new Date().getFullYear()) {
              year = candidateYear;
              break;
            }
          }
          parent = parent.parentElement;
          depth += 1;
        }

        if (!year && link.parentElement) {
          const siblings = Array.from(link.parentElement.children);
          for (const sibling of siblings) {
            const siblingText = sibling.textContent ?? '';
            const yearMatch = siblingText.match(/\b(20\d{2})\b/);
            if (yearMatch) {
              const candidateYear = parseInt(yearMatch[1], 10);
              if (candidateYear >= 2000 && candidateYear <= new Date().getFullYear()) {
                year = candidateYear;
                break;
              }
            }
          }
        }

        if (year) {
          const absoluteUrl = normalizedHref.startsWith('http')
            ? normalizedHref
            : new URL(normalizedHref, window.location.origin).toString();
          links.push({ year, url: absoluteUrl, text: link.textContent ?? '' });
        }
      }

      return links;
    });
    
    if (pdfLinks.length > 0) {
      console.log(`[${orgnr}] Fant ${pdfLinks.length} PDF-lenker via JavaScript-evaluering`);
      const reports: AnnualReport[] = [];
      const seenYears = new Set<number>();
      
      for (const link of pdfLinks) {
        if (!seenYears.has(link.year)) {
          seenYears.add(link.year);
          const absoluteUrl = normalizeDocumentUrl(link.url);
          if (!absoluteUrl || !isLikelyPdfUrl(absoluteUrl)) {
            continue;
          }

          console.log(`[${orgnr}] Fant årsregnskap for ${link.year}: ${absoluteUrl}`);
          reports.push({
            year: link.year,
            data: {
              source: 'puppeteer-js',
              documents: [{ title: 'Innsendt årsregnskap', url: absoluteUrl }],
            },
          });
        }
      }
      
      if (reports.length > 0) {
        await enrichReportsWithPdfData(reports, orgnr);
        await browser.close();
        return reports;
      }
    }
    
    // Get the fully rendered HTML
    const html = await page.content();
    await browser.close();
    
    const $ = load(html);
    
    const fromNextData = await extractAnnualReportsFromNextData(orgnr, $);

    if (fromNextData.length) {
      await enrichReportsWithPdfData(fromNextData, orgnr);
      return fromNextData;
    }

    const fromDom = await extractAnnualReportsFromDom(orgnr, $);
    if (fromDom.length) {
      await enrichReportsWithPdfData(fromDom, orgnr);
      return fromDom;
    }

    const fromBody = await extractFromBodyText(orgnr, $);
    if (fromBody.length) {
      await enrichReportsWithPdfData(fromBody, orgnr);
      return fromBody;
    }

    console.warn(`[${orgnr}] Fant ingen årsregnskap i HTML-kilden`);
    return [];
  } catch (error) {
    await browser.close();
    console.error(`[${orgnr}] Feil med Puppeteer, prøver vanlig HTTP:`, (error as Error).message);
    
    // Fallback to regular HTTP request
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
      await enrichReportsWithPdfData(fromNextData, orgnr);
      return fromNextData;
    }

    const fromDom = await extractAnnualReportsFromDom(orgnr, $);
    if (fromDom.length) {
      await enrichReportsWithPdfData(fromDom, orgnr);
      return fromDom;
    }

    const fromBody = await extractFromBodyText(orgnr, $);
    if (fromBody.length) {
      await enrichReportsWithPdfData(fromBody, orgnr);
      return fromBody;
    }

    console.warn(`[${orgnr}] Fant ingen årsregnskap i fallback HTML-respons`);
    return [];
  }
}

async function extractPdfLinksFromVirksomhetPage(orgnr: string, existingReports: AnnualReport[]): Promise<AnnualReport[]> {
  const url = `${BASE_URL}/${orgnr}`;
  let browser;
  
  try {
    console.log(`[${orgnr}] Starter Puppeteer for å hente PDF-lenker...`);
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'nb-NO,nb;q=0.9',
    });
    
    console.log(`[${orgnr}] Går til ${url}...`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise((resolve) => setTimeout(resolve, 2000));
    
    // Prøv å ekspandere årsregnskap-seksjon - prøv flere metoder
    console.log(`[${orgnr}] Prøver å ekspandere årsregnskap-seksjon...`);
    
    // Sett opp nettverksmonitorering FØR vi klikker for å fange opp PDF-er
    const networkPdfUrls: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const responseHandler = (response: any) => {
      const url = response.url();
      const contentType = response.headers()['content-type'] || '';
      if (url.includes('.pdf') || contentType.includes('application/pdf')) {
        networkPdfUrls.push(url);
        console.log(`[${orgnr}] ✅ Fant PDF i nettverksforespørsel: ${url.substring(0, 150)}`);
      }
    };
    page.on('response', responseHandler);
    
    try {
      // Metode 1: Bruk evaluate for å finne og klikke på elementer med årsregnskap-tekst
      await page.evaluate(() => {
        // Finn alle klikkbare elementer
        const allClickable = Array.from(document.querySelectorAll('button, [role="button"], a, .accordion, .collapse, [aria-expanded], [data-toggle="collapse"], [aria-controls]'));
        
        for (const el of allClickable) {
          const text = el.textContent?.toLowerCase() || '';
          const ariaLabel = el.getAttribute('aria-label')?.toLowerCase() || '';
          const title = el.getAttribute('title')?.toLowerCase() || '';
          const combinedText = `${text} ${ariaLabel} ${title}`;
          
          if (combinedText.includes('årsregnskap') || combinedText.includes('arsregnskap') || combinedText.includes('regnskap') || combinedText.includes('årsresultat')) {
            try {
              (el as HTMLElement).click();
            } catch (e) {
              // Ignore click errors
            }
          }
        }
      });
      
      await new Promise((resolve) => setTimeout(resolve, 3000));
      
      // Metode 2: Prøv å finne og klikke på alle år-lenker (f.eks. "2024", "2023", etc.)
      await page.evaluate(() => {
        const allLinks = Array.from(document.querySelectorAll('a, button'));
        const currentYear = new Date().getFullYear();
        
        for (const link of allLinks) {
          const text = link.textContent?.trim() || '';
          const yearMatch = text.match(/^(20\d{2}|19\d{2})$/);
          
          if (yearMatch) {
            const year = parseInt(yearMatch[0], 10);
            // Klikk på år mellom 2000 og i år
            if (year >= 2000 && year <= currentYear) {
              try {
                (link as HTMLElement).click();
              } catch (e) {
                // Ignore
              }
            }
          }
        }
      });
      
      await new Promise((resolve) => setTimeout(resolve, 3000));
      
      // Metode 2: Prøv å finne og klikke på alle ekspanderbare elementer
      const expandableElements = await page.evaluate(() => {
        const elements: Array<{ selector: string; text: string }> = [];
        const allElements = Array.from(document.querySelectorAll('button, [role="button"], .accordion, .collapse, [aria-expanded], [data-toggle="collapse"]'));
        for (const el of allElements) {
          const text = el.textContent?.toLowerCase() || '';
          if (text.includes('årsregnskap') || text.includes('arsregnskap') || text.includes('regnskap')) {
            const tagName = el.tagName.toLowerCase();
            const className = (el.className && typeof el.className === 'string') ? el.className : '';
            const id = el.id || '';
            let selector = tagName;
            if (id) selector += `#${id}`;
            if (className) {
              const firstClass = className.split(' ')[0];
              if (firstClass) selector += `.${firstClass}`;
            }
            elements.push({ selector, text: el.textContent?.substring(0, 50) || '' });
          }
        }
        return elements;
      });
      
      for (const elem of expandableElements) {
        try {
          const element = await page.$(elem.selector);
          if (element) {
            await element.click();
            await new Promise((resolve) => setTimeout(resolve, 1500));
            console.log(`[${orgnr}] Klikket på element: ${elem.selector.substring(0, 50)}`);
          }
        } catch (e) {
          // Ignore
        }
      }
    } catch (error) {
      console.warn(`[${orgnr}] Feil ved ekspandering av årsregnskap-seksjon:`, (error as Error).message);
    }
    
    // Vent lenger for at dynamisk innhold skal laste
    await new Promise((resolve) => setTimeout(resolve, 3000));
    
    // Scroll ned på siden for å trigge lazy-loading
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
    await new Promise((resolve) => setTimeout(resolve, 2000));
    
    // Scroll tilbake opp
    await page.evaluate(() => {
      window.scrollTo(0, 0);
    });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    
    // Finn PDF-lenker - prøv flere metoder
    const pdfLinks = await page.evaluate(() => {
      const links: Array<{ year: number; url: string; text: string }> = [];
      const allLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>('a'));

      for (const link of allLinks) {
        const href = link.getAttribute('href');
        const linkText = link.textContent?.toLowerCase() || '';
        if (!href) continue;

        const normalizedHref = href.trim();
        const lowerHref = normalizedHref.toLowerCase();

        if (normalizedHref === '#' || normalizedHref.startsWith('#') || 
            lowerHref.startsWith('javascript:') || lowerHref.startsWith('about:')) {
          continue;
        }

        // Sjekk om det er en PDF-lenke - kun aksepter faktiske PDF-lenker
        // Ikke lenker til informasjonssider
        const isPdf = lowerHref.includes('.pdf');
        
        // Hvis det ikke er en direkte PDF-lenke, hopp over
        if (!isPdf) {
          continue;
        }

        let year: number | null = null;
        let parent: Element | null = link.parentElement;
        let depth = 0;

        while (parent && depth < 5) {
          const parentText = parent.textContent ?? '';
          const yearMatch = parentText.match(/\b(20\d{2})\b/);
          if (yearMatch) {
            const candidateYear = parseInt(yearMatch[1], 10);
            if (candidateYear >= 2000 && candidateYear <= new Date().getFullYear()) {
              year = candidateYear;
              break;
            }
          }
          parent = parent.parentElement;
          depth += 1;
        }

        if (year) {
          const absoluteUrl = normalizedHref.startsWith('http')
            ? normalizedHref
            : new URL(normalizedHref, window.location.origin).toString();
          links.push({ year, url: absoluteUrl, text: link.textContent ?? '' });
        } else {
          // Hvis vi ikke fant år, men det ser ut som en PDF-lenke, prøv å finne år i nærheten
          // Sjekk om det er årsregnskap-tekst i nærheten
          let parent: Element | null = link.parentElement;
          let searchDepth = 0;
          while (parent && searchDepth < 10) {
            const parentText = parent.textContent || '';
            const yearMatch = parentText.match(/\b(20\d{2}|19\d{2})\b/);
            if (yearMatch) {
              const candidateYear = parseInt(yearMatch[1], 10);
              if (candidateYear >= 2000 && candidateYear <= new Date().getFullYear()) {
                const absoluteUrl = normalizedHref.startsWith('http')
                  ? normalizedHref
                  : new URL(normalizedHref, window.location.origin).toString();
                links.push({ year: candidateYear, url: absoluteUrl, text: link.textContent ?? '' });
                break;
              }
            }
            parent = parent.parentElement;
            searchDepth++;
          }
        }
      }

      return links;
    });
    
    const totalLinks = await page.evaluate(() => document.querySelectorAll('a').length);
    console.log(`[${orgnr}] Totalt antall lenker på siden: ${totalLinks}`);
    console.log(`[${orgnr}] Fant ${pdfLinks.length} PDF-lenker via DOM-søk`);
    console.log(`[${orgnr}] Fant ${networkPdfUrls.length} PDF-lenker via nettverksforespørsler`);
    
    // Legg til PDF-lenker fra nettverksforespørsler
    for (const pdfUrl of networkPdfUrls) {
      // Prøv å finne år i URL-en eller fra eksisterende rapporter
      const yearMatch = pdfUrl.match(/(\d{4})/);
      const year = yearMatch ? parseInt(yearMatch[1], 10) : null;
      if (year && year >= 2000 && year <= new Date().getFullYear()) {
        const existingLink = pdfLinks.find((l: { year: number; url: string; text: string }) => l.url === pdfUrl);
        if (!existingLink) {
          pdfLinks.push({ year, url: pdfUrl, text: 'PDF fra nettverksforespørsel' });
        }
      }
    }
    
    console.log(`[${orgnr}] Totalt ${pdfLinks.length} PDF-lenker funnet (DOM + nettverk)`);
    if (pdfLinks.length > 0) {
      console.log(`[${orgnr}] PDF-lenker funnet:`, pdfLinks.map((l: { year: number; url: string; text: string }) => `${l.year}: ${l.url.substring(0, 80)}...`).join(', '));
    }
    
    if (browser) {
      await browser.close();
    }
    
    // Kombiner eksisterende rapporter med PDF-lenker
    const reportsMap = new Map<number, AnnualReport>();
    
    // Legg til eksisterende rapporter
    for (const report of existingReports) {
      reportsMap.set(report.year, { ...report });
    }
    
    // Legg til PDF-lenker
    for (const link of pdfLinks) {
      const absoluteUrl = normalizeDocumentUrl(link.url);
      if (!absoluteUrl) {
        continue;
      }
      
      // Hvis URL-en ikke er en direkte PDF-lenke, men ser ut som en årsregnskap-lenke,
      // prøv å finne PDF-lenker på den siden
      if (!isLikelyPdfUrl(absoluteUrl)) {
        // Dette er sannsynligvis en lenke til en informasjonsside, ikke en direkte PDF
        // Vi kan hoppe over den for nå, eller prøve å følge lenken (men det tar tid)
        console.log(`[${orgnr}] Hopper over ikke-PDF lenke for ${link.year}: ${absoluteUrl.substring(0, 80)}...`);
        continue;
      }
      
      const existingReport = reportsMap.get(link.year);
      if (existingReport) {
        // Legg til PDF-lenke i eksisterende rapport
        const hasPdf = existingReport.data.documents.some(d => d.url === absoluteUrl);
        if (!hasPdf) {
          existingReport.data.documents.push({
            title: `Årsregnskap PDF ${link.year}`,
            url: absoluteUrl,
            type: 'pdf',
          });
        }
      } else {
        // Opprett ny rapport med PDF-lenke
        reportsMap.set(link.year, {
          year: link.year,
          data: {
            source: 'puppeteer-js',
            documents: [{
              title: `Årsregnskap PDF ${link.year}`,
              url: absoluteUrl,
              type: 'pdf',
            }],
          },
        });
      }
    }
    
    const reports = Array.from(reportsMap.values());
    
    // Logg hvor mange PDF-lenker vi fant
    const totalPdfLinks = reports.reduce((sum, report) => 
      sum + (report.data.documents?.filter(d => d.url && isLikelyPdfUrl(d.url)).length || 0), 0
    );
    if (totalPdfLinks > 0) {
      console.log(`[${orgnr}] Fant ${totalPdfLinks} PDF-lenker totalt, laster ned og parser...`);
    }
    
    // Last ned og parse PDF-ene
    await enrichReportsWithPdfData(reports, orgnr);
    
    return reports;
  } catch (error) {
    if (browser) {
      try {
        await browser.close();
      } catch (closeError) {
        // Ignore close errors
      }
    }
    console.warn(`[${orgnr}] Feil ved henting av PDF-lenker fra virksomhetssiden:`, (error as Error).message);
    return existingReports;
  }
}

async function extractFromRegnskapApi(orgnr: string): Promise<AnnualReport[]> {
  try {
    // Hent alle tilgjengelige årsregnskap (ingen maxResults-begrensning)
    let entries = await fetchRegnskapApiEntries(orgnr, 999);
    
    // Hvis vi bare fikk ett regnskap, prøv alternative metoder
    if (entries.length <= 1) {
      console.log(`[${orgnr}] Prøver alternative metoder for å finne flere årsregnskap...`);
      
      // Prøv å hente uten år-parameter
      const { fetchAllRegnskapForOrg } = await import('./regnskap-bulk');
      const allRegnskap = await fetchAllRegnskapForOrg(orgnr);
      
      if (allRegnskap.length > entries.length) {
        // Konverter til RegnskapApiEntry-format
        const additionalEntries: Array<{ year: number; documents: Array<Record<string, unknown>>; raw: Record<string, unknown> }> = [];
        for (const regnskap of allRegnskap) {
          if (typeof regnskap === 'object' && regnskap !== null) {
            const regnskapObj = regnskap as Record<string, unknown>;
            const periode = regnskapObj.regnskapsperiode as Record<string, unknown> | undefined;
            const tilDato = periode?.tilDato as string | undefined;
            const year = tilDato ? parseInt(tilDato.substring(0, 4), 10) : null;
            
            if (year && !entries.some(e => e.year === year)) {
              additionalEntries.push({
                year,
                documents: [],
                raw: regnskapObj,
              });
            }
          }
        }
        entries = [...entries, ...additionalEntries];
      }
    }
    
    if (!entries.length) {
      console.log(`[${orgnr}] Ingen årsregnskap funnet i Regnskapsregisteret API`);
      return [];
    }

    const reports: AnnualReport[] = [];
    const seenYears = new Set<number>();
    
    for (const entry of entries) {
      if (!entry.year || seenYears.has(entry.year)) {
        continue;
      }
      seenYears.add(entry.year);

      // Logg hva API-et faktisk returnerer
      console.log(`[${orgnr}] API-entry for ${entry.year}:`, {
        hasDocuments: !!entry.documents,
        documentCount: entry.documents?.length || 0,
        hasRaw: !!entry.raw,
        rawKeys: entry.raw ? Object.keys(entry.raw).slice(0, 10) : [],
      });
      
      const rawDocs = mapApiDocumentsToRaw(entry.documents);
      console.log(`[${orgnr}] Mapped ${rawDocs.length} dokumenter fra API for ${entry.year}`);
      
      let documents: AnnualReportDocument[] = [];
      
      // Logg hva API-et faktisk returnerer
      if (entry.documents && entry.documents.length > 0) {
        console.log(`[${orgnr}] API returnerte ${entry.documents.length} dokumenter for ${entry.year}`);
        // Logg første dokument for debugging
        const firstDoc = entry.documents[0];
        if (firstDoc && typeof firstDoc === 'object') {
          const docKeys = Object.keys(firstDoc);
          console.log(`[${orgnr}] Første dokument har nøkler: ${docKeys.join(', ')}`);
          // Sjekk om det er PDF-lenker i dokumentet
          const docStr = JSON.stringify(firstDoc).toLowerCase();
          if (docStr.includes('pdf') || docStr.includes('download') || docStr.includes('url')) {
            console.log(`[${orgnr}] Dokument inneholder potensielle PDF-lenker:`, JSON.stringify(firstDoc).substring(0, 200));
          }
        }
      } else {
        console.log(`[${orgnr}] API returnerte ingen dokumenter for ${entry.year}, men har raw-data:`, entry.raw ? 'ja' : 'nei');
        // Prøv å finne lenker i raw-data
        if (entry.raw && typeof entry.raw === 'object') {
          const rawStr = JSON.stringify(entry.raw).toLowerCase();
          if (rawStr.includes('pdf') || rawStr.includes('download') || rawStr.includes('url')) {
            console.log(`[${orgnr}] Raw-data inneholder potensielle lenker:`, JSON.stringify(entry.raw).substring(0, 300));
          }
        }
      }
      
      if (rawDocs.length > 0) {
        // Hvis vi har PDF-lenker, last dem ned og parse dem
        documents = await buildDocumentsWithPdf(rawDocs, orgnr, entry.year);
      }
      
      // Hvis vi ikke har PDF-lenker fra API-et, prøv å konstruere en PDF-URL
      // eller prøv å hente PDF direkte fra Regnskapsregisteret
      if (documents.length === 0 || !documents.some(d => d.url && isLikelyPdfUrl(d.url))) {
        console.log(`[${orgnr}] Prøver å konstruere PDF-URL for ${entry.year}...`);
        // Prøv å konstruere en mulig PDF-URL basert på organisasjonsnummer og år
        const possiblePdfUrls = [
          `https://data.brreg.no/regnskapsregisteret/regnskap/${orgnr}/${entry.year}.pdf`,
          `https://www.brreg.no/regnskapsregisteret/regnskap/${orgnr}/${entry.year}.pdf`,
          `https://data.brreg.no/regnskapsregisteret/regnskap/${orgnr}?ar=${entry.year}&format=pdf`,
        ];
        
        // Prøv hver mulig URL for å se om den eksisterer
        for (const pdfUrl of possiblePdfUrls) {
          try {
            const response = await axios.head(pdfUrl, { timeout: 5000 });
            if (response.status === 200 && response.headers['content-type']?.includes('pdf')) {
              console.log(`[${orgnr}] ✅ Fant PDF-URL for ${entry.year}: ${pdfUrl}`);
              documents.push({
                title: `Årsregnskap ${entry.year}`,
                url: pdfUrl,
                type: 'pdf',
              });
              break;
            }
          } catch (error) {
            // URL eksisterer ikke, prøv neste
            continue;
          }
        }
      }
      
      // Hvis vi fortsatt ikke har PDF-lenker, lagre JSON-data som fallback
      // Men sørg for at vi faktisk lagrer API-dataene vi får
      if (documents.length === 0) {
        console.log(`[${orgnr}] Ingen PDF-lenker funnet, lagrer JSON-data fra API for ${entry.year}`);
        documents = [{
          title: `Årsregnskap ${entry.year}`,
          url: `https://data.brreg.no/regnskapsregisteret/regnskap/${orgnr}?ar=${entry.year}`,
          type: 'regnskap-json',
        }];
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
      
      // Sjekk om noen av rapporterne har PDF-lenker
      const hasPdfLinks = reports.some(report => 
        report.data.documents?.some(doc => doc.url && isLikelyPdfUrl(doc.url))
      );
      
      if (!hasPdfLinks) {
        console.log(`[${orgnr}] API-rapporter har ingen PDF-lenker, vil søke på virksomhetssiden...`);
      }
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
    const rawUrl = extractDocumentUrl(doc);
    const normalizedUrl = normalizeDocumentUrl(rawUrl);

    if (!normalizedUrl || !isLikelyPdfUrl(normalizedUrl)) {
      continue;
    }

    const normalizedDoc: AnnualReportDocument = {
      title: doc.title ?? doc.name ?? doc.documentType ?? 'Dokument',
      url: normalizedUrl,
      type: doc.documentType ?? doc.type ?? null,
      size: doc.size ?? doc.fileSize ?? null,
    };

    try {
      const pdfData = await downloadAndParsePdf(normalizedUrl, orgnr, year);
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

async function downloadAndParsePdf(url: string, orgnr?: string, year?: number): Promise<{ text: string; numPages: number; info: Record<string, unknown> }> {
  // Opprett temp-mappe hvis den ikke eksisterer
  if (!fs.existsSync(PDF_TEMP_DIR)) {
    fs.mkdirSync(PDF_TEMP_DIR, { recursive: true });
  }

  // Generer unikt filnavn basert på URL, orgnr og år
  const urlHash = Buffer.from(url).toString('base64').replace(/[/+=]/g, '').substring(0, 20);
  const filename = orgnr && year 
    ? `${orgnr}-${year}-${urlHash}.pdf`
    : `${urlHash}.pdf`;
  const filePath = path.join(PDF_TEMP_DIR, filename);

  try {
    // Last ned PDF til disk
    const response = await axios.get<ArrayBuffer>(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/pdf' },
      responseType: 'arraybuffer',
      timeout: 30000,
    });

    const buffer = Buffer.from(response.data);
    
    // Lagre PDF til disk
    fs.writeFileSync(filePath, buffer);
    console.log(`[${orgnr || 'unknown'}] Lagret PDF til disk: ${filename}`);

    // Les PDF fra disk og parse
    const fileBuffer = fs.readFileSync(filePath);
    const parsed = await pdf(fileBuffer);

    const result = {
      text: parsed.text?.trim() ?? '',
      numPages: parsed.numpages ?? 0,
      info: parsed.info ? (parsed.info as Record<string, unknown>) : {},
    };

    // Slett PDF-filen etter parsing
    try {
      fs.unlinkSync(filePath);
      console.log(`[${orgnr || 'unknown'}] Slettet PDF-fil: ${filename}`);
    } catch (deleteError) {
      console.warn(`[${orgnr || 'unknown'}] Klarte ikke å slette PDF-fil ${filename}:`, (deleteError as Error).message);
    }

    return result;
  } catch (error) {
    // Sørg for at filen slettes selv ved feil
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (deleteError) {
        // Ignorer feil ved sletting
      }
    }
    throw error;
  }
}

async function enrichReportsWithPdfData(reports: AnnualReport[], orgnr: string): Promise<void> {
  for (const report of reports) {
    for (const document of report.data.documents ?? []) {
      if (!document.url || !isLikelyPdfUrl(document.url) || document.pdfText) {
        continue;
      }

      try {
        console.log(`[${orgnr}] Laster ned PDF for ${report.year}: ${document.url.substring(0, 100)}...`);
        const pdfData = await downloadAndParsePdf(document.url, orgnr, report.year);
        document.pdfText = pdfData.text;
        document.pdfNumPages = pdfData.numPages;
        document.pdfInfo = pdfData.info;
        console.log(`[${orgnr}] ✅ Lastet ned og parsert PDF for ${report.year} (${pdfData.numPages} sider, ${pdfData.text.length} tegn)`);
      } catch (error) {
        console.warn(`[${orgnr}] Klarte ikke å laste ned PDF for ${report.year} (${document.title}):`, (error as Error).message);
      }
    }
  }
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

  const allLinks = $('a').length;
  console.log(`[${orgnr}] Totalt antall lenker på siden: ${allLinks}`);

  let linksWithArsregnskap = 0;
  $('a').each((_: number, anchor: Element) => {
    const linkText = $(anchor).text().toLowerCase().trim();
    const href = $(anchor).attr('href');
    const absoluteUrl = normalizeDocumentUrl(href);

    if (!absoluteUrl || !isLikelyPdfUrl(absoluteUrl)) {
      return;
    }

    if (
      linkText.includes('innsendt årsregnskap') ||
      linkText.includes('innsendt arsregnskap') ||
      linkText.includes('årsregnskap') ||
      linkText.includes('arsregnskap')
    ) {
      linksWithArsregnskap += 1;
      const parent = $(anchor).closest('div, section, article, li, p');
      let searchText = parent.text();

      const prevSiblings = $(anchor).prevAll('h3, h4, strong, b, div').slice(0, 3);
      prevSiblings.each((_: number, el: Element) => {
        searchText += ` ${$(el).text()}`;
      });

      const yearMatches = searchText.match(/\b(20\d{2}|19\d{2})\b/g);
      if (!yearMatches?.length) {
        return;
      }

      const years = yearMatches
        .map((m: string) => Number(m))
        .filter((y: number) => y >= 2000 && y <= new Date().getFullYear());

      if (!years.length) {
        return;
      }

      const year = Math.max(...years);
      if (foundYears.has(year)) {
        return;
      }

      foundYears.add(year);
      console.log(`[${orgnr}] Fant årsregnskap for ${year} via lenke: ${absoluteUrl}`);
      reports.push({
        year,
        data: {
          source: 'body-text-link',
          documents: [{ title: 'Innsendt årsregnskap', url: absoluteUrl }],
        },
      });
    }
  });

  console.log(`[${orgnr}] Fant ${linksWithArsregnskap} lenker med årsregnskap-tekst`);

  $('*').each((_: number, element: Element) => {
    const elementText = $(element).text().toLowerCase();
    const yearMatch = elementText.match(/\b(20\d{2})\b/);

    if (
      !yearMatch ||
      (!elementText.includes('innsendt årsregnskap') && !elementText.includes('innsendt arsregnskap'))
    ) {
      return;
    }

    const year = Number(yearMatch[0]);
    if (year < 2000 || year > new Date().getFullYear() || foundYears.has(year)) {
      return;
    }

    const link = $(element).find('a').first();
    const absoluteUrl = normalizeDocumentUrl(link.attr('href'));

    if (!absoluteUrl || !isLikelyPdfUrl(absoluteUrl)) {
      return;
    }

    foundYears.add(year);
    console.log(`[${orgnr}] Fant årsregnskap for ${year} via element-søk: ${absoluteUrl}`);
    reports.push({
      year,
      data: {
        source: 'element-search',
        documents: [{ title: 'Innsendt årsregnskap', url: absoluteUrl }],
      },
    });
  });

  $('h3, h4, strong, b').each((_: number, heading: Element) => {
    const headingText = $(heading).text();
    const yearMatch = headingText.match(YEAR_REGEX);

    if (!yearMatch) {
      return;
    }

    const year = Number(yearMatch[0]);
    if (foundYears.has(year)) {
      return;
    }

    const nextSibling = $(heading).next();
    const link = nextSibling
      .find('a')
      .filter((_: number, a: Element) => {
        const text = $(a).text().toLowerCase();
        return text.includes('innsendt årsregnskap') || text.includes('innsendt arsregnskap');
      })
      .first();

    if (!link.length) {
      return;
    }

    const absoluteUrl = normalizeDocumentUrl(link.attr('href'));
    if (!absoluteUrl || !isLikelyPdfUrl(absoluteUrl)) {
      return;
    }

    foundYears.add(year);
    console.log(`[${orgnr}] Fant årsregnskap for ${year} via overskrift + lenke: ${absoluteUrl}`);
    reports.push({
      year,
      data: {
        source: 'heading-link',
        documents: [{ title: 'Innsendt årsregnskap', url: absoluteUrl }],
      },
    });
  });

  return dedupeReports(reports);
}

main().catch((error) => {
  console.error('Uventet feil under scraping av årsregnskap', error);
  process.exit(1);
});

