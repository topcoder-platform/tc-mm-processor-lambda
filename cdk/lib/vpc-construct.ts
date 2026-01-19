import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

interface VpcConstructProps {
  existingVpcId?: string;
  existingPublicSubnetIds?: string;  // Comma-separated
  existingPrivateSubnetIds?: string; // Comma-separated
  existingSecurityGroupIds?: string; // Comma-separated
}

export class VpcConstruct extends Construct {
  public readonly vpc: ec2.IVpc;
  public readonly publicSubnets: ec2.ISubnet[];
  public readonly privateSubnets: ec2.ISubnet[];
  public readonly securityGroups: ec2.ISecurityGroup[];

  constructor(scope: Construct, id: string, props?: VpcConstructProps) {
    super(scope, id);

    if (props?.existingVpcId) {
      // Use existing VPC
      console.log(`Using existing VPC: ${props.existingVpcId}`);
      
      // Import VPC
      this.vpc = ec2.Vpc.fromLookup(this, 'ExistingVpc', {
        vpcId: props.existingVpcId,
      });

      // Import subnets if provided
      if (props.existingPublicSubnetIds) {
        const publicSubnetIds = props.existingPublicSubnetIds.split(',').map(s => s.trim());
        console.log(`Using existing public subnets: ${publicSubnetIds.join(', ')}`);
        this.publicSubnets = publicSubnetIds.map((subnetId, index) =>
          ec2.Subnet.fromSubnetId(this, `PublicSubnet${index}`, subnetId)
        );
      } else {
        // Use VPC's public subnets
        this.publicSubnets = this.vpc.publicSubnets;
      }

      if (props.existingPrivateSubnetIds) {
        const privateSubnetIds = props.existingPrivateSubnetIds.split(',').map(s => s.trim());
        console.log(`Using existing private subnets: ${privateSubnetIds.join(', ')}`);
        this.privateSubnets = privateSubnetIds.map((subnetId, index) =>
          ec2.Subnet.fromSubnetId(this, `PrivateSubnet${index}`, subnetId)
        );
      } else {
        // Use VPC's private subnets
        this.privateSubnets = this.vpc.privateSubnets;
      }

      // Import security groups if provided
      if (props.existingSecurityGroupIds) {
        const securityGroupIds = props.existingSecurityGroupIds.split(',').map(s => s.trim());
        console.log(`Using existing security groups: ${securityGroupIds.join(', ')}`);
        this.securityGroups = securityGroupIds.map((sgId, index) =>
          ec2.SecurityGroup.fromSecurityGroupId(this, `SecurityGroup${index}`, sgId, {
            allowAllOutbound: true,
          })
        );
      } else {
        // No specific security groups provided
        this.securityGroups = [];
      }
    } else {
      // Create new VPC
      console.log('Creating new VPC');
      const newVpc = new ec2.Vpc(this, 'MatchScorerVpc', {
        maxAzs: 2,
        subnetConfiguration: [
          {
            cidrMask: 24,
            name: 'public-subnet',
            subnetType: ec2.SubnetType.PUBLIC,
          },
          {
            cidrMask: 24,
            name: 'private-subnet',
            subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          },
        ],
        natGateways: 1,
      });

      this.vpc = newVpc;
      this.publicSubnets = newVpc.publicSubnets;
      this.privateSubnets = newVpc.privateSubnets;
      this.securityGroups = [];
    }
  }
} 