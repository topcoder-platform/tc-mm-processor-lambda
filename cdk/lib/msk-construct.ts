import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as msk from 'aws-cdk-lib/aws-msk';
import { Construct } from 'constructs';

export interface MskConstructProps {
  vpc: ec2.IVpc;
  clusterName: string;
  existingMskClusterArn?: string;
  privateSubnetIds?: string[]; // Specific subnet IDs to use for MSK
}

export class MskConstruct extends Construct {
  public readonly mskClusterArn: string;
  // No security group needed - Lambda and MSK communicate via VPC default security group

  constructor(scope: Construct, id: string, props: MskConstructProps) {
    super(scope, id);

    const { vpc, clusterName, existingMskClusterArn, privateSubnetIds } = props;

    if (existingMskClusterArn) {
      // Use existing MSK cluster
      console.log(`Using existing MSK cluster: ${existingMskClusterArn}`);
      this.mskClusterArn = existingMskClusterArn;
    } else {
      // Create new MSK cluster
      console.log('Creating new MSK cluster without security groups');

      // --- MSK Configuration (for auto topic creation) ---
      const mskConfiguration = new msk.CfnConfiguration(this, 'MskConfiguration', {
        name: `${clusterName}-config`,
        serverProperties: 'auto.create.topics.enable=true\n', // Use \n for newline if adding more prop
      });

      // --- MSK Cluster --- 
      const mskCluster = new msk.CfnCluster(this, 'MatchScorerMSKCluster', {
        clusterName: clusterName,
        kafkaVersion: '3.4.0',
        numberOfBrokerNodes: 2,
        brokerNodeGroupInfo: {
          instanceType: 'kafka.t3.small',
          clientSubnets: privateSubnetIds || vpc.privateSubnets.map(subnet => subnet.subnetId),
          // No security groups assigned - MSK will use VPC default security group
          storageInfo: {
            ebsStorageInfo: { volumeSize: 100 },
          },
        },
        encryptionInfo: {
          encryptionInTransit: {
            clientBroker: 'TLS',
            inCluster: true,
          },
        },
        // Associate the configuration with the cluster
        configurationInfo: {
          arn: mskConfiguration.attrArn,
          revision: mskConfiguration.attrLatestRevisionRevision,
        }
      });

      this.mskClusterArn = mskCluster.attrArn;
    }
    
    console.log('MSK and Lambda will communicate via VPC default security group');
  }
}
