import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

interface EcsConstructProps {
    vpc: ec2.IVpc;
    logGroup: logs.ILogGroup;
    clusterName: string;
    ecrRepositoryName: string;      // ECR repository name for pre-built image
    dockerImageTag: string;         // Docker image tag (e.g., 'latest', 'v1.0.0')
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
    public readonly ecrRepository: ecr.IRepository;

    constructor(scope: Construct, id: string, props: EcsConstructProps) {
        super(scope, id);

        const { vpc, logGroup, clusterName, ecrRepositoryName, dockerImageTag, containerEnvironment, taskExecutionRoleArn, taskRoleArn, existingTaskSecurityGroupId } = props;

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
        //     Resource: arn:aws:ecr:REGION:ACCOUNT:repository/YOUR_ECR_REPOSITORY_NAME
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

        // Import the existing ECR repository
        // The Docker image must be built and pushed manually to this repository
        // before deploying the CDK stack
        this.ecrRepository = ecr.Repository.fromRepositoryName(
            this,
            'MatchScorerEcrRepository',
            ecrRepositoryName
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

        // --- ECS Container Definition ---
        // Use pre-built Docker image from ECR repository
        // The image must be built and pushed manually before deployment
        // 
        // IMPORTANT: Your manually created taskExecutionRole must have these ECR permissions:
        // 1. ecr:GetAuthorizationToken on resource: *
        // 2. ecr:BatchCheckLayerAvailability on resource: arn:aws:ecr:REGION:ACCOUNT:repository/YOUR_REPO_NAME
        // 3. ecr:GetDownloadUrlForLayer on resource: arn:aws:ecr:REGION:ACCOUNT:repository/YOUR_REPO_NAME
        // 4. ecr:BatchGetImage on resource: arn:aws:ecr:REGION:ACCOUNT:repository/YOUR_REPO_NAME
        //
        // To build and push the image manually:
        // 1. cd java-scorer
        // 2. aws ecr get-login-password --region REGION | docker login --username AWS --password-stdin ACCOUNT.dkr.ecr.REGION.amazonaws.com
        // 3. docker build -t YOUR_REPO_NAME:TAG .
        // 4. docker tag YOUR_REPO_NAME:TAG ACCOUNT.dkr.ecr.REGION.amazonaws.com/YOUR_REPO_NAME:TAG
        // 5. docker push ACCOUNT.dkr.ecr.REGION.amazonaws.com/YOUR_REPO_NAME:TAG
        this.container = this.taskDefinition.addContainer('MatchScorerContainer', {
            image: ecs.ContainerImage.fromEcrRepository(this.ecrRepository, dockerImageTag),
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