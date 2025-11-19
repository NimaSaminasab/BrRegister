# Guide: Kjøre BR-register på EC2-instans

Denne guiden viser deg alle trinnene for å kjøre BR-register-programmet på en EC2-instans i AWS.

## Forutsetninger

- Du har en EC2-instans i samme VPC som database-1
- EC2-instansen har tilgang til internet (for å klone GitHub repo)
- Du har SSH-tilgang til EC2-instansen

---

## Steg 1: Koble til EC2-instansen

```bash
ssh -i din-nøkkel.pem ec2-user@din-ec2-ip-adresse
```

Eller hvis du bruker en annen bruker (f.eks. ubuntu):
```bash
ssh -i din-nøkkel.pem ubuntu@din-ec2-ip-adresse
```

---

## Steg 2: Installer Node.js og npm

### For Amazon Linux 2:
```bash
# Oppdater systemet
sudo yum update -y

# Installer Node.js 18.x
curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
sudo yum install -y nodejs

# Verifiser installasjonen
node --version
npm --version
```

### For Ubuntu:
```bash
# Oppdater systemet
sudo apt update

# Installer Node.js 18.x
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Verifiser installasjonen
node --version
npm --version
```

---

## Steg 3: Installer Git (hvis ikke allerede installert)

### For Amazon Linux 2:
```bash
sudo yum install -y git
```

### For Ubuntu:
```bash
sudo apt install -y git
```

---

## Steg 4: Klon GitHub-repoet

```bash
# Naviger til hjemmemappen
cd ~

# Klon repoet
git clone https://github.com/NimaSaminasab/BrRegister.git

# Gå inn i prosjektmappen
cd BrRegister
```

---

## Steg 5: Installer prosjektavhengigheter

```bash
npm install
```

Dette kan ta noen minutter mens npm henter alle pakkene.

---

## Steg 6: Opprett .env fil med database-innstillinger

```bash
# Kopier eksempelfilen
cp env.example .env

# Rediger .env filen med nano eller vi
nano .env
```

Sett inn følgende verdier i `.env` filen:

```env
# AWS Configuration
AWS_REGION=eu-north-1
CDK_DEFAULT_ACCOUNT=your-aws-account-id
CDK_DEFAULT_REGION=eu-north-1

# DynamoDB Configuration
DYNAMODB_TABLE_NAME=br-register-companies

# PostgreSQL Configuration
POSTGRES_HOST=database-1.cduqaum6qexq.eu-north-1.rds.amazonaws.com
POSTGRES_PORT=5432
POSTGRES_DB=postgres
POSTGRES_TABLE=brreg_companies
POSTGRES_USER=postgres
POSTGRES_PASSWORD=3c9x5OiWafT0ahXfYQc9
POSTGRES_SSL=true
```

**Lagre filen:**
- I `nano`: Trykk `Ctrl+X`, deretter `Y`, deretter `Enter`
- I `vi`: Trykk `Esc`, skriv `:wq`, trykk `Enter`

---

## Steg 7: Bygg TypeScript-koden

```bash
npm run build
```

Dette kompilerer TypeScript-koden til JavaScript i `dist/` mappen.

---

## Steg 8: Verifiser at data-filen eksisterer

```bash
# Sjekk om companies.json finnes
ls -lh data/companies.json
```

Hvis filen ikke finnes eller er tom, må du først hente dataene (se Steg 9).

---

## Steg 9 (Valgfritt): Hent alle selskapene fra Brønnøysundregistrene

Hvis du ikke allerede har `data/companies.json` med 50 selskap, kan du hoppe over dette steget siden filen allerede er i repoet.

Hvis du vil hente alle selskapene (kan ta flere timer):
```bash
npm run fetch
```

---

## Steg 10: Kjør programmet for å synkronisere til database-1

```bash
npm start
```

Programmet vil nå:
1. Koble til database-1
2. Opprette tabellen `brreg_companies` hvis den ikke finnes
3. Synkronisere alle selskapene fra `data/companies.json` til databasen

Du vil se output som:
```
Starter synkronisering av alle selskapene til database-1...
Connecting to postgres://database-1.cduqaum6qexq.eu-north-1.rds.amazonaws.com:5432/postgres
Synced 10/50
Synced 20/50
...
Synced 50/50
Done.
Synkronisering fullført!
```

---

## Steg 11: Verifiser at dataene er lagret

Du kan verifisere at dataene er lagret i databasen ved å koble til databasen direkte:

```bash
# Installer PostgreSQL client (hvis ikke allerede installert)
# For Amazon Linux 2:
sudo yum install -y postgresql

# For Ubuntu:
sudo apt install -y postgresql-client

# Koble til databasen
psql -h database-1.cduqaum6qexq.eu-north-1.rds.amazonaws.com -U postgres -d postgres

# Når du er inne i psql, kjør:
SELECT COUNT(*) FROM brreg_companies;
SELECT organisasjonsnummer, navn FROM brreg_companies LIMIT 5;

# For å avslutte psql:
\q
```

---

## Feilsøking

### Feil: "Cannot find module"
```bash
# Sørg for at du har kjørt npm install
npm install

# Bygg på nytt
npm run build
```

### Feil: "ETIMEDOUT" eller "Connection refused"
- Sjekk at EC2-instansen er i samme VPC som database-1
- Sjekk Security Groups: database-1 må tillate innkommende trafikk på port 5432 fra EC2-instansens Security Group
- Sjekk at database-1 er i "available" status i RDS Console

### Feil: "POSTGRES_USER and POSTGRES_PASSWORD must be set"
- Sjekk at `.env` filen eksisterer og inneholder riktige verdier
- Verifiser at du er i riktig mappe (BrRegister)

### Feil: "Could not find companies file"
- Sjekk at `data/companies.json` eksisterer: `ls -la data/`
- Hvis den ikke finnes, kjør `npm run fetch` (eller sjekk at filen er lastet opp til repoet)

---

## Nyttige kommandoer

```bash
# Se loggene fra siste kjøring
npm start

# Hvis du vil kjøre sync direkte uten å bygge først
npm run sync:pg

# Se hvilke filer som er i prosjektet
ls -la

# Se størrelsen på companies.json
du -h data/companies.json

# Se prosessene som kjører
ps aux | grep node
```

---

## Automatisk kjøring (valgfritt)

Hvis du vil at programmet skal kjøre automatisk ved oppstart av EC2-instansen, kan du sette opp en systemd service eller bruke cron.

### Eksempel med systemd:

Opprett en service-fil:
```bash
sudo nano /etc/systemd/system/br-register.service
```

Legg til:
```ini
[Unit]
Description=BR Register Sync Service
After=network.target

[Service]
Type=oneshot
User=ec2-user
WorkingDirectory=/home/ec2-user/BrRegister
Environment="NODE_ENV=production"
ExecStart=/usr/bin/npm start
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Aktiver og start:
```bash
sudo systemctl daemon-reload
sudo systemctl enable br-register.service
sudo systemctl start br-register.service
```

---

## Neste steg

Når programmet har kjørt, vil alle selskapene være lagret i `brreg_companies` tabellen i database-1. Du kan nå:
- Koble til databasen og kjøre spørringer
- Bygge et API for å søke i dataene
- Sette opp automatiske oppdateringer

