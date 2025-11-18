import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';

export interface BrRegisterStackProps extends cdk.StackProps {
  tableName?: string;
}

export class BrRegisterStack extends cdk.Stack {
  public readonly companiesTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props?: BrRegisterStackProps) {
    super(scope, id, props);

    const tableName = props?.tableName || 'br-register-companies';

    // Opprett DynamoDB tabell for bedrifter
    this.companiesTable = new dynamodb.Table(this, 'CompaniesTable', {
      tableName: tableName,
      partitionKey: {
        name: 'organisasjonsnummer',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, // On-demand pricing
      removalPolicy: cdk.RemovalPolicy.RETAIN, // Behold tabellen ved stack deletion
      pointInTimeRecovery: true, // Aktiver PITR for backup
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });

    // Legg til Global Secondary Index (GSI) for søk på navn
    // Merk: Navn må være en flat string i dataen for at dette skal fungere
    this.companiesTable.addGlobalSecondaryIndex({
      indexName: 'navn-index',
      partitionKey: {
        name: 'navn',
        type: dynamodb.AttributeType.STRING,
      },
    });

    // Legg til GSI for søk på organisasjonsform kode
    this.companiesTable.addGlobalSecondaryIndex({
      indexName: 'organisasjonsform-kode-index',
      partitionKey: {
        name: 'organisasjonsformKode',
        type: dynamodb.AttributeType.STRING,
      },
    });

    // Legg til GSI for søk på næringskode
    this.companiesTable.addGlobalSecondaryIndex({
      indexName: 'naeringskode-index',
      partitionKey: {
        name: 'naeringskode1Kode',
        type: dynamodb.AttributeType.STRING,
      },
    });

    // Output tabellnavn og ARN
    new cdk.CfnOutput(this, 'TableName', {
      value: this.companiesTable.tableName,
      description: 'DynamoDB tabellnavn for bedrifter',
    });

    new cdk.CfnOutput(this, 'TableArn', {
      value: this.companiesTable.tableArn,
      description: 'DynamoDB tabell ARN',
    });
  }
}

