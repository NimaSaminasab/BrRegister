# BR-register

Et prosjekt for å hente og lagre all data om norske bedrifter fra Brønnøysundregistrene i AWS DynamoDB.

## Oversikt

Dette prosjektet henter all tilgjengelig data om norske bedrifter fra [Brønnøysundregistrenes Enhetsregisteret API](https://data.brreg.no/enhetsregisteret/api/dokumentasjon/no/index.html) og lagrer det i AWS DynamoDB for rask søking og analyse.

## Funksjoner

- Henter alle bedrifter fra Brønnøysundregistrene
- Lagrer komplett bedriftsdata i DynamoDB
- Støtter inkrementelle oppdateringer
- Skalerbar AWS-infrastruktur

## Forutsetninger

- Node.js 18+ og npm
- AWS CLI konfigurert med passende credentials (for DynamoDB/CDK)
- AWS CDK CLI installert (`npm install -g aws-cdk`)
- PostgreSQL database hvis du ønsker å synkronisere lokalt (f.eks. AWS RDS)

## Installasjon

```bash
npm install
```

## Konfigurasjon

Opprett en `.env` fil i rotmappen:

```env
AWS_REGION=eu-north-1
DYNAMODB_TABLE_NAME=br-register-companies
POSTGRES_HOST=database-1.cduqaum6qexq.eu-north-1.rds.amazonaws.com
POSTGRES_PORT=5432
POSTGRES_DB=postgres
POSTGRES_TABLE=brreg_companies
POSTGRES_USER=postgres
POSTGRES_PASSWORD=super-secret
POSTGRES_SSL=true
```

## Bruk

### 1. Konfigurer AWS credentials

Du må ha AWS credentials konfigurert før du kan deploye. Det er to måter:

**Alternativ A: Bruk AWS CLI (anbefalt)**
```bash
aws configure
```
Dette vil spørre om:
- AWS Access Key ID
- AWS Secret Access Key  
- Default region (f.eks. `eu-north-1`)
- Default output format (kan være `json`)

**Alternativ B: Miljøvariabler**
Opprett en `.env` fil (kopier fra `env.example`) og sett:
- `AWS_REGION`: Din AWS region (f.eks. `eu-north-1`)
- `CDK_DEFAULT_ACCOUNT`: Din AWS account ID (valgfritt, CDK kan hente dette automatisk)
- `DYNAMODB_TABLE_NAME`: Navn på DynamoDB tabell (valgfritt, standard: `br-register-companies`)

**Merk:** Hvis du bruker AWS CLI, trenger du ikke `.env` fil - CDK henter credentials automatisk.

### 2. Installer avhengigheter

```bash
npm install
```

### 3. Deploy AWS infrastruktur

Første gang må du bootstrap CDK (kun én gang per region):

```bash
cdk bootstrap
```

Deretter deployer du stacken:

```bash
npm run deploy
```

Dette oppretter:
- DynamoDB tabell for bedriftsdata
- Global Secondary Indexes for søk på navn, organisasjonsform og næringskode
- Point-in-time recovery for backup

### 4. Hent alle bedrifter

Dette scriptet henter alle bedrifter fra Brønnøysundregistrene og lagrer dem lokalt i `data/companies.json`:

```bash
npm run fetch
```

**Merk:** Dette kan ta lang tid (flere timer) siden det henter data for alle norske bedrifter. Scriptet:
- Lagrer progresjon underveis
- Kan gjenopptas hvis det avbrytes
- Respekterer rate limits fra API-et
- Faller automatisk tilbake til paginering via `/enheter` hvis `/oppdateringer` ikke gir data

### 5. Synkroniser til DynamoDB

Når dataene er hentet, synkroniserer du dem til DynamoDB:

```bash
npm run sync
```

Dette scriptet:
- Leser data fra `data/companies.json`
- Strømmer data uten å laste hele filen i minnet
- Transformerer data for optimal lagring
- Laster opp i batches til DynamoDB

### 6. Synkroniser til PostgreSQL

Hvis du vil laste de samme dataene inn i en PostgreSQL-database (f.eks. din AWS RDS-instans), sett opp miljøvariablene for `POSTGRES_*` i `.env` og kjør:

```bash
npm run sync:pg
```

Scriptet `src/sync-to-postgres.ts`:
- Oppretter tabellen `brreg_companies` hvis den ikke finnes
- Lagrer hele org-dataen som `JSONB` sammen med nyttige felt (`navn`, `organisasjonsform_kode`, `naeringskode1`)
- Bruker `INSERT ... ON CONFLICT` for å oppdatere eksisterende rader
- Logger progresjon (nyttig når du senere laster flere enn 50 enheter)

## Prosjektstruktur

```
.
├── src/
│   ├── fetch-companies.ts    # Henter data fra Brønnøysundregistrene
│   ├── sync-to-dynamodb.ts   # Synkroniserer data til DynamoDB
│   ├── types.ts              # TypeScript typer for bedriftsdata
│   └── index.ts              # Main entry point
├── infrastructure/
│   ├── br-register-stack.ts  # AWS CDK stack definisjon
│   └── app.ts                # CDK app entry point
├── data/                     # Lokal lagring av hentet data (generert)
│   ├── companies.json        # Alle bedrifter
│   └── organisasjonsnumre.json # Liste over alle organisasjonsnumre
├── cdk.json                  # CDK konfigurasjon
├── tsconfig.json             # TypeScript konfigurasjon
└── package.json
```

## DynamoDB Struktur

Tabellen bruker følgende struktur:

- **Partition Key**: `organisasjonsnummer` (string)
- **Global Secondary Indexes**:
  - `navn-index`: For søk på bedriftsnavn
  - `organisasjonsform-kode-index`: For søk på organisasjonsform
  - `naeringskode-index`: For søk på næringskode

Alle originale felter fra Brønnøysundregistrene API lagres, pluss:
- `lastSynced`: Tidsstempel for når dataen ble lastet opp
- `organisasjonsformKode`: Flattet organisasjonsform kode (for indeksering)
- `naeringskode1Kode`: Flattet næringskode (for indeksering)

## API Dokumentasjon

Se [Brønnøysundregistrenes API dokumentasjon](https://data.brreg.no/enhetsregisteret/api/dokumentasjon/no/index.html) for detaljer om tilgjengelige endepunkter og data.

## Ytelse og Skalering

- **DynamoDB**: Bruker on-demand pricing for automatisk skalerbarhet
- **Rate Limiting**: Scriptet respekterer API rate limits (100ms mellom requests)
- **Batch Processing**: Data lastes opp i batches på 25 items (DynamoDB limit)
- **Streaming**: Både nedlasting og DynamoDB-opplasting strømmer data for å håndtere >1M enheter uten å fylle minnet

## Feilsøking

### AWS Credentials
Sørg for at AWS CLI er konfigurert:
```bash
aws configure
```

### CDK Bootstrap
Hvis du får feil ved deploy, prøv:
```bash
cdk bootstrap aws://ACCOUNT-ID/REGION
```

### Rate Limiting
Hvis API-et returnerer 429 (Too Many Requests), øk `RATE_LIMIT_DELAY` i `src/fetch-companies.ts`.

## Videre Utvikling

Mulige forbedringer:
- Automatiske oppdateringer via AWS Lambda og EventBridge
- Fulltekstsøk med AWS OpenSearch
- API for å søke i dataene
- Web interface for visualisering

