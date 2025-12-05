import { createPostgresClient, getPostgresEnvConfig, sanitizeIdentifier } from './postgres';

interface PostgresCompanyRow {
  organisasjonsnummer: string;
  navn: string | null;
  organisasjonsform_kode: string | null;
  naeringskode1: string | null;
  data: Record<string, unknown>;
  last_synced: Date | string | null;
}

const DEFAULT_BATCH_SIZE = Number(process.env.POSTGRES_READ_BATCH_SIZE ?? '500');

export async function fetchCompaniesFromPostgres(batchSize = DEFAULT_BATCH_SIZE) {
  const postgresConfig = getPostgresEnvConfig();
  const tableName = sanitizeIdentifier(postgresConfig.tableName);
  const client = createPostgresClient(postgresConfig);

  const companies: Record<string, unknown>[] = [];
  let offset = 0;

  try {
    console.log(
      `Reading companies from postgres://${postgresConfig.host}:${postgresConfig.port}/${postgresConfig.database}`,
    );
    
    // Legg til timeout på connect
    const connectPromise = client.connect();
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Database connection timeout after 10 seconds')), 10000);
    });
    
    await Promise.race([connectPromise, timeoutPromise]);

    while (true) {
      const result = await client.query<PostgresCompanyRow>(
        `
          SELECT
            organisasjonsnummer,
            navn,
            organisasjonsform_kode,
            naeringskode1,
            data,
            last_synced
          FROM ${tableName}
          ORDER BY organisasjonsnummer
          OFFSET $1
          LIMIT $2
        `,
        [offset, batchSize],
      );

      if (result.rows.length === 0) {
        break;
      }

      for (const row of result.rows) {
        companies.push({
          organisasjonsnummer: row.organisasjonsnummer,
          navn: row.navn,
          organisasjonsform_kode: row.organisasjonsform_kode,
          naeringskode1: row.naeringskode1,
          last_synced:
            row.last_synced instanceof Date ? row.last_synced.toISOString() : row.last_synced,
          data: row.data,
        });
      }

      offset += result.rows.length;
    }
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

  return companies;
}

export async function printCompaniesAsJson() {
  const companies = await fetchCompaniesFromPostgres();
  console.log(JSON.stringify(companies, null, 2));
}

if (require.main === module) {
  printCompaniesAsJson().catch((error) => {
    console.error('Failed to read companies from Postgres:', error);
    process.exit(1);
  });
}

