import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as msk from 'aws-cdk-lib/aws-msk';
import { Construct } from 'constructs';

interface MskConstructProps {
  vpc: ec2.IVpc;
  clusterName: string;
}

export class MskConstruct extends Construct {
  public readonly mskCluster: msk.CfnCluster;
  public readonly mskSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: MskConstructProps) {
    super(scope, id);

    const { vpc, clusterName } = props;

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
    this.mskCluster = new msk.CfnCluster(this, 'MatchScorerMSKCluster', {
      clusterName: clusterName,
      kafkaVersion: '3.4.0',
      numberOfBrokerNodes: 2,
      brokerNodeGroupInfo: {
        instanceType: 'kafka.t3.small',
        clientSubnets: vpc.privateSubnets.map(subnet => subnet.subnetId),
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
  }
} 