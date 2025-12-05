# Deploying to Vercel

This guide will help you deploy the BR-register app to Vercel.

## Prerequisites

1. A Vercel account (sign up at https://vercel.com)
2. Vercel CLI installed: `npm i -g vercel`
3. PostgreSQL database credentials

## Step 1: Install Dependencies

Make sure you have all dependencies installed:

```bash
npm install
```

## Step 2: Set Up Environment Variables

You need to configure the following environment variables in Vercel:

1. Go to your Vercel project settings
2. Navigate to "Environment Variables"
3. Add the following variables:

```
POSTGRES_HOST=your-postgres-host
POSTGRES_PORT=5432
POSTGRES_DB=postgres
POSTGRES_TABLE=brreg_companies
POSTGRES_USER=your-postgres-user
POSTGRES_PASSWORD=your-postgres-password
POSTGRES_SSL=true
```

Or if you need to disable SSL validation:

```
POSTGRES_SSL={"rejectUnauthorized":false}
```

## Step 3: Deploy to Vercel

### Option A: Using Vercel CLI

```bash
# Login to Vercel
vercel login

# Deploy (first time)
vercel

# Deploy to production
vercel --prod
```

### Option B: Using GitHub Integration

1. Push your code to GitHub
2. Go to https://vercel.com/new
3. Import your GitHub repository
4. Vercel will automatically detect the configuration
5. Add your environment variables
6. Click "Deploy"

## Step 4: Verify Deployment

After deployment, you can access:

- Health check: `https://your-app.vercel.app/healthz`
- Companies API: `https://your-app.vercel.app/companies`

## API Endpoints

- `GET /healthz` - Health check endpoint
- `GET /companies` - Get all companies from PostgreSQL

## Important Notes

1. **Puppeteer**: Puppeteer may not work on Vercel's serverless functions due to size limitations. If you need Puppeteer, consider using a different service or Vercel's Edge Functions.

2. **Database Connections**: Make sure your PostgreSQL database allows connections from Vercel's IP addresses. You may need to whitelist Vercel's IPs or use a connection pooler.

3. **Environment Variables**: Never commit sensitive credentials. Always use Vercel's environment variables feature.

4. **Build Time**: The build process compiles TypeScript, which may take a few minutes on the first deployment.

## Troubleshooting

### Build Errors

If you encounter build errors:

1. Check that all dependencies are in `package.json`
2. Ensure TypeScript compiles successfully: `npm run build`
3. Check Vercel build logs for specific errors

### Database Connection Issues

If you can't connect to PostgreSQL:

1. Verify your database credentials
2. Check that your database allows external connections
3. Verify SSL settings match your database configuration
4. Check Vercel function logs for connection errors

### Function Timeout

Vercel has execution time limits:
- Hobby plan: 10 seconds
- Pro plan: 60 seconds

If your queries take longer, consider:
- Optimizing your database queries
- Using pagination
- Implementing caching

## Local Development with Vercel

You can test Vercel functions locally:

```bash
vercel dev
```

This will start a local server that mimics Vercel's environment.

