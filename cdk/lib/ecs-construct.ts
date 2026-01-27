import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'path';

interface EcsConstructProps {
    vpc: ec2.IVpc;
    logGroup: logs.ILogGroup;
    clusterName: string;
    dockerImagePath: string;
    containerEnvironment: { [key: string]: string };
    taskExecutionRoleArn: string;
    taskRoleArn: string;
}

export class EcsConstruct extends Construct {
    public readonly cluster: ecs.Cluster;
    public readonly taskDefinition: ecs.FargateTaskDefinition;
    public readonly container: ecs.ContainerDefinition;
    public readonly taskSecurityGroup: ec2.SecurityGroup;
    public readonly dockerImage: ecr_assets.DockerImageAsset;

    constructor(scope: Construct, id: string, props: EcsConstructProps) {
        super(scope, id);

        const { vpc, logGroup, clusterName, containerEnvironment, taskExecutionRoleArn, taskRoleArn } = props;
        const dockerImagePath = path.join(__dirname, '..', '..', 'java-scorer');

        // Import the manually created roles using their ARNs
        const taskExecutionRole = iam.Role.fromRoleArn(this, 'ImportedTaskExecutionRole', taskExecutionRoleArn);
        const taskRole = iam.Role.fromRoleArn(this, 'ImportedTaskRole', taskRoleArn);

        // --- ECS Cluster ---
        this.cluster = new ecs.Cluster(this, 'MatchScorerCluster', {
            vpc,
            clusterName: clusterName,
        });

        // --- ECS Task Definition ---
        this.taskDefinition = new ecs.FargateTaskDefinition(this, 'MatchScorerTask', {
            memoryLimitMiB: 512,
            cpu: 256,
            executionRole: taskExecutionRole,
            taskRole: taskRole,
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