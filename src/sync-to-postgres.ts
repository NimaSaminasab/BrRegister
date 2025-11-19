import fs from 'fs';
import path from 'path';

import { Enhet } from './types';
import { createPostgresClient, getPostgresEnvConfig, sanitizeIdentifier } from './postgres';

const postgresConfig = getPostgresEnvConfig();
const tableName = sanitizeIdentifier(postgresConfig.tableName);
// When compiled, __dirname is dist/src, so we need to go up two levels to reach project root
const companiesPath = path.join(__dirname, '..', '..', 'data', 'companies.json');

if (!fs.existsSync(companiesPath)) {
  throw new Error(`Could not find companies file at ${companiesPath}. Run npm run fetch first.`);
}

const companies: Enhet[] = JSON.parse(fs.readFileSync(companiesPath, 'utf8'));

if (!companies.length) {
  console.log('No companies to sync. Exiting.');
  process.exit(0);
}

const client = createPostgresClient(postgresConfig);

async function main() {
  console.log(`Connecting to postgres://${postgresConfig.host}:${postgresConfig.port}/${postgresConfig.database}`);
  await client.connect();

  await ensureTable();

  let processed = 0;
  for (const company of companies) {
    await upsertCompany(company);
    processed += 1;
    if (processed % 10 === 0 || processed === companies.length) {
      console.log(`Synced ${processed}/${companies.length}`);
    }
  }

  console.log('Done.');
  await client.end();
}

async function ensureTable() {
  const createSql = `
    CREATE TABLE IF NOT EXISTS ${tableName} (
      organisasjonsnummer TEXT PRIMARY KEY,
      navn TEXT,
      organisasjonsform_kode TEXT,
      naeringskode1 TEXT,
      data JSONB NOT NULL,
      last_synced TIMESTAMPTZ DEFAULT NOW()
    );
  `;
  await client.query(createSql);
}

async function upsertCompany(company: Enhet) {
  const insertSql = `
    INSERT INTO ${tableName} (
      organisasjonsnummer,
      navn,
      organisasjonsform_kode,
      naeringskode1,
      data,
      last_synced
    )
    VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (organisasjonsnummer) DO UPDATE SET
      navn = EXCLUDED.navn,
      organisasjonsform_kode = EXCLUDED.organisasjonsform_kode,
      naeringskode1 = EXCLUDED.naeringskode1,
      data = EXCLUDED.data,
      last_synced = NOW();
  `;

  await client.query(insertSql, [
    company.organisasjonsnummer,
    company.navn ?? null,
    company.organisasjonsform?.kode ?? null,
    company.naeringskode1?.kode ?? null,
    company,
  ]);
}

export async function syncToPostgres() {
  try {
    await main();
  } catch (error) {
    console.error('Failed to sync to Postgres:', error);
    await client.end().catch(() => {});
    throw error;
  }
}

// Only run main if this file is executed directly (npm run sync:pg)
if (require.main === module) {
  syncToPostgres().catch(() => {
    process.exit(1);
  });
}

