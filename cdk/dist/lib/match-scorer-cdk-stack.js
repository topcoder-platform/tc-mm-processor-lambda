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
exports.MatchScorerCdkStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const logs = __importStar(require("aws-cdk-lib/aws-logs"));
const path = __importStar(require("path"));
const ssm = __importStar(require("aws-cdk-lib/aws-ssm"));
// Import the new constructs
const vpc_construct_1 = require("./vpc-construct");
const msk_construct_1 = require("./msk-construct");
const ecs_construct_1 = require("./ecs-construct");
const lambda_constructs_1 = require("./lambda-constructs");
// Import the configuration
const config_1 = require("./config");
class MatchScorerCdkStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        // --- Base Infrastructure ---
        const vpcConstruct = new vpc_construct_1.VpcConstruct(this, 'VpcConstruct');
        const logGroup = new logs.LogGroup(this, 'MatchScorerLogGroup', {
            logGroupName: config_1.config.logGroupName,
            retention: logs.RetentionDays.ONE_MONTH,
            removalPolicy: cdk.RemovalPolicy.DESTROY, // For POC only
        });
        // --- MSK Construct ---
        const mskConstruct = new msk_construct_1.MskConstruct(this, 'MskConstruct', {
            vpc: vpcConstruct.vpc,
            clusterName: config_1.config.mskClusterName,
        });
        // --- ECS Construct ---
        const ecsConstruct = new ecs_construct_1.EcsConstruct(this, 'EcsConstruct', {
            vpc: vpcConstruct.vpc,
            logGroup: logGroup,
            clusterName: config_1.config.ecsClusterName,
            dockerImagePath: path.join(__dirname, '..', '..', 'java-scorer'),
            containerEnvironment: {
                AWS_REGION: cdk.Stack.of(this).region,
            }
        });
        // --- Lambda Constructs ---
        const submissionWatcherLambda = new lambda_constructs_1.SubmissionWatcherLambdaConstruct(this, 'SubmissionWatcherLambda', {
            vpc: vpcConstruct.vpc,
            mskClusterArn: mskConstruct.mskCluster.attrArn,
            mskSecurityGroup: mskConstruct.mskSecurityGroup,
            ecsClusterName: ecsConstruct.cluster.clusterName,
            ecsTaskDefinitionArn: ecsConstruct.taskDefinition.taskDefinitionArn,
            ecsSubnetIds: vpcConstruct.vpc.publicSubnets.map(subnet => subnet.subnetId),
            ecsTaskSecurityGroupId: ecsConstruct.taskSecurityGroup.securityGroupId,
            ecsContainerName: ecsConstruct.container.containerName,
            taskExecutionRoleArn: ecsConstruct.taskExecutionRole.roleArn,
            taskRoleArn: ecsConstruct.taskRole.roleArn,
            environmentVariables: {
                TASK_TIMEOUT_SECONDS: config_1.config.taskTimeoutSeconds,
                MAX_RETRIES: config_1.config.maxRetries,
                AUTH0_URL: config_1.config.auth0Url,
                AUTH0_AUDIENCE: config_1.config.auth0Audience,
                AUTH0_CLIENT_ID: config_1.config.auth0ClientId,
                AUTH0_CLIENT_SECRET: config_1.config.auth0ClientSecret,
                AUTH0_PROXY_URL: config_1.config.auth0ProxyUrl,
            },
            lambdaCodePath: path.join(__dirname, '..', '..', 'submission-watcher-lambda')
        });
        const testDataSenderLambda = new lambda_constructs_1.TestDataSenderLambdaConstruct(this, 'TestDataSenderLambda', {
            vpc: vpcConstruct.vpc,
            mskClusterArn: mskConstruct.mskCluster.attrArn,
            mskSecurityGroup: mskConstruct.mskSecurityGroup,
            environmentVariables: {
                MSK_CLUSTER_ARN: mskConstruct.mskCluster.attrArn,
                TARGET_TOPIC: 'submission.notification.create'
            },
            lambdaCodePath: path.join(__dirname, '..', '..', 'test-data-sender-lambda')
        });
        // --- Outputs (Referencing construct properties) ---
        new cdk.CfnOutput(this, 'EcsClusterArn', {
            value: ecsConstruct.cluster.clusterArn,
            description: 'ARN of the ECS cluster',
        });
        new cdk.CfnOutput(this, 'EcsTaskDefinitionArn', {
            value: ecsConstruct.taskDefinition.taskDefinitionArn,
            description: 'ARN of the ECS task definition',
        });
        new cdk.CfnOutput(this, 'WatcherLambdaFunctionArn', {
            value: submissionWatcherLambda.lambdaFunction.functionArn,
            description: 'ARN of the Submission Watcher Lambda function',
        });
        new cdk.CfnOutput(this, 'EcrRepositoryUri', {
            value: ecsConstruct.dockerImage.repository.repositoryUri,
            description: 'URI of the ECR repository',
        });
        new cdk.CfnOutput(this, 'MskClusterArnOutput', {
            value: mskConstruct.mskCluster.attrArn,
            description: 'ARN of the MSK cluster',
        });
        new cdk.CfnOutput(this, 'PublisherLambdaFunctionName', {
            value: testDataSenderLambda.lambdaFunction.functionName,
            description: 'Name of the Test Data Sender Lambda function',
        });
        // --- Parameter Store Setup for Dev Challenge ---
        // Challenge config
        new ssm.CfnParameter(this, 'DevChallengeConfig', {
            name: `/scorer/challenges/${config_1.devChallengeId}/config`,
            type: 'String',
            value: JSON.stringify({
                name: 'Marathon Match 160',
                active: true,
                scorers: config_1.devScorers.map(scorer => scorer.name),
                submissionApiUrl: config_1.config.submissionApiUrl,
                reviewScorecardId: config_1.config.reviewScorecardId,
                reviewTypeName: config_1.config.reviewTypeName
            }),
        });
        // Scorer configs
        config_1.devScorers.forEach((scorer) => {
            new ssm.CfnParameter(this, `DevScorerConfig${scorer.name}`, {
                name: `/scorer/challenges/${config_1.devChallengeId}/scorers/${scorer.name}/config`,
                type: 'String',
                value: JSON.stringify({
                    name: scorer.name,
                    testerClass: scorer.testerClass,
                    timeLimit: scorer.timeLimit,
                    timeout: scorer.timeout,
                    compileTimeout: scorer.compileTimeout,
                    startSeed: scorer.startSeed,
                    numberOfTests: scorer.numberOfTests,
                    phases: scorer.phases
                }),
            });
        });
    }
}
exports.MatchScorerCdkStack = MatchScorerCdkStack;
//# sourceMappingURL=match-scorer-cdk-stack.js.map