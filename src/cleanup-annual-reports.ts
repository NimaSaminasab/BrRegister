import { createPostgresClient, getPostgresEnvConfig } from './postgres';

async function cleanupAnnualReports() {
  const config = getPostgresEnvConfig();
  const client = createPostgresClient(config);
  await client.connect();

  const deleteQuery = `
    DELETE FROM brreg_annual_reports
    WHERE
      data->'documents'->0->>'url' IS NULL
      OR data->'documents'->0->>'url' = '#'
      OR data->'documents'->0->>'url' ILIKE 'javascript:%'
      OR data->'documents'->0->>'url' ILIKE 'about:%'
      OR data->'documents'->0->>'url' ILIKE 'https://www.brreg.no/bedrift/innsending%'
      OR data->'documents'->0->>'url' NOT ILIKE '%.pdf%'`;

  const result = await client.query(deleteQuery);
  console.log(`🧹 Deleted ${result.rowCount} invalid annual report rows`);

  await client.end();
}

cleanupAnnualReports().catch((error) => {
  console.error('Failed to clean up annual reports table:', error);
  process.exit(1);
});

