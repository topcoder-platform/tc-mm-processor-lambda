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
exports.EcsConstruct = void 0;
const ec2 = __importStar(require("aws-cdk-lib/aws-ec2"));
const ecs = __importStar(require("aws-cdk-lib/aws-ecs"));
const ecr_assets = __importStar(require("aws-cdk-lib/aws-ecr-assets"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const constructs_1 = require("constructs");
const path = __importStar(require("path"));
class EcsConstruct extends constructs_1.Construct {
    constructor(scope, id, props) {
        super(scope, id);
        const { vpc, logGroup, clusterName, containerEnvironment } = props;
        const dockerImagePath = path.join(__dirname, '..', '..', 'java-scorer');
        // --- ECS Cluster ---
        this.cluster = new ecs.Cluster(this, 'MatchScorerCluster', {
            vpc,
            clusterName: clusterName,
        });
        // --- ECS Task Execution Role ---
        this.taskExecutionRole = new iam.Role(this, 'TaskExecutionRole', {
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy')
            ]
        });
        // --- ECS Task Role ---
        // Note: The original stack had the same policy as the execution role.
        // You might need to add specific permissions for your application logic here.
        this.taskRole = new iam.Role(this, 'TaskRole', {
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy')
            ]
        });
        // Add SSM and S3 permissions to taskRole
        this.taskRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMReadOnlyAccess'));
        this.taskRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                's3:GetObject',
                's3:PutObject'
            ],
            resources: ['arn:aws:s3:::topcoder-submissions/*']
        }));
        // --- ECS Task Definition ---
        this.taskDefinition = new ecs.FargateTaskDefinition(this, 'MatchScorerTask', {
            memoryLimitMiB: 512,
            cpu: 256,
            executionRole: this.taskExecutionRole,
            taskRole: this.taskRole,
            runtimePlatform: {
                operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
                cpuArchitecture: ecs.CpuArchitecture.X86_64,
            },
        });
        // --- Docker Image Asset ---
        this.dockerImage = new ecr_assets.DockerImageAsset(this, 'MatchScorerImage', {
            directory: dockerImagePath, // Use new java-scorer path
            platform: ecr_assets.Platform.LINUX_AMD64,
        });
        // --- ECS Container Definition ---
        this.container = this.taskDefinition.addContainer('MatchScorerContainer', {
            image: ecs.ContainerImage.fromDockerImageAsset(this.dockerImage),
            logging: ecs.LogDrivers.awsLogs({
                streamPrefix: 'ecs',
                logGroup,
            }),
            environment: containerEnvironment,
        });
        // --- ECS Task Security Group ---
        this.taskSecurityGroup = new ec2.SecurityGroup(this, 'TaskSecurityGroup', {
            vpc,
            description: 'Security group for the Match Scorer ECS task',
            allowAllOutbound: true,
        });
    }
}
exports.EcsConstruct = EcsConstruct;
//# sourceMappingURL=ecs-construct.js.map