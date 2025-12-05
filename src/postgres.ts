import dotenv from 'dotenv';
import { Client } from 'pg';

dotenv.config();

export interface PostgresEnvConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  tableName: string;
  ssl?: string;
}

export function getPostgresEnvConfig(): PostgresEnvConfig {
  const {
    POSTGRES_HOST = 'localhost',
    POSTGRES_PORT = '5432',
    POSTGRES_DB = 'postgres',
    POSTGRES_USER,
    POSTGRES_PASSWORD,
    POSTGRES_TABLE = 'brreg_companies',
    POSTGRES_SSL,
  } = process.env;

  if (!POSTGRES_USER || !POSTGRES_PASSWORD) {
    throw new Error('POSTGRES_USER and POSTGRES_PASSWORD must be set in your environment');
  }

  return {
    host: POSTGRES_HOST,
    port: Number(POSTGRES_PORT),
    database: POSTGRES_DB,
    user: POSTGRES_USER,
    password: POSTGRES_PASSWORD,
    tableName: POSTGRES_TABLE,
    ssl: POSTGRES_SSL,
  };
}

export function createPostgresClient(config: PostgresEnvConfig) {
  return new Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: parseSslSetting(config.ssl),
    connectionTimeoutMillis: 10000, // 10 sekunder timeout for tilkobling
    query_timeout: 30000, // 30 sekunder timeout for queries
  });
}

export function sanitizeIdentifier(identifier: string) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid table name: ${identifier}. Use only letters, numbers, and underscores.`);
  }
  return identifier;
}

export function parseSslSetting(value?: string) {
  if (!value) {
    return false;
  }

  const normalized = value.trim();

  if (normalized.toLowerCase() === 'true') {
    return true;
  }

  if (normalized.toLowerCase() === 'false') {
    return false;
  }

  try {
    return JSON.parse(normalized);
  } catch {
    return normalized;
  }
}

