import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as msk from 'aws-cdk-lib/aws-msk';
import { Construct } from 'constructs';

interface MskConstructProps {
  vpc: ec2.IVpc;
  clusterName: string;
  existingMskClusterArn?: string;
  privateSubnetIds?: string[]; // Specific subnet IDs to use for MSK
}

export class MskConstruct extends Construct {
  public readonly mskClusterArn: string;
  public readonly mskSecurityGroup: ec2.ISecurityGroup;

  constructor(scope: Construct, id: string, props: MskConstructProps) {
    super(scope, id);

    const { vpc, clusterName, existingMskClusterArn, privateSubnetIds } = props;

    if (existingMskClusterArn) {
      // Use existing MSK cluster
      console.log(`Using existing MSK cluster: ${existingMskClusterArn}`);
      this.mskClusterArn = existingMskClusterArn;

      // Extract cluster name from ARN to find security group
      // ARN format: arn:aws:kafka:region:account:cluster/cluster-name/uuid
      const clusterNameFromArn = existingMskClusterArn.split('/')[1];
      
      // Try to lookup existing security group by name or tags
      // Note: You may need to adjust this based on your actual SG naming convention
      this.mskSecurityGroup = ec2.SecurityGroup.fromLookupByName(
        this,
        'ExistingMskSecurityGroup',
        `${clusterNameFromArn}-msk-sg`,
        vpc
      );
    } else {
      // Create new MSK cluster
      console.log('Creating new MSK cluster');
      
      // --- Dedicated Security Group for MSK Cluster ---
      this.mskSecurityGroup = new ec2.SecurityGroup(this, 'MskSecurityGroup', {
        vpc,
        description: 'Security group for MSK cluster',
        allowAllOutbound: true,
      });

      // Allow internal MSK communication
      this.mskSecurityGroup.addIngressRule(
        this.mskSecurityGroup,
        ec2.Port.tcp(9094),
        'Allow internal MSK broker communication (TLS)'
      );
      // Potentially add ZK ports if needed: ec2.Port.tcp(2181)

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
          securityGroups: [this.mskSecurityGroup.securityGroupId],
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
  }
}
