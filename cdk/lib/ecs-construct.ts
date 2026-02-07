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
    existingTaskSecurityGroupId?: string; // Optional: Use existing security group
}

export class EcsConstruct extends Construct {
    public readonly cluster: ecs.Cluster;
    public readonly taskDefinition: ecs.FargateTaskDefinition;
    public readonly container: ecs.ContainerDefinition;
    public readonly taskSecurityGroup: ec2.ISecurityGroup;
    public readonly dockerImage: ecr_assets.DockerImageAsset;

    constructor(scope: Construct, id: string, props: EcsConstructProps) {
        super(scope, id);

        const { vpc, logGroup, clusterName, containerEnvironment, taskExecutionRoleArn, taskRoleArn, existingTaskSecurityGroupId } = props;
        const dockerImagePath = path.join(__dirname, '..', '..', 'java-scorer');

        // Import the manually created roles using their ARNs with mutable: false
        // This prevents CDK from trying to add policies to these roles
        // 
        // REQUIRED PERMISSIONS FOR THESE ROLES:
        //
        // taskExecutionRole (ECS Task Execution Role):
        // - Trust Policy: Allow ecs-tasks.amazonaws.com to assume this role
        // - Managed Policies:
        //   * AmazonECSTaskExecutionRolePolicy (for pulling images from ECR, writing logs to CloudWatch)
        // - Custom Inline Policies:
        //   * ECR Access: ecr:GetAuthorizationToken, ecr:BatchCheckLayerAvailability, ecr:GetDownloadUrlForLayer, ecr:BatchGetImage
        //     Resource: arn:aws:ecr:REGION:ACCOUNT:repository/cdk-*-container-assets-ACCOUNT-REGION
        //   * CloudWatch Logs: logs:CreateLogStream, logs:PutLogEvents
        //     Resource: arn:aws:logs:REGION:ACCOUNT:log-group:/ecs/match-scorer:*
        // - Resources: ECR repositories, CloudWatch log groups
        //
        // taskRole (ECS Task Role - Application Runtime Permissions):
        // - Trust Policy: Allow ecs-tasks.amazonaws.com to assume this role
        // - Managed Policies:
        //   * AmazonSSMReadOnlyAccess (for reading configuration from Parameter Store)
        // - Custom Inline Policies:
        //   * S3 Access: s3:GetObject, s3:PutObject on arn:aws:s3:::topcoder-submissions/*
        //   * CloudWatch Logs: logs:CreateLogStream, logs:PutLogEvents on /ecs/match-scorer log group
        // - Resources: S3 submission bucket, SSM parameters under /scorer/*, CloudWatch log streams
        //
        const taskExecutionRole = iam.Role.fromRoleArn(
            this, 
            'ImportedTaskExecutionRole', 
            taskExecutionRoleArn,
            { mutable: false } // Prevent CDK from modifying this role
        );
        const taskRole = iam.Role.fromRoleArn(
            this, 
            'ImportedTaskRole', 
            taskRoleArn,
            { mutable: false } // Prevent CDK from modifying this role
        );

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
        // Note: DockerImageAsset will try to grant ECR permissions to the execution role
        // Since we're using imported roles with mutable: false, this will fail silently
        // Ensure your manually created taskExecutionRole has ECR permissions:
        // - ecr:GetAuthorizationToken (on *)
        // - ecr:BatchCheckLayerAvailability, ecr:GetDownloadUrlForLayer, ecr:BatchGetImage
        //   (on arn:aws:ecr:REGION:ACCOUNT:repository/cdk-*-container-assets-*)
        this.dockerImage = new ecr_assets.DockerImageAsset(this, 'MatchScorerImage', {
            directory: dockerImagePath,
            platform: ecr_assets.Platform.LINUX_AMD64,
        });

        // Suppress the automatic permission granting by not calling grantPull
        // The permissions must already exist in the manually created role

        // --- ECS Container Definition ---
        // Use the Docker image asset but note that CDK will attempt to grant ECR permissions
        // Since the execution role is imported with mutable: false, CDK cannot modify it
        // You MUST ensure your manually created execution role has these ECR permissions:
        // 1. ecr:GetAuthorizationToken on resource: *
        // 2. ecr:BatchCheckLayerAvailability on resource: arn:aws:ecr:REGION:ACCOUNT:repository/cdk-*
        // 3. ecr:GetDownloadUrlForLayer on resource: arn:aws:ecr:REGION:ACCOUNT:repository/cdk-*
        // 4. ecr:BatchGetImage on resource: arn:aws:ecr:REGION:ACCOUNT:repository/cdk-*
        //
        // The ECR repository name will be: cdk-hnb659fds-container-assets-ACCOUNT-REGION
        this.container = this.taskDefinition.addContainer('MatchScorerContainer', {
            image: ecs.ContainerImage.fromDockerImageAsset(this.dockerImage),
            logging: ecs.LogDrivers.awsLogs({
                streamPrefix: 'ecs',
                logGroup,
            }),
            environment: containerEnvironment,
        });

        // --- ECS Task Security Group ---
        if (existingTaskSecurityGroupId) {
            // Use existing security group
            this.taskSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
                this, 
                'ExistingTaskSecurityGroup', 
                existingTaskSecurityGroupId
            );
            console.log(`Using existing ECS task security group: ${existingTaskSecurityGroupId}`);
        } else {
            // Create new security group
            this.taskSecurityGroup = new ec2.SecurityGroup(this, 'TaskSecurityGroup', {
                vpc,
                description: 'Security group for the Match Scorer ECS task',
                allowAllOutbound: true,
            });
            console.log('Created new ECS task security group');
        }
    }
} 