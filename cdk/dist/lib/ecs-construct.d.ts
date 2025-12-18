import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
interface EcsConstructProps {
    vpc: ec2.IVpc;
    logGroup: logs.ILogGroup;
    clusterName: string;
    dockerImagePath: string;
    containerEnvironment: {
        [key: string]: string;
    };
}
export declare class EcsConstruct extends Construct {
    readonly cluster: ecs.Cluster;
    readonly taskDefinition: ecs.FargateTaskDefinition;
    readonly container: ecs.ContainerDefinition;
    readonly taskExecutionRole: iam.Role;
    readonly taskRole: iam.Role;
    readonly taskSecurityGroup: ec2.SecurityGroup;
    readonly dockerImage: ecr_assets.DockerImageAsset;
    constructor(scope: Construct, id: string, props: EcsConstructProps);
}
export {};
