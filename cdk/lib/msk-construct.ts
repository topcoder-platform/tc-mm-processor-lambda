import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as msk from 'aws-cdk-lib/aws-msk';
import { Construct } from 'constructs';

export interface MskConstructProps {
  vpc: ec2.IVpc;
  clusterName: string;
  existingMskClusterArn?: string;
  privateSubnetIds?: string[]; // Specific subnet IDs to use for MSK
  securityGroups?: ec2.ISecurityGroup[]; // Security groups from VPC construct
}

export class MskConstruct extends Construct {
  public readonly mskClusterArn: string;
  public readonly mskSecurityGroup: ec2.ISecurityGroup;

  constructor(scope: Construct, id: string, props: MskConstructProps) {
    super(scope, id);

    const { vpc, clusterName, existingMskClusterArn, privateSubnetIds, securityGroups } = props;

    if (existingMskClusterArn) {
      // Use existing MSK cluster
      console.log(`Using existing MSK cluster: ${existingMskClusterArn}`);
      this.mskClusterArn = existingMskClusterArn;

      // Use security groups from VPC construct if provided, otherwise create a default one
      if (securityGroups && securityGroups.length > 0) {
        console.log('Using security groups from VPC construct');
        this.mskSecurityGroup = securityGroups[0]; // Use the first security group
      } else {
        console.log('Creating default security group for existing MSK cluster');
        this.mskSecurityGroup = new ec2.SecurityGroup(this, 'DefaultMskSecurityGroup', {
          vpc,
          description: 'Default security group for existing MSK cluster',
          allowAllOutbound: true,
        });
      }
    } else {
      // Create new MSK cluster
      console.log('Creating new MSK cluster');
      
      // Use security groups from VPC construct if provided, otherwise create dedicated MSK security group
      if (securityGroups && securityGroups.length > 0) {
        console.log('Using security groups from VPC construct for new MSK cluster');
        this.mskSecurityGroup = securityGroups[0];
        
        // Add MSK-specific rules to the existing security group
        this.mskSecurityGroup.addIngressRule(
          this.mskSecurityGroup,
          ec2.Port.tcp(9094),
          'Allow MSK broker communication (TLS)'
        );
      } else {
        console.log('Creating dedicated security group for new MSK cluster');
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
      }

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
