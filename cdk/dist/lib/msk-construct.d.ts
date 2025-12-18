import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as msk from 'aws-cdk-lib/aws-msk';
import { Construct } from 'constructs';
interface MskConstructProps {
    vpc: ec2.IVpc;
    clusterName: string;
}
export declare class MskConstruct extends Construct {
    readonly mskCluster: msk.CfnCluster;
    readonly mskSecurityGroup: ec2.SecurityGroup;
    constructor(scope: Construct, id: string, props: MskConstructProps);
}
export {};
