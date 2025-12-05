import { createPostgresClient, getPostgresEnvConfig } from './postgres';

export interface AnnualReportRow {
  organisasjonsnummer: string;
  ar: number;
  data: Record<string, unknown>;
  scraped_at: Date | string | null;
}

export interface AnnualReportWithCompany {
  organisasjonsnummer: string;
  ar: number;
  data: Record<string, unknown>;
  scraped_at: Date | string | null;
  company_name?: string | null;
}

export async function fetchAnnualReportsFromPostgres(
  organisasjonsnummer?: string,
): Promise<AnnualReportWithCompany[]> {
  const postgresConfig = getPostgresEnvConfig();
  const client = createPostgresClient(postgresConfig);

  try {
    await client.connect();

    let query = `
      SELECT 
        ar.organisasjonsnummer,
        ar.ar,
        ar.data,
        ar.scraped_at,
        c.navn AS company_name
      FROM brreg_annual_reports ar
      LEFT JOIN brreg_companies c ON ar.organisasjonsnummer = c.organisasjonsnummer
    `;

    const params: unknown[] = [];

    if (organisasjonsnummer) {
      query += ` WHERE ar.organisasjonsnummer = $1`;
      params.push(organisasjonsnummer);
    }

    query += ` ORDER BY ar.organisasjonsnummer, ar.ar DESC`;

    const result = await client.query<AnnualReportRow & { company_name: string | null }>(
      query,
      params,
    );

    return result.rows.map((row) => ({
      organisasjonsnummer: row.organisasjonsnummer,
      ar: row.ar,
      data: row.data,
      scraped_at: row.scraped_at,
      company_name: row.company_name,
    }));
  } finally {
    await client.end();
  }
}

