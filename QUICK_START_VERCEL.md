# Quick Start: Deploy to Vercel

## 1. Install Vercel CLI (if not already installed)

```bash
npm i -g vercel
```

## 2. Login to Vercel

```bash
vercel login
```

## 3. Deploy

```bash
# First deployment
vercel

# Deploy to production
vercel --prod
```

## 4. Set Environment Variables

After the first deployment, set your environment variables in Vercel dashboard:

1. Go to your project on https://vercel.com
2. Settings → Environment Variables
3. Add these variables:

```
POSTGRES_HOST=your-postgres-host
POSTGRES_PORT=5432
POSTGRES_DB=postgres
POSTGRES_TABLE=brreg_companies
POSTGRES_USER=your-postgres-user
POSTGRES_PASSWORD=your-postgres-password
POSTGRES_SSL=true
```

## 5. Redeploy

After adding environment variables, redeploy:

```bash
vercel --prod
```

## Your API Endpoints

- `https://your-app.vercel.app/healthz` - Health check
- `https://your-app.vercel.app/companies` - Get all companies

## GitHub Integration (Alternative)

1. Push your code to GitHub
2. Go to https://vercel.com/new
3. Import your repository
4. Add environment variables
5. Deploy!

