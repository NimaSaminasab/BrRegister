/**
 * Script for å synkronisere bedriftsdata til AWS DynamoDB
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { chain } from 'stream-chain';
import { parser } from 'stream-json';
import { streamArray } from 'stream-json/streamers/StreamArray';
import { Enhet } from './types';

dotenv.config();

const OUTPUT_DIR = path.join(__dirname, '../data');
const COMPANIES_FILE = path.join(OUTPUT_DIR, 'companies.json');

const AWS_REGION = process.env.AWS_REGION || 'eu-north-1';
const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME || 'br-register-companies';

class DynamoDBSyncer {
  private client: DynamoDBClient;
  private docClient: DynamoDBDocumentClient;
  private tableName: string;

  constructor(region: string, tableName: string) {
    this.client = new DynamoDBClient({ region });
    this.docClient = DynamoDBDocumentClient.from(this.client);
    this.tableName = tableName;
  }

  /**
   * Konverter Enhet til DynamoDB format
   */
  private transformCompany(company: Enhet): any {
    // Organisasjonsnummer er primærnøkkel
    const { _links, ...rest } = company;
    const transformed: Record<string, unknown> = {
      ...rest,
      organisasjonsnummer: company.organisasjonsnummer,
      // Legg til tidsstempel for når dataen ble lastet opp
      lastSynced: new Date().toISOString(),
    };

    // Flatten nøkkelfelter for indeksering
    if (company.organisasjonsform?.kode) {
      transformed.organisasjonsformKode = company.organisasjonsform.kode;
    }
    if (company.naeringskode1?.kode) {
      transformed.naeringskode1Kode = company.naeringskode1.kode;
    }

    return transformed;
  }

  /**
   * Last opp en enkelt bedrift
   */
  async putCompany(company: Enhet): Promise<void> {
    const item = this.transformCompany(company);

    try {
      await this.docClient.send(
        new PutCommand({
          TableName: this.tableName,
          Item: item,
        })
      );
    } catch (error: any) {
      console.error(`Feil ved opplasting av ${company.organisasjonsnummer}:`, error.message);
      throw error;
    }
  }

  /**
   * Last opp flere bedrifter i batch
   */
  async putCompaniesBatch(companies: Enhet[], options: { logProgress?: boolean } = {}): Promise<void> {
    const { logProgress = true } = options;
    const batchSize = 25; // DynamoDB batch write limit

    for (let i = 0; i < companies.length; i += batchSize) {
      const batch = companies.slice(i, i + batchSize);
      const requests = batch.map(company => ({
        PutRequest: {
          Item: this.transformCompany(company),
        },
      }));

      try {
        await this.docClient.send(
          new BatchWriteCommand({
            RequestItems: {
              [this.tableName]: requests,
            },
          })
        );

        if (logProgress) {
          console.log(
            `Lastet opp batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(
              companies.length / batchSize
            )} (${i + 1}-${Math.min(i + batchSize, companies.length)} av ${companies.length})`
          );
        }
      } catch (error: any) {
        console.error(`Feil ved batch opplasting (${i}-${i + batchSize}):`, error.message);
        // Prøv individuell opplasting ved feil
        for (const company of batch) {
          try {
            await this.putCompany(company);
          } catch (err) {
            console.error(`Kunne ikke laste opp ${company.organisasjonsnummer}`);
          }
        }
      }
    }
  }

  /**
   * Synkroniser alle bedrifter fra fil til DynamoDB
   */
  async syncAll(): Promise<void> {
    if (!fs.existsSync(COMPANIES_FILE)) {
      throw new Error(`Fil ikke funnet: ${COMPANIES_FILE}. Kjør 'npm run fetch' først.`);
    }

    console.log(`Laster bedriftsdata fra ${COMPANIES_FILE}...`);
    console.log(`Starter synkronisering til DynamoDB tabell: ${this.tableName}`);
    console.log(`Region: ${AWS_REGION}\n`);

    const jsonPipeline = chain([
      fs.createReadStream(COMPANIES_FILE),
      parser(),
      streamArray(),
    ]);

    const batchSize = 25;
    let batch: Enhet[] = [];
    let processed = 0;
    let batches = 0;

    for await (const data of jsonPipeline as AsyncIterable<{ value: Enhet }>) {
      const company = data.value;
      if (!company?.organisasjonsnummer) {
        continue;
      }

      batch.push(company);

      if (batch.length === batchSize) {
        batches += 1;
        await this.putCompaniesBatch(batch, { logProgress: false });
        processed += batch.length;
        if (batches % 20 === 0) {
          console.log(`Synkronisert ${processed} bedrifter så langt...`);
        }
        batch = [];
      }
    }

    if (batch.length > 0) {
      batches += 1;
      await this.putCompaniesBatch(batch, { logProgress: false });
      processed += batch.length;
    }

    console.log(`\n✅ Ferdig! Synkronisert ${processed} bedrifter til DynamoDB`);
  }
}

/**
 * Hovedfunksjon
 */
async function main() {
  console.log('Starter synkronisering til DynamoDB...\n');

  const syncer = new DynamoDBSyncer(AWS_REGION, TABLE_NAME);

  try {
    await syncer.syncAll();
  } catch (error: any) {
    console.error('Feil i hovedfunksjon:', error.message);
    process.exit(1);
  }
}

// Kjør hvis kalt direkte
if (require.main === module) {
  main().catch(console.error);
}

export { DynamoDBSyncer };

