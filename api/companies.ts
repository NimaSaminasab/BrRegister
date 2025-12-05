import { VercelRequest, VercelResponse } from '@vercel/node';
import { fetchCompaniesFromPostgres } from '../src/print-postgres-companies';

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  try {
    const companies = await fetchCompaniesFromPostgres();
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (request.method === 'OPTIONS') {
      return response.status(200).end();
    }
    
    return response.status(200).json(companies);
  } catch (error) {
    console.error('Failed to fetch companies', error);
    return response.status(500).json({ 
      message: 'Kunne ikke hente selskaper', 
      error: (error as Error).message 
    });
  }
}
