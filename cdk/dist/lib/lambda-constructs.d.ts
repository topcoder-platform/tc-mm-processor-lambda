import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
interface SubmissionWatcherLambdaProps {
    vpc: ec2.IVpc;
    mskClusterArn: string;
    mskSecurityGroup: ec2.ISecurityGroup;
    ecsClusterName: string;
    ecsTaskDefinitionArn: string;
    ecsSubnetIds: string[];
    ecsTaskSecurityGroupId: string;
    ecsContainerName: string;
    taskExecutionRoleArn: string;
    taskRoleArn: string;
    environmentVariables: {
        [key: string]: string;
    };
    lambdaCodePath: string;
}
export declare class SubmissionWatcherLambdaConstruct extends Construct {
    readonly lambdaFunction: lambda.Function;
    readonly lambdaRole: iam.Role;
    constructor(scope: Construct, id: string, props: SubmissionWatcherLambdaProps);
}
interface TestDataSenderLambdaProps {
    vpc: ec2.IVpc;
    mskClusterArn: string;
    mskSecurityGroup: ec2.ISecurityGroup;
    environmentVariables: {
        [key: string]: string;
    };
    lambdaCodePath: string;
}
export declare class TestDataSenderLambdaConstruct extends Construct {
    readonly lambdaFunction: lambda.Function;
    readonly lambdaRole: iam.Role;
    constructor(scope: Construct, id: string, props: TestDataSenderLambdaProps);
}
export {};
