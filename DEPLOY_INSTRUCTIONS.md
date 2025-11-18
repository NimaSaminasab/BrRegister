# Instruksjoner for Deploy til AWS

## Steg 1: Konfigurer AWS Credentials

Du må ha AWS credentials før du kan deploye. Velg en av metodene nedenfor:

### Metode 1: AWS CLI (Anbefalt)

1. Installer AWS CLI hvis du ikke har det:
   - Last ned fra: https://aws.amazon.com/cli/
   - Eller via: `winget install Amazon.AWSCLI` (Windows)

2. Konfigurer AWS credentials:
   ```bash
   aws configure
   ```
   
   Du trenger:
   - **AWS Access Key ID**: Fra din AWS IAM bruker
   - **AWS Secret Access Key**: Fra din AWS IAM bruker
   - **Default region**: `eu-north-1` (eller din foretrukne region)
   - **Default output format**: `json`

### Metode 2: Miljøvariabler

Hvis du ikke vil bruke AWS CLI, kan du sette miljøvariabler:

**Windows (PowerShell):**
```powershell
$env:AWS_ACCESS_KEY_ID="din-access-key"
$env:AWS_SECRET_ACCESS_KEY="din-secret-key"
$env:AWS_DEFAULT_REGION="eu-north-1"
```

**Windows (CMD):**
```cmd
set AWS_ACCESS_KEY_ID=din-access-key
set AWS_SECRET_ACCESS_KEY=din-secret-key
set AWS_DEFAULT_REGION=eu-north-1
```

## Steg 2: Bootstrap CDK (Første gang per region)

Første gang du deployer til en ny region, må du bootstrap CDK:

```bash
npx cdk bootstrap aws://ACCOUNT-ID/REGION
```

Eller hvis AWS CLI er konfigurert:
```bash
npx cdk bootstrap
```

## Steg 3: Deploy Infrastruktur

```bash
npm run deploy
```

Dette vil opprette:
- DynamoDB tabell: `br-register-companies`
- Global Secondary Indexes for søk
- Point-in-time recovery for backup

## Steg 4: Synkroniser Data

Når tabellen er opprettet, synkroniserer du dataene:

```bash
npm run sync
```

**Merk:** Dette kan ta lang tid (flere timer) siden det er over 1 million bedrifter!

## Hvor får jeg AWS Credentials?

1. Logg inn på AWS Console: https://console.aws.amazon.com
2. Gå til IAM (Identity and Access Management)
3. Klikk på "Users" → Velg din bruker (eller opprett ny)
4. Gå til "Security credentials" tab
5. Klikk "Create access key"
6. Velg "Command Line Interface (CLI)"
7. Last ned eller kopier Access Key ID og Secret Access Key

**VIKTIG:** Lagre credentials sikkert! De gir full tilgang til din AWS konto.

## Feilsøking

### "Unable to resolve AWS account"
- Sjekk at AWS credentials er konfigurert riktig
- Kjør `aws sts get-caller-identity` for å verifisere

### "Access Denied"
- Sjekk at IAM brukeren har nødvendige rettigheter:
  - `dynamodb:*` (eller mer spesifikke rettigheter)
  - `cloudformation:*` (for CDK deploy)
  - `s3:*` (for CDK bootstrap)

### "Region not found"
- Sjekk at regionen eksisterer: `eu-north-1`, `us-east-1`, etc.
- Verifiser at regionen er aktivert i din AWS konto

