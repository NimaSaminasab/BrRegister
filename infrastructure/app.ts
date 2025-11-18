import * as cdk from 'aws-cdk-lib';
import { BrRegisterStack } from './br-register-stack';
import * as dotenv from 'dotenv';

dotenv.config();

const app = new cdk.App();

// La CDK automatisk hente account og region hvis AWS credentials er konfigurert
// Hvis ikke, må de settes via miljøvariabler eller .env fil
const env: cdk.Environment | undefined = 
  process.env.CDK_DEFAULT_ACCOUNT || process.env.AWS_ACCOUNT_ID
    ? {
        account: process.env.CDK_DEFAULT_ACCOUNT || process.env.AWS_ACCOUNT_ID,
        region: process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || 'eu-north-1',
      }
    : undefined; // La CDK prøve å hente automatisk

new BrRegisterStack(app, 'BrRegisterStack', {
  ...(env && { env }),
  tableName: process.env.DYNAMODB_TABLE_NAME || 'br-register-companies',
  description: 'Stack for lagring av norske bedriftsdata fra Brønnøysundregistrene',
});

app.synth();

