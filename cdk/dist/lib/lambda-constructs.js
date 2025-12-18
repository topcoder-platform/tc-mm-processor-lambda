"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TestDataSenderLambdaConstruct = exports.SubmissionWatcherLambdaConstruct = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const ec2 = __importStar(require("aws-cdk-lib/aws-ec2"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const constructs_1 = require("constructs");
class SubmissionWatcherLambdaConstruct extends constructs_1.Construct {
    constructor(scope, id, props) {
        super(scope, id);
        const { vpc, mskClusterArn, mskSecurityGroup, ecsClusterName, ecsTaskDefinitionArn, ecsSubnetIds, ecsTaskSecurityGroupId, ecsContainerName, taskExecutionRoleArn, taskRoleArn, environmentVariables, lambdaCodePath } = props;
        // --- Lambda Execution Role ---
        this.lambdaRole = new iam.Role(this, 'WatcherLambdaRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
            ],
        });
        // Permissions to run ECS Task
        this.lambdaRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['ecs:RunTask', 'ecs:DescribeTasks', 'ecs:StopTask', 'ecs:ListTasks'],
            resources: ['*'], // Consider scoping this down if possible
        }));
        // Permissions for MSK Event Source Mapping & VPC access
        this.lambdaRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'kafka:DescribeCluster',
                'kafka:GetBootstrapBrokers',
                'kafka:ListClusters',
                'ec2:DescribeNetworkInterfaces',
                'ec2:CreateNetworkInterface',
                'ec2:DeleteNetworkInterface',
                'ec2:DescribeSecurityGroups',
                'ec2:DescribeSubnets',
                'ec2:DescribeVpcs'
            ],
            resources: ['*'], // Keep broad for simplicity
        }));
        // Permissions to pass ECS roles
        this.lambdaRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['iam:PassRole'],
            resources: [taskExecutionRoleArn, taskRoleArn],
            // conditions: { // Optional condition
            //   StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' }
            // }
        }));
        // Add SSM permissions for Parameter Store config fetch
        this.lambdaRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['ssm:GetParameter', 'ssm:GetParameters'],
            resources: ['arn:aws:ssm:*:*:parameter/scorer/*'],
        }));
        // --- Lambda Function ---
        this.lambdaFunction = new lambda.Function(this, 'SubmissionWatcherLambda', {
            functionName: 'SubmissionWatcherLambda',
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(lambdaCodePath, {
                bundling: {
                    image: lambda.Runtime.NODEJS_20_X.bundlingImage,
                    command: ['bash', '-c', 'npm install && cp -R . /asset-output'],
                    user: 'root',
                },
            }),
            timeout: cdk.Duration.seconds(60),
            memorySize: 128,
            role: this.lambdaRole,
            environment: {
                ...environmentVariables, // Spread existing env vars
                ECS_CLUSTER: ecsClusterName,
                ECS_TASK_DEFINITION: ecsTaskDefinitionArn,
                ECS_SUBNETS: ecsSubnetIds.join(','),
                ECS_SECURITY_GROUPS: ecsTaskSecurityGroupId,
                ECS_CONTAINER_NAME: ecsContainerName,
            },
            vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        });
        // --- MSK Event Source Mapping ---
        const eventSourceMapping = new lambda.CfnEventSourceMapping(this, 'KafkaEventSourceMapping', {
            functionName: this.lambdaFunction.functionName,
            eventSourceArn: mskClusterArn,
            topics: ['submission.notification.create'],
            batchSize: 100,
            startingPosition: 'TRIM_HORIZON',
            maximumBatchingWindowInSeconds: 1
        });
        // --- Allow Lambda to connect to MSK ---
        mskSecurityGroup.addIngressRule(this.lambdaFunction.connections.securityGroups[0], ec2.Port.tcp(9094), // Default TLS port for Kafka
        'Allow Kafka TLS traffic from Scorer Lambda ESM');
    }
}
exports.SubmissionWatcherLambdaConstruct = SubmissionWatcherLambdaConstruct;
class TestDataSenderLambdaConstruct extends constructs_1.Construct {
    constructor(scope, id, props) {
        super(scope, id);
        const { vpc, mskClusterArn, mskSecurityGroup, environmentVariables, lambdaCodePath } = props;
        // --- Publisher Lambda Role ---
        this.lambdaRole = new iam.Role(this, 'PublisherLambdaRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
            ],
        });
        // Grant permissions to interact with the specific MSK cluster
        this.lambdaRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'kafka:DescribeCluster',
                'kafka:GetBootstrapBrokers',
                'kafka:CreateTopic', // Needed by the producer code potentially
                'kafka:DescribeTopics'
            ],
            resources: [mskClusterArn], // Scope permissions to this cluster
        }));
        // --- Publisher Lambda Function ---
        this.lambdaFunction = new lambda.Function(this, 'KafkaPublisherFunction', {
            functionName: 'TestDataSenderLambda',
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(lambdaCodePath, {
                bundling: {
                    image: lambda.Runtime.NODEJS_20_X.bundlingImage,
                    command: ['bash', '-c', 'npm install && cp -R . /asset-output'],
                    user: 'root'
                }
            }),
            timeout: cdk.Duration.seconds(30),
            memorySize: 128,
            role: this.lambdaRole,
            vpc: vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
            environment: environmentVariables,
        });
        // --- Allow Publisher Lambda to connect to MSK ---
        mskSecurityGroup.addIngressRule(this.lambdaFunction.connections.securityGroups[0], ec2.Port.tcp(9094), // Default TLS port for Kafka
        'Allow Kafka TLS traffic from Publisher Lambda');
    }
}
exports.TestDataSenderLambdaConstruct = TestDataSenderLambdaConstruct;
//# sourceMappingURL=lambda-constructs.js.map