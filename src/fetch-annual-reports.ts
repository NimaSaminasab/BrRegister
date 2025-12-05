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
    // Legg til timeout på connect
    const connectPromise = client.connect();
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Database connection timeout after 10 seconds')), 10000);
    });
    
    await Promise.race([connectPromise, timeoutPromise]);

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

    // Legg til timeout på query
    const queryPromise = client.query<AnnualReportRow & { company_name: string | null }>(
      query,
      params,
    );
    const queryTimeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Database query timeout after 30 seconds')), 30000);
    });

    const result = await Promise.race([queryPromise, queryTimeoutPromise]);

    return result.rows.map((row) => ({
      organisasjonsnummer: row.organisasjonsnummer,
      ar: row.ar,
      data: row.data,
      scraped_at: row.scraped_at,
      company_name: row.company_name,
    }));
  } catch (error) {
    const err = error as Error;
    if (err.message.includes('timeout') || err.message.includes('ETIMEDOUT') || err.message.includes('ECONNREFUSED')) {
      throw new Error('Kunne ikke koble til databasen. Databasen er sannsynligvis kun tilgjengelig fra EC2. Kjør serveren på EC2 i stedet for lokalt.');
    }
    throw error;
  } finally {
    try {
      await client.end();
    } catch (e) {
      // Ignore errors when closing connection
    }
  }
}

