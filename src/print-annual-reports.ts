import { createPostgresClient, getPostgresEnvConfig } from './postgres';

interface AnnualReportRow {
  organisasjonsnummer: string;
  ar: number;
  data: Record<string, unknown>;
  scraped_at: Date | string | null;
}

async function main() {
  const postgresConfig = getPostgresEnvConfig();
  const client = createPostgresClient(postgresConfig);

  try {
    await client.connect();
    console.log('Koblet til databasen\n');

    // Hent alle årsregnskap
    const result = await client.query<AnnualReportRow>(
      `
        SELECT 
          organisasjonsnummer,
          ar,
          data,
          scraped_at
        FROM brreg_annual_reports
        ORDER BY organisasjonsnummer, ar DESC
      `,
    );

    if (result.rows.length === 0) {
      console.log('Ingen årsregnskap funnet i databasen.');
      return;
    }

    console.log(`Fant ${result.rows.length} årsregnskap i databasen:\n`);

    // Grupper etter organisasjonsnummer
    const byOrg: Record<string, AnnualReportRow[]> = {};
    for (const row of result.rows) {
      if (!byOrg[row.organisasjonsnummer]) {
        byOrg[row.organisasjonsnummer] = [];
      }
      byOrg[row.organisasjonsnummer].push(row);
    }

    // Vis oversikt
    for (const [orgnr, reports] of Object.entries(byOrg)) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`Organisasjonsnummer: ${orgnr}`);
      console.log(`Antall årsregnskap: ${reports.length}`);
      console.log(`År: ${reports.map(r => r.ar).join(', ')}`);
      console.log(`${'='.repeat(60)}`);

      // Vis detaljer for hvert år
      for (const report of reports) {
        console.log(`\n  År: ${report.ar}`);
        console.log(`  Scraped at: ${report.scraped_at || 'N/A'}`);
        
        const data = report.data as Record<string, unknown>;
        const source = data.source as string | undefined;
        const hasJsonData = data.raw && typeof data.raw === 'object' && !(data.raw as Record<string, unknown>).pdfPath;
        const hasPdf = (data.raw as Record<string, unknown> | undefined)?.pdfPath;
        
        console.log(`  Source: ${source || 'unknown'}`);
        
        if (hasPdf) {
          const pdfData = data.raw as Record<string, unknown>;
          console.log(`  PDF Path: ${pdfData.pdfPath}`);
          console.log(`  PDF Size: ${pdfData.pdfSize ? `${Math.round((pdfData.pdfSize as number) / 1024)} KB` : 'N/A'}`);
          console.log(`  Has JSON Data: ${pdfData.hasJsonData === false ? 'No (PDF only)' : 'Yes'}`);
        } else if (hasJsonData) {
          const raw = data.raw as Record<string, unknown>;
          const journalnr = raw.journalnr || raw.journalnummer || raw.id;
          const periode = raw.regnskapsperiode as Record<string, unknown> | undefined;
          const tilDato = periode?.tilDato as string | undefined;
          
          console.log(`  Journalnr: ${journalnr || 'N/A'}`);
          console.log(`  Regnskapsperiode: ${tilDato || 'N/A'}`);
          console.log(`  Documents: ${Array.isArray(data.documents) ? data.documents.length : 0}`);
        }
      }
    }

    // Vis statistikk
    console.log(`\n\n${'='.repeat(60)}`);
    console.log('STATISTIKK:');
    console.log(`${'='.repeat(60)}`);
    console.log(`Total antall årsregnskap: ${result.rows.length}`);
    console.log(`Antall unike organisasjonsnumre: ${Object.keys(byOrg).length}`);
    
    // Tell hvor mange som har PDF vs JSON
    let pdfOnlyCount = 0;
    let jsonCount = 0;
    for (const row of result.rows) {
      const data = row.data as Record<string, unknown>;
      const raw = data.raw as Record<string, unknown> | undefined;
      if (raw?.pdfPath) {
        pdfOnlyCount++;
      } else {
        jsonCount++;
      }
    }
    console.log(`Med JSON-data: ${jsonCount}`);
    console.log(`Kun PDF (ingen JSON): ${pdfOnlyCount}`);

  } catch (error) {
    console.error('Feil ved lesing fra databasen:', error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch(console.error);
}

