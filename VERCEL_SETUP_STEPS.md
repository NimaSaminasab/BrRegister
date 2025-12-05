# Vercel Setup Steps

Når du kjører `vercel`, vil du bli spurt om følgende:

## 1. Set up and deploy?
**Svar:** `yes` (du har allerede gjort dette)

## 2. Which scope should contain your project?
**Svar:** Velg "nimasaminasab's projects" (trykk Enter)

## 3. Link to existing project?
**Svar:** `No` (hvis dette er første gang du deployer)

## 4. What's your project's name?
**Svar:** Du kan bruke standard navnet "BR-register" eller gi det et annet navn (trykk Enter for standard)

## 5. In which directory is your code located?
**Svar:** `./` (trykk Enter - dette er standard)

## 6. Want to override the settings?
**Svar:** `No` (trykk Enter - vi har allerede konfigurert alt i vercel.json)

Etter dette vil Vercel:
- Bygge prosjektet
- Deploye det
- Gi deg en URL til din app

## Viktig: Sett miljøvariabler

Etter første deploy, må du sette miljøvariablene:

1. Gå til https://vercel.com/dashboard
2. Velg prosjektet ditt
3. Gå til Settings → Environment Variables
4. Legg til:
   - `POSTGRES_HOST`
   - `POSTGRES_PORT`
   - `POSTGRES_DB`
   - `POSTGRES_TABLE`
   - `POSTGRES_USER`
   - `POSTGRES_PASSWORD`
   - `POSTGRES_SSL`

5. Redeploy etter å ha lagt til variablene

