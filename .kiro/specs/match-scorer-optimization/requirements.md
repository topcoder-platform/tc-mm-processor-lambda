# Match Scorer Performance Optimization Requirements

## Overview

The current Match Scorer solution processes Marathon Match (MM) submissions sequentially, which creates performance bottlenecks and scalability issues. This specification outlines requirements for optimizing the architecture to handle high-volume, concurrent submission processing efficiently.

## Architecture Overview

### Current vs. Optimized Architecture

**Current Sequential Architecture:**
```
MSK → Single Lambda → [SSM + Auth0 + ECS] × N scorers → Complete
      (Sequential)     (Blocking operations)
```

**Optimized Fan-out Architecture:**
```
MSK → Router Lambda → SNS Topic → Multiple SQS Queues → Challenge Lambdas → ECS Tasks
                          ↓              ↓                    ↓              ↓
                     [Validation]   [Per Challenge]      [Cached Configs]  [Async]
                                                             ↓
                                    EventBridge ← ECS Task Completion
                                         ↓
                                    Completion Lambda → Update Status
```

### Detailed Fan-out Flow Example

**Scenario**: MM160 challenge receives 100 submissions simultaneously

**Step 1: MSK to Router Lambda**
```
MSK Topic: submission.notification.create
├── Partition 0: 25 messages → Router Lambda Instance 1
├── Partition 1: 25 messages → Router Lambda Instance 2
├── Partition 2: 25 messages → Router Lambda Instance 3
└── Partition 3: 25 messages → Router Lambda Instance 4
```

**Step 2: Router Lambda Processing**
```javascript
// Router Lambda pseudo-code
exports.handler = async (event) => {
  const messages = event.records;
  const snsPromises = [];
  
  for (const message of messages) {
    const { challengeId, submissionId } = parseMessage(message);
    
    // Validate message
    if (!challengeId || !submissionId) {
      await sendToDLQ(message, 'Invalid message format');
      continue;
    }
    
    // Route to appropriate SNS topic
    const snsMessage = {
      TopicArn: 'arn:aws:sns:region:account:submission-router',
      Message: JSON.stringify({
        challengeId,
        submissionId,
        routingKey: `challenge.${challengeId}`,
        timestamp: new Date().toISOString(),
        correlationId: generateUUID()
      }),
      MessageAttributes: {
        challengeId: { DataType: 'String', StringValue: challengeId }
      }
    };
    
    snsPromises.push(sns.publish(snsMessage).promise());
  }
  
  await Promise.all(snsPromises);
};
```

**Step 3: SNS Fan-out to SQS Queues**
```
SNS Topic: submission-router
├── Filter: challengeId = "mm160" → SQS: submission-challenge-mm160
├── Filter: challengeId = "mm161" → SQS: submission-challenge-mm161
├── Filter: challengeId = "mm162" → SQS: submission-challenge-mm162
└── Default (no filter) → SQS: submission-challenge-default
```

**Step 4: Challenge Lambda Processing**
```javascript
// Challenge-specific Lambda pseudo-code
exports.handler = async (event) => {
  const records = event.Records; // SQS records
  const tasks = [];
  
  for (const record of records) {
    const message = JSON.parse(record.body);
    const { challengeId, submissionId } = message;
    
    try {
      // Use cached configs (loaded at cold start)
      const challengeConfig = await getCachedChallengeConfig(challengeId);
      const scorerConfigs = await getCachedScorerConfigs(challengeId);
      const authToken = await getCachedAuthToken();
      
      // Launch ECS tasks asynchronously for each scorer
      for (const scorerType of challengeConfig.scorers) {
        const taskPromise = launchECSTask({
          challengeId,
          submissionId,
          scorerType,
          scorerConfig: scorerConfigs[scorerType],
          authToken
        });
        tasks.push(taskPromise);
      }
      
      // Don't wait for ECS tasks to complete
      await Promise.all(tasks);
      
    } catch (error) {
      console.error('Processing failed:', error);
      throw error; // Will trigger SQS retry mechanism
    }
  }
};
```

### Real-World Scaling Example

**Peak Load Scenario**: 1000 submissions in 1 minute across 5 active challenges

**Without Fan-out (Current)**:
```
Single Lambda: 1000 submissions × 3 scorers × 30s processing = 25 hours sequential
Result: Massive backlog, timeouts, failures
```

**With Fan-out (Optimized)**:
```
Router Lambda: 1000 messages × 0.1s = 100s total (parallel processing)
Challenge Lambdas: 5 concurrent instances × 200 submissions each × 5s = 1000s total
ECS Tasks: Async execution, no blocking
Result: All submissions processed in ~17 minutes
```

### Message Deduplication Example

**FIFO Queue Configuration**:
```yaml
Queue: submission-challenge-mm160.fifo
Settings:
  - ContentBasedDeduplication: true
  - DeduplicationScope: messageGroup
  - FifoThroughputLimit: perMessageGroupId
```

**Message with Deduplication**:
```json
{
  "QueueUrl": "https://sqs.region.amazonaws.com/account/submission-challenge-mm160.fifo",
  "MessageBody": "{\"submissionId\":\"12345\",\"challengeId\":\"mm160\"}",
  "MessageGroupId": "mm160-submissions",
  "MessageDeduplicationId": "submission-12345-mm160",
  "MessageAttributes": {
    "submissionId": {
      "StringValue": "12345",
      "DataType": "String"
    }
  }
}
```

## Current Architecture Issues

### Sequential Processing Bottlenecks
- Lambda processes Kafka messages sequentially within each batch
- For each submission, multiple synchronous operations occur:
  - Fetches challenge config from SSM Parameter Store
  - Fetches scorer config from SSM (for each scorer type)  
  - Fetches Auth0 token via HTTP call
  - Launches ECS task and waits
  - Repeats for each scorer in the challenge

### Scalability Limitations
- Single Lambda function handles all challenges
- No caching of frequently accessed data
- Auth0 token fetched for every submission
- Synchronous ECS task execution blocks processing

## Business Requirements

### BR-1: High-Volume Processing
**As a** platform operator  
**I want** the system to handle thousands of concurrent submissions  
**So that** Marathon Matches can scale to support large participant volumes

**Acceptance Criteria:**
- System must process at least 1000 submissions per minute
- Processing latency should not exceed 5 seconds per submission
- System should maintain performance during peak submission periods

### BR-2: Challenge Isolation
**As a** platform operator  
**I want** each challenge to be processed independently  
**So that** issues with one challenge don't affect others

**Acceptance Criteria:**
- Failures in one challenge processing don't impact other challenges
- Each challenge can have different scaling requirements
- Challenge-specific configurations are isolated

### BR-3: Cost Optimization
**As a** platform operator  
**I want** to minimize infrastructure costs  
**So that** the platform remains economically viable

**Acceptance Criteria:**
- Reduce redundant API calls through caching
- Optimize Lambda execution time and memory usage
- Minimize ECS task startup overhead

## Functional Requirements

### FR-1: Fan-out Architecture Implementation

#### FR-1.1: Message Router Lambda
**As a** system  
**I want** a dedicated message routing Lambda  
**So that** submissions are distributed efficiently to appropriate processors

**Acceptance Criteria:**
- Router Lambda validates incoming Kafka messages
- Routes messages to challenge-specific queues based on challengeId
- Handles malformed messages gracefully with DLQ
- Logs routing decisions for monitoring

#### FR-1.2: Challenge-Specific Processing Lambdas
**As a** system  
**I want** separate Lambda functions per challenge type  
**So that** processing can be optimized per challenge requirements

**Acceptance Criteria:**
- Each challenge has dedicated Lambda function(s)
- Lambda functions are auto-deployed when new challenges are configured
- Challenge-specific environment variables and configurations
- Independent scaling and monitoring per challenge

#### FR-1.3: SQS/SNS Distribution
**As a** system  
**I want** reliable message distribution using SQS/SNS  
**So that** messages are delivered reliably with proper retry mechanisms

**Acceptance Criteria:**
- SQS queues for each challenge with appropriate visibility timeouts
- Dead Letter Queues (DLQ) for failed message processing
- SNS topics for fan-out to multiple subscribers if needed
- Message deduplication for exactly-once processing

**Detailed Implementation Requirements:**

**SQS Queue Structure:**
- **Primary Queue**: `submission-challenge-{challengeId}` (e.g., `submission-challenge-mm160`)
- **DLQ**: `submission-challenge-{challengeId}-dlq`
- **Global DLQ**: `submission-router-dlq` for router failures

**SNS Topic Structure:**
- **Router Topic**: `submission-router` - receives from MSK, fans out to challenge queues
- **Completion Topic**: `submission-completion` - receives ECS task completion events
- **Error Topic**: `submission-errors` - receives error notifications

**Queue Configuration:**
```yaml
Primary Queue Settings:
  - Visibility Timeout: 300 seconds (5 minutes)
  - Message Retention: 14 days
  - Receive Wait Time: 20 seconds (long polling)
  - Max Receive Count: 3 (before moving to DLQ)

DLQ Settings:
  - Message Retention: 14 days
  - No further processing (manual intervention required)
```

**Message Flow Examples:**

**Example 1: Successful Processing**
```
MSK Topic → Router Lambda → SNS Topic → SQS Queue → Challenge Lambda → ECS Task
```

**Example 2: Challenge Lambda Failure**
```
SQS Queue → Challenge Lambda (fails) → Retry (3x) → DLQ → Alert
```

**Example 3: Router Lambda Failure**
```
MSK Topic → Router Lambda (fails) → Router DLQ → Alert
```

**Message Format Examples:**

**Original MSK Message:**
```json
{
  "eventType": "submission.notification.create",
  "payload": {
    "submissionId": "12345",
    "challengeId": "mm160",
    "userId": "67890",
    "timestamp": "2026-01-31T10:00:00Z"
  }
}
```

**Router Lambda Output to SNS:**
```json
{
  "messageId": "uuid-1234",
  "challengeId": "mm160",
  "submissionId": "12345",
  "userId": "67890",
  "timestamp": "2026-01-31T10:00:00Z",
  "routingKey": "challenge.mm160",
  "retryCount": 0,
  "correlationId": "trace-uuid-5678"
}
```

**SQS Message Attributes:**
```json
{
  "MessageAttributes": {
    "challengeId": {
      "StringValue": "mm160",
      "DataType": "String"
    },
    "priority": {
      "StringValue": "normal",
      "DataType": "String"
    },
    "correlationId": {
      "StringValue": "trace-uuid-5678",
      "DataType": "String"
    }
  }
}
```

**Fan-out Patterns:**

**Pattern 1: Challenge-Specific Fan-out**
```
SNS Topic: submission-router
├── SQS Queue: submission-challenge-mm160
├── SQS Queue: submission-challenge-mm161
└── SQS Queue: submission-challenge-default
```

**Pattern 2: Multi-Subscriber Fan-out**
```
SNS Topic: submission-completion
├── Lambda: update-submission-status
├── Lambda: send-notifications
└── SQS Queue: analytics-events
```

**Error Handling Flow:**
```
1. Message Processing Failure
   ↓
2. Increment Retry Count
   ↓
3. Return to Queue (with backoff)
   ↓
4. Max Retries Exceeded?
   ↓ (Yes)
5. Move to DLQ
   ↓
6. Trigger Alert
   ↓
7. Manual Investigation
```

**Monitoring and Alerting:**
- **Queue Depth**: Alert if > 1000 messages
- **DLQ Messages**: Alert on any DLQ message
- **Processing Rate**: Alert if < 100 messages/minute
- **Error Rate**: Alert if > 5% failure rate

### FR-2: Asynchronous Processing Implementation

#### FR-2.1: Fire-and-Forget ECS Task Execution
**As a** Lambda function  
**I want** to trigger ECS tasks asynchronously  
**So that** I can process more submissions concurrently

**Acceptance Criteria:**
- Lambda triggers ECS task and returns immediately
- ECS task ARN is stored for tracking
- Lambda execution time reduced to < 10 seconds
- No blocking on ECS task completion

#### FR-2.2: Task Completion Notification System
**As a** system  
**I want** to receive notifications when ECS tasks complete  
**So that** I can update submission status and handle results

**Acceptance Criteria:**
- EventBridge rules capture ECS task state changes
- Completion Lambda processes task results
- Failed tasks trigger appropriate error handling
- Submission status updated in external systems

**Detailed EventBridge Implementation:**

**EventBridge Rule Configuration:**
```yaml
# CloudFormation/CDK Example
ECSTaskCompletionRule:
  Type: AWS::Events::Rule
  Properties:
    Name: ecs-task-completion-rule
    Description: Capture ECS task state changes for scorer tasks
    EventPattern:
      source: ["aws.ecs"]
      detail-type: ["ECS Task State Change"]
      detail:
        clusterArn: [!GetAtt ECSCluster.Arn]
        lastStatus: ["STOPPED"]
        taskDefinitionArn: [!Ref ScorerTaskDefinition]
    State: ENABLED
    Targets:
      - Arn: !GetAtt TaskCompletionLambda.Arn
        Id: TaskCompletionTarget
        InputTransformer:
          InputPathsMap:
            taskArn: "$.detail.taskArn"
            clusterArn: "$.detail.clusterArn"
            lastStatus: "$.detail.lastStatus"
            stopCode: "$.detail.stopCode"
            stoppedReason: "$.detail.stoppedReason"
            containers: "$.detail.containers"
          InputTemplate: |
            {
              "taskArn": "<taskArn>",
              "clusterArn": "<clusterArn>",
              "lastStatus": "<lastStatus>",
              "stopCode": "<stopCode>",
              "stoppedReason": "<stoppedReason>",
              "containers": <containers>,
              "timestamp": "$.time"
            }
```

**ECS Task State Change Event Example:**
```json
{
  "version": "0",
  "id": "8952ba83-7be2-4ab5-9c32-6687532d15a2",
  "detail-type": "ECS Task State Change",
  "source": "aws.ecs",
  "account": "123456789012",
  "time": "2026-01-31T10:15:30Z",
  "region": "us-east-1",
  "detail": {
    "clusterArn": "arn:aws:ecs:us-east-1:123456789012:cluster/match-scorer-ecs-cluster",
    "taskArn": "arn:aws:ecs:us-east-1:123456789012:task/match-scorer-ecs-cluster/abc123def456",
    "taskDefinitionArn": "arn:aws:ecs:us-east-1:123456789012:task-definition/java-scorer:1",
    "lastStatus": "STOPPED",
    "desiredStatus": "STOPPED",
    "stopCode": "TaskCompletedNormally",
    "stoppedReason": "Essential container in task exited",
    "containers": [
      {
        "containerArn": "arn:aws:ecs:us-east-1:123456789012:container/java-scorer/xyz789",
        "name": "java-scorer",
        "lastStatus": "STOPPED",
        "exitCode": 0,
        "reason": "Essential container in task exited"
      }
    ],
    "overrides": {
      "containerOverrides": [
        {
          "name": "java-scorer",
          "environment": [
            {"name": "CHALLENGE_ID", "value": "mm160"},
            {"name": "SUBMISSION_ID", "value": "12345"},
            {"name": "SCORER_TYPE", "value": "BioSlime"},
            {"name": "CORRELATION_ID", "value": "trace-uuid-5678"}
          ]
        }
      ]
    },
    "createdAt": "2026-01-31T10:10:00Z",
    "startedAt": "2026-01-31T10:10:30Z",
    "stoppedAt": "2026-01-31T10:15:30Z"
  }
}
```

**Task Completion Lambda Handler:**
```javascript
// Task Completion Lambda pseudo-code
exports.handler = async (event) => {
  console.log('ECS Task Completion Event:', JSON.stringify(event, null, 2));
  
  const {
    taskArn,
    lastStatus,
    stopCode,
    stoppedReason,
    containers
  } = event;
  
  // Extract environment variables from task overrides
  const environment = extractEnvironmentFromEvent(event);
  const {
    CHALLENGE_ID: challengeId,
    SUBMISSION_ID: submissionId,
    SCORER_TYPE: scorerType,
    CORRELATION_ID: correlationId
  } = environment;
  
  try {
    // Determine task outcome
    const taskResult = analyzeTaskCompletion({
      stopCode,
      stoppedReason,
      containers,
      exitCode: containers[0]?.exitCode
    });
    
    switch (taskResult.status) {
      case 'SUCCESS':
        await handleSuccessfulTask({
          challengeId,
          submissionId,
          scorerType,
          taskArn,
          correlationId
        });
        break;
        
      case 'FAILURE':
        await handleFailedTask({
          challengeId,
          submissionId,
          scorerType,
          taskArn,
          error: taskResult.error,
          correlationId
        });
        break;
        
      case 'TIMEOUT':
        await handleTimeoutTask({
          challengeId,
          submissionId,
          scorerType,
          taskArn,
          correlationId
        });
        break;
    }
    
    // Send completion notification to SNS
    await publishCompletionEvent({
      challengeId,
      submissionId,
      scorerType,
      status: taskResult.status,
      taskArn,
      correlationId,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Error processing task completion:', error);
    
    // Send to DLQ for manual investigation
    await sendToCompletionDLQ({
      originalEvent: event,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
};

function analyzeTaskCompletion({ stopCode, stoppedReason, containers, exitCode }) {
  // Task completed successfully
  if (stopCode === 'TaskCompletedNormally' && exitCode === 0) {
    return { status: 'SUCCESS' };
  }
  
  // Task timed out
  if (stopCode === 'TaskFailedToStart' || stoppedReason.includes('timeout')) {
    return { 
      status: 'TIMEOUT',
      error: `Task timeout: ${stoppedReason}`
    };
  }
  
  // Task failed with non-zero exit code
  if (exitCode !== 0) {
    return {
      status: 'FAILURE',
      error: `Task failed with exit code ${exitCode}: ${stoppedReason}`
    };
  }
  
  // Other failure scenarios
  return {
    status: 'FAILURE',
    error: `Task stopped unexpectedly: ${stopCode} - ${stoppedReason}`
  };
}
```

**EventBridge Integration with SNS Fan-out:**
```yaml
# Multiple EventBridge targets for different outcomes
ECSTaskCompletionRule:
  Targets:
    # Primary completion handler
    - Arn: !GetAtt TaskCompletionLambda.Arn
      Id: PrimaryCompletionHandler
    
    # Success notifications
    - Arn: !Ref SuccessNotificationTopic
      Id: SuccessNotifications
      RuleTargetInput:
        InputPathsMap:
          taskArn: "$.detail.taskArn"
          exitCode: "$.detail.containers[0].exitCode"
        InputTemplate: |
          {
            "taskArn": "<taskArn>",
            "status": "completed",
            "exitCode": <exitCode>
          }
      Condition:
        StringEquals:
          "detail.containers[0].exitCode": "0"
    
    # Failure notifications
    - Arn: !Ref FailureNotificationTopic
      Id: FailureNotifications
      Condition:
        NumericGreaterThan:
          "detail.containers[0].exitCode": 0
```

**EventBridge Custom Bus for Submission Events:**
```yaml
SubmissionEventBus:
  Type: AWS::Events::EventBus
  Properties:
    Name: submission-processing-bus
    Description: Custom event bus for submission processing events

SubmissionCompletionRule:
  Type: AWS::Events::Rule
  Properties:
    EventBusName: !Ref SubmissionEventBus
    Name: submission-completion-rule
    EventPattern:
      source: ["match-scorer.submission"]
      detail-type: ["Submission Scored", "Submission Failed"]
      detail:
        challengeId: [{"exists": true}]
        submissionId: [{"exists": true}]
    Targets:
      - Arn: !GetAtt UpdateSubmissionStatusLambda.Arn
        Id: UpdateStatusTarget
      - Arn: !Ref NotificationTopic
        Id: NotificationTarget
```

**Custom Event Publishing Example:**
```javascript
// Publishing custom events to EventBridge
const eventbridge = new AWS.EventBridge();

async function publishSubmissionEvent(eventType, detail) {
  const params = {
    Entries: [
      {
        Source: 'match-scorer.submission',
        DetailType: eventType,
        Detail: JSON.stringify(detail),
        EventBusName: 'submission-processing-bus',
        Time: new Date()
      }
    ]
  };
  
  return await eventbridge.putEvents(params).promise();
}

// Usage examples
await publishSubmissionEvent('Submission Scored', {
  challengeId: 'mm160',
  submissionId: '12345',
  scorerType: 'BioSlime',
  score: 85.5,
  taskArn: 'arn:aws:ecs:...',
  correlationId: 'trace-uuid-5678'
});

await publishSubmissionEvent('Submission Failed', {
  challengeId: 'mm160',
  submissionId: '12345',
  scorerType: 'BioSlime',
  error: 'Compilation failed',
  taskArn: 'arn:aws:ecs:...',
  correlationId: 'trace-uuid-5678'
});
```

**EventBridge Archive and Replay Configuration:**
```yaml
SubmissionEventArchive:
  Type: AWS::Events::Archive
  Properties:
    ArchiveName: submission-events-archive
    SourceArn: !GetAtt SubmissionEventBus.Arn
    Description: Archive submission processing events for replay
    RetentionDays: 30
    EventPattern:
      source: ["match-scorer.submission"]

# Replay configuration for disaster recovery
SubmissionEventReplay:
  Type: AWS::Events::Replay
  Properties:
    ReplayName: submission-events-replay
    EventSourceArn: !Ref SubmissionEventArchive
    EventStartTime: "2026-01-31T00:00:00Z"
    EventEndTime: "2026-01-31T23:59:59Z"
    Destination:
      Arn: !GetAtt SubmissionEventBus.Arn
```

**Monitoring EventBridge Rules:**
```json
{
  "widgets": [
    {
      "type": "metric",
      "properties": {
        "metrics": [
          ["AWS/Events", "MatchedEvents", "RuleName", "ecs-task-completion-rule"],
          ["AWS/Events", "Invocations", "RuleName", "ecs-task-completion-rule"],
          ["AWS/Events", "FailedInvocations", "RuleName", "ecs-task-completion-rule"]
        ],
        "title": "EventBridge Rule Performance",
        "period": 300
      }
    },
    {
      "type": "log",
      "properties": {
        "query": "SOURCE '/aws/lambda/task-completion-lambda'\n| fields @timestamp, @message\n| filter @message like /ERROR/\n| sort @timestamp desc\n| limit 100",
        "title": "Task Completion Errors",
        "region": "us-east-1"
      }
    }
  ]
}
```

**End-to-End Flow with EventBridge:**
```
1. Challenge Lambda → ECS RunTask (async) → Return immediately
2. ECS Task → Runs scorer → Completes/Fails
3. ECS → EventBridge → Task State Change Event
4. EventBridge → Task Completion Lambda → Process result
5. Task Completion Lambda → Custom EventBridge Event → Submission status
6. EventBridge → Multiple targets:
   - Update Submission Status Lambda
   - Notification SNS Topic
   - Analytics SQS Queue
   - Audit Log Stream
```

### FR-2.3: Retry and Error Handling
**As a** system  
**I want** robust retry mechanisms for failed operations  
**So that** transient failures don't cause submission loss

**Acceptance Criteria:**
- Exponential backoff retry for API calls
- Maximum retry limits to prevent infinite loops
- DLQ for messages that exceed retry limits
- Alerting for high failure rates

**MSK Lambda Batch Failure Handling:**

**Batch Processing Strategy:**
```javascript
// Router Lambda with batch failure handling
exports.handler = async (event) => {
  console.log(`Processing batch of ${event.records.length} messages`);
  
  const batchItemFailures = [];
  const successfulMessages = [];
  const failedMessages = [];
  
  // Process each message individually to isolate failures
  for (const [topicPartition, records] of Object.entries(event.records)) {
    for (const record of records) {
      try {
        const result = await processMessage(record);
        successfulMessages.push({ record, result });
        
      } catch (error) {
        console.error(`Failed to process message ${record.offset}:`, error);
        
        // Determine if error is retryable
        if (isRetryableError(error)) {
          // Add to batch item failures for Lambda retry
          batchItemFailures.push({
            itemIdentifier: record.kafkaOffset || record.offset
          });
        } else {
          // Send to DLQ immediately for non-retryable errors
          await sendToDLQ(record, error, 'NON_RETRYABLE');
          failedMessages.push({ record, error: error.message });
        }
      }
    }
  }
  
  // Log batch processing results
  console.log(`Batch processing complete: ${successfulMessages.length} success, ${failedMessages.length} failed, ${batchItemFailures.length} retrying`);
  
  // Return batch item failures to trigger Lambda retry mechanism
  if (batchItemFailures.length > 0) {
    return {
      batchItemFailures: batchItemFailures
    };
  }
  
  return { status: 'SUCCESS' };
};

function isRetryableError(error) {
  const retryableErrors = [
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'ThrottlingException',
    'ServiceUnavailable',
    'InternalServerError',
    'TooManyRequestsException'
  ];
  
  return retryableErrors.some(retryableError => 
    error.code === retryableError || 
    error.message.includes(retryableError)
  );
}
```

**MSK Event Source Mapping Configuration:**
```yaml
# CDK/CloudFormation configuration for MSK ESM
KafkaEventSourceMapping:
  Type: AWS::Lambda::EventSourceMapping
  Properties:
    FunctionName: !Ref RouterLambdaFunction
    EventSourceArn: !Ref MSKClusterArn
    Topics: 
      - "submission.notification.create"
    StartingPosition: TRIM_HORIZON
    BatchSize: 100
    MaximumBatchingWindowInSeconds: 5
    
    # Batch failure handling configuration
    FunctionResponseTypes:
      - ReportBatchItemFailures
    
    # Retry configuration
    MaximumRetryAttempts: 3
    MaximumRecordAgeInSeconds: 3600  # 1 hour
    ParallelizationFactor: 10
    
    # Tumbling window for processing
    TumblingWindowInSeconds: 60
    
    # Destination for failed records
    DestinationConfig:
      OnFailure:
        Destination: !GetAtt MSKFailureDLQ.Arn
```

**Partial Batch Failure Scenarios:**

**Scenario 1: Mixed Success/Failure Batch**
```javascript
// Example: Batch of 10 messages, 2 fail with retryable errors
const event = {
  records: {
    "submission.notification.create-0": [
      { offset: "100", value: "valid-message-1" },    // ✓ Success
      { offset: "101", value: "invalid-json" },       // ✗ Non-retryable
      { offset: "102", value: "valid-message-2" },    // ✓ Success
      { offset: "103", value: "valid-message-3" },    // ✗ Timeout (retryable)
      { offset: "104", value: "valid-message-4" }     // ✓ Success
    ]
  }
};

// Lambda response for partial failure
return {
  batchItemFailures: [
    { itemIdentifier: "103" }  // Only retryable failure
  ]
};

// Result: Messages 100, 102, 104 processed successfully
//         Message 101 sent to DLQ (non-retryable)
//         Message 103 will be retried by Lambda
```

**Scenario 2: Cascading Failure Prevention**
```javascript
// Circuit breaker pattern for downstream service failures
class CircuitBreaker {
  constructor(threshold = 5, timeout = 60000) {
    this.failureCount = 0;
    this.threshold = threshold;
    this.timeout = timeout;
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.nextAttempt = Date.now();
  }
  
  async execute(operation) {
    if (this.state === 'OPEN') {
      if (Date.now() < this.nextAttempt) {
        throw new Error('Circuit breaker is OPEN');
      }
      this.state = 'HALF_OPEN';
    }
    
    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }
  
  onSuccess() {
    this.failureCount = 0;
    this.state = 'CLOSED';
  }
  
  onFailure() {
    this.failureCount++;
    if (this.failureCount >= this.threshold) {
      this.state = 'OPEN';
      this.nextAttempt = Date.now() + this.timeout;
    }
  }
}

// Usage in Lambda
const snsCircuitBreaker = new CircuitBreaker(5, 30000);

async function publishToSNS(message) {
  return await snsCircuitBreaker.execute(async () => {
    return await sns.publish({
      TopicArn: process.env.SNS_TOPIC_ARN,
      Message: JSON.stringify(message)
    }).promise();
  });
}
```

**Dead Letter Queue Strategy:**
```javascript
// Enhanced DLQ handling with categorization
async function sendToDLQ(record, error, category = 'UNKNOWN') {
  const dlqMessage = {
    originalRecord: {
      topic: record.topic,
      partition: record.partition,
      offset: record.offset,
      timestamp: record.timestamp,
      value: record.value,
      headers: record.headers
    },
    error: {
      message: error.message,
      stack: error.stack,
      code: error.code,
      category: category
    },
    metadata: {
      processingAttempt: record.processingAttempt || 1,
      firstFailureTime: record.firstFailureTime || new Date().toISOString(),
      lastFailureTime: new Date().toISOString(),
      lambdaRequestId: context.awsRequestId,
      correlationId: generateCorrelationId()
    }
  };
  
  // Send to appropriate DLQ based on error category
  const queueUrl = getDLQUrl(category);
  
  await sqs.sendMessage({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify(dlqMessage),
    MessageAttributes: {
      errorCategory: {
        DataType: 'String',
        StringValue: category
      },
      challengeId: {
        DataType: 'String',
        StringValue: extractChallengeId(record) || 'unknown'
      },
      retryable: {
        DataType: 'String',
        StringValue: category === 'RETRYABLE' ? 'true' : 'false'
      }
    }
  }).promise();
}

function getDLQUrl(category) {
  const dlqUrls = {
    'NON_RETRYABLE': process.env.NON_RETRYABLE_DLQ_URL,
    'RETRYABLE': process.env.RETRYABLE_DLQ_URL,
    'POISON_MESSAGE': process.env.POISON_MESSAGE_DLQ_URL,
    'UNKNOWN': process.env.GENERAL_DLQ_URL
  };
  
  return dlqUrls[category] || dlqUrls['UNKNOWN'];
}
```

**Monitoring and Alerting for Batch Failures:**
```yaml
# CloudWatch Alarms for MSK Lambda failures
MSKLambdaErrorRate:
  Type: AWS::CloudWatch::Alarm
  Properties:
    AlarmName: MSK-Lambda-High-Error-Rate
    AlarmDescription: High error rate in MSK Lambda processing
    MetricName: Errors
    Namespace: AWS/Lambda
    Statistic: Sum
    Period: 300
    EvaluationPeriods: 2
    Threshold: 10
    ComparisonOperator: GreaterThanThreshold
    Dimensions:
      - Name: FunctionName
        Value: !Ref RouterLambdaFunction

MSKLambdaDLQMessages:
  Type: AWS::CloudWatch::Alarm
  Properties:
    AlarmName: MSK-Lambda-DLQ-Messages
    AlarmDescription: Messages in MSK Lambda DLQ
    MetricName: ApproximateNumberOfVisibleMessages
    Namespace: AWS/SQS
    Statistic: Maximum
    Period: 60
    EvaluationPeriods: 1
    Threshold: 1
    ComparisonOperator: GreaterThanOrEqualToThreshold
    Dimensions:
      - Name: QueueName
        Value: !GetAtt MSKFailureDLQ.QueueName

# Custom metrics for batch processing
BatchProcessingMetrics:
  Type: AWS::Logs::MetricFilter
  Properties:
    LogGroupName: !Sub "/aws/lambda/${RouterLambdaFunction}"
    FilterPattern: "[timestamp, requestId, level=\"ERROR\", message=\"Batch processing failed\"]"
    MetricTransformations:
      - MetricNamespace: MatchScorer/MSK
        MetricName: BatchFailures
        MetricValue: "1"
        DefaultValue: 0
```

**Batch Failure Recovery Strategies:**

**Strategy 1: Replay from DLQ**
```javascript
// DLQ processor Lambda for manual replay
exports.dlqHandler = async (event) => {
  const records = event.Records;
  const replayableMessages = [];
  
  for (const record of records) {
    const dlqMessage = JSON.parse(record.body);
    
    // Check if message is now processable
    if (await isMessageProcessable(dlqMessage)) {
      replayableMessages.push(dlqMessage.originalRecord);
    }
  }
  
  // Replay messages back to MSK or directly to SNS
  if (replayableMessages.length > 0) {
    await replayMessages(replayableMessages);
  }
};
```

**Strategy 2: Checkpoint-based Recovery**
```javascript
// Store processing checkpoints for recovery
async function storeCheckpoint(topicPartition, offset) {
  await dynamodb.putItem({
    TableName: 'msk-processing-checkpoints',
    Item: {
      topicPartition: { S: topicPartition },
      lastProcessedOffset: { N: offset.toString() },
      timestamp: { S: new Date().toISOString() },
      ttl: { N: Math.floor(Date.now() / 1000) + 86400 } // 24 hours TTL
    }
  }).promise();
}

async function getLastCheckpoint(topicPartition) {
  const result = await dynamodb.getItem({
    TableName: 'msk-processing-checkpoints',
    Key: {
      topicPartition: { S: topicPartition }
    }
  }).promise();
  
  return result.Item ? parseInt(result.Item.lastProcessedOffset.N) : null;
}
```

**Best Practices for MSK Lambda Batch Failures:**

1. **Individual Message Processing**: Process each message separately to isolate failures
2. **Categorized Error Handling**: Distinguish between retryable and non-retryable errors
3. **Circuit Breaker Pattern**: Prevent cascading failures to downstream services
4. **Comprehensive Monitoring**: Track batch success rates, DLQ depth, processing latency
5. **Graceful Degradation**: Continue processing successful messages even when some fail
6. **Replay Capability**: Implement mechanisms to replay failed messages after issues are resolved

### FR-3: Caching Layer Implementation

#### FR-3.1: Configuration Caching
**As a** Lambda function  
**I want** to cache challenge and scorer configurations  
**So that** I don't fetch them repeatedly from SSM

**Acceptance Criteria:**
- Challenge configs cached in Lambda memory on cold start
- Scorer configs cached per challenge
- Cache TTL of 5 minutes with refresh mechanism
- Cache invalidation on configuration updates

#### FR-3.2: Auth0 Token Caching
**As a** Lambda function  
**I want** to cache Auth0 tokens between invocations  
**So that** I don't authenticate for every submission

**Acceptance Criteria:**
- Auth0 tokens cached in Lambda memory
- Token refresh before expiration
- Fallback to new token fetch if cached token invalid
- Secure token storage in memory

#### FR-3.3: Cache Warming Strategy
**As a** system  
**I want** to pre-warm caches proactively  
**So that** cold starts don't impact performance

**Acceptance Criteria:**
- Scheduled Lambda to refresh caches periodically
- Cache warming on Lambda deployment
- Monitoring of cache hit rates
- Graceful degradation when cache unavailable

## Non-Functional Requirements

### NFR-1: Performance
- **Response Time**: Lambda processing < 10 seconds per submission
- **Throughput**: Support 1000+ submissions per minute
- **Concurrency**: Handle 100+ concurrent Lambda executions
- **Cache Hit Rate**: > 90% for configuration and token requests

### NFR-2: Reliability
- **Availability**: 99.9% uptime for submission processing
- **Error Rate**: < 1% message processing failures
- **Recovery Time**: < 5 minutes for system recovery
- **Data Consistency**: Exactly-once message processing

### NFR-3: Scalability
- **Auto-scaling**: Lambda concurrency scales with load
- **Queue Scaling**: SQS handles burst traffic
- **ECS Scaling**: Task capacity scales with demand
- **Storage Scaling**: Parameter Store handles increased config requests

### NFR-4: Monitoring and Observability
- **Metrics**: CloudWatch metrics for all components
- **Logging**: Structured logging with correlation IDs
- **Tracing**: X-Ray tracing for end-to-end visibility
- **Alerting**: Proactive alerts for failures and performance issues

## Technical Constraints

### TC-1: AWS Service Limits
- Lambda concurrent execution limits
- SQS message size and retention limits
- ECS task and cluster limits
- Parameter Store throughput limits

### TC-2: Backward Compatibility
- Existing Kafka message format must be supported
- Current SSM parameter structure maintained
- Existing ECS task definitions compatible

### TC-3: Security Requirements
- All inter-service communication encrypted
- IAM roles follow least privilege principle
- Auth0 tokens handled securely
- VPC network isolation maintained

## Success Criteria

### Primary Success Metrics
1. **Processing Latency**: Reduce average submission processing time by 70%
2. **Throughput**: Increase system throughput by 500%
3. **Cost Efficiency**: Reduce per-submission processing cost by 40%
4. **Error Rate**: Maintain < 1% error rate during optimization

### Secondary Success Metrics
1. **Cache Hit Rate**: Achieve > 90% cache hit rate for configs and tokens
2. **Concurrent Processing**: Support 10x more concurrent submissions
3. **Recovery Time**: Reduce failure recovery time by 60%
4. **Monitoring Coverage**: 100% observability of critical paths

## Implementation Examples

**EventBridge Rule with Multiple Targets**:
```yaml
# CloudFormation/CDK Example for EventBridge
SubmissionProcessingEventBus:
  Type: AWS::Events::EventBus
  Properties:
    Name: submission-processing-events

ECSTaskStateRule:
  Type: AWS::Events::Rule
  Properties:
    Name: ecs-task-state-changes
    EventBusName: !Ref SubmissionProcessingEventBus
    EventPattern:
      source: ["aws.ecs"]
      detail-type: ["ECS Task State Change"]
      detail:
        lastStatus: ["STOPPED"]
        clusterArn: [!GetAtt ECSCluster.Arn]
    Targets:
      # Primary completion handler
      - Arn: !GetAtt TaskCompletionLambda.Arn
        Id: TaskCompletionHandler
        InputTransformer:
          InputPathsMap:
            taskArn: "$.detail.taskArn"
            exitCode: "$.detail.containers[0].exitCode"
            environment: "$.detail.overrides.containerOverrides[0].environment"
          InputTemplate: |
            {
              "taskArn": "<taskArn>",
              "exitCode": <exitCode>,
              "environment": <environment>,
              "timestamp": "$.time"
            }
      
      # Success path - only for successful tasks
      - Arn: !Ref SuccessProcessingQueue
        Id: SuccessQueue
        SqsParameters:
          MessageGroupId: "success-processing"
        Condition:
          NumericEquals:
            "detail.containers[0].exitCode": 0
      
      # Failure path - only for failed tasks  
      - Arn: !Ref FailureProcessingQueue
        Id: FailureQueue
        SqsParameters:
          MessageGroupId: "failure-processing"
        Condition:
          NumericGreaterThan:
            "detail.containers[0].exitCode": 0
      
      # Analytics - all task completions
      - Arn: !Ref AnalyticsStream
        Id: AnalyticsTarget
        KinesisParameters:
          PartitionKeyPath: "$.detail.taskDefinitionArn"
```

**EventBridge Custom Event Schema**:
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "title": "Submission Processing Event",
  "properties": {
    "version": {"type": "string", "const": "0"},
    "id": {"type": "string"},
    "detail-type": {
      "type": "string",
      "enum": ["Submission Started", "Submission Scored", "Submission Failed", "Submission Timeout"]
    },
    "source": {"type": "string", "const": "match-scorer.submission"},
    "account": {"type": "string"},
    "time": {"type": "string", "format": "date-time"},
    "region": {"type": "string"},
    "detail": {
      "type": "object",
      "properties": {
        "challengeId": {"type": "string"},
        "submissionId": {"type": "string"},
        "scorerType": {"type": "string"},
        "taskArn": {"type": "string"},
        "correlationId": {"type": "string"},
        "score": {"type": "number", "minimum": 0},
        "error": {"type": "string"},
        "duration": {"type": "number"},
        "metadata": {"type": "object"}
      },
      "required": ["challengeId", "submissionId", "correlationId"]
    }
  }
}
```

### AWS Resource Configuration Examples

**SNS Topic with Subscription Filters**:
```yaml
# CloudFormation/CDK Example
SubmissionRouterTopic:
  Type: AWS::SNS::Topic
  Properties:
    TopicName: submission-router
    DisplayName: Submission Router Topic

MM160Subscription:
  Type: AWS::SNS::Subscription
  Properties:
    TopicArn: !Ref SubmissionRouterTopic
    Protocol: sqs
    Endpoint: !GetAtt MM160Queue.Arn
    FilterPolicy:
      challengeId: ["mm160"]

DefaultSubscription:
  Type: AWS::SNS::Subscription
  Properties:
    TopicArn: !Ref SubmissionRouterTopic
    Protocol: sqs
    Endpoint: !GetAtt DefaultQueue.Arn
    FilterPolicy:
      challengeId: [{"anything-but": ["mm160", "mm161", "mm162"]}]
```

**SQS Queue with DLQ Configuration**:
```yaml
MM160Queue:
  Type: AWS::SQS::Queue
  Properties:
    QueueName: submission-challenge-mm160
    VisibilityTimeoutSeconds: 300
    MessageRetentionPeriod: 1209600  # 14 days
    ReceiveMessageWaitTimeSeconds: 20  # Long polling
    RedrivePolicy:
      deadLetterTargetArn: !GetAtt MM160DLQ.Arn
      maxReceiveCount: 3

MM160DLQ:
  Type: AWS::SQS::Queue
  Properties:
    QueueName: submission-challenge-mm160-dlq
    MessageRetentionPeriod: 1209600  # 14 days
```

### Cost Analysis Example

**Current Architecture Costs (1000 submissions/hour)**:
```
Lambda Execution:
- Duration: 30s per submission × 1000 = 8.33 hours
- Memory: 512MB
- Cost: ~$0.35/hour

API Calls:
- SSM GetParameter: 3000 calls/hour × $0.05/10K = $0.015/hour
- Auth0 API: 1000 calls/hour × $0.10/1K = $0.10/hour

Total: ~$0.465/hour = $11.16/day
```

**Optimized Architecture Costs (1000 submissions/hour)**:
```
Router Lambda:
- Duration: 0.1s per submission × 1000 = 0.028 hours
- Memory: 256MB
- Cost: ~$0.002/hour

Challenge Lambdas (5 concurrent):
- Duration: 5s per submission × 1000 = 1.39 hours
- Memory: 512MB
- Cost: ~$0.23/hour

SQS Messages:
- 1000 messages × $0.40/million = $0.0004/hour

SNS Messages:
- 1000 messages × $0.50/million = $0.0005/hour

Cached API Calls (90% reduction):
- SSM GetParameter: 300 calls/hour × $0.05/10K = $0.0015/hour
- Auth0 API: 100 calls/hour × $0.10/1K = $0.01/hour

Total: ~$0.244/hour = $5.86/day (48% cost reduction)
```

### Monitoring Dashboard Example

**CloudWatch Dashboard Widgets**:
```json
{
  "widgets": [
    {
      "type": "metric",
      "properties": {
        "metrics": [
          ["AWS/SQS", "NumberOfMessagesSent", "QueueName", "submission-challenge-mm160"],
          ["AWS/SQS", "NumberOfMessagesReceived", "QueueName", "submission-challenge-mm160"],
          ["AWS/SQS", "ApproximateNumberOfVisibleMessages", "QueueName", "submission-challenge-mm160"]
        ],
        "title": "MM160 Queue Metrics",
        "period": 300
      }
    },
    {
      "type": "metric",
      "properties": {
        "metrics": [
          ["AWS/Lambda", "Duration", "FunctionName", "submission-router"],
          ["AWS/Lambda", "Errors", "FunctionName", "submission-router"],
          ["AWS/Lambda", "Throttles", "FunctionName", "submission-router"]
        ],
        "title": "Router Lambda Performance",
        "period": 300
      }
    }
  ]
}
```

**Scenario 5: MSK Lambda Batch Partial Failure**
```
Batch of 100 messages → Router Lambda → 95 success, 5 failures
├── 3 retryable failures → Return batchItemFailures → Lambda retries
├── 2 non-retryable failures → Send to DLQ → Continue processing
└── 95 successful messages → Route to SNS → Process normally
```

**Scenario 6: MSK Lambda Complete Batch Failure**
```
Batch of 100 messages → Router Lambda → All fail (downstream service down)
├── Circuit breaker opens → Prevent further downstream calls
├── All messages marked as retryable → Return all as batchItemFailures
└── Lambda ESM retries entire batch → Exponential backoff
```

**Scenario 7: MSK Lambda Poison Message**
```
Batch contains malformed message → Router Lambda → Parse error
├── Identify poison message → Mark as non-retryable
├── Send poison message to special DLQ → Alert operations
└── Continue processing other messages in batch
```

**Scenario 8: MSK Lambda Timeout**
```
Large batch processing → Lambda timeout (15 minutes)
├── Partial processing completed → Some messages processed
├── Unprocessed messages → Returned to Kafka → Will be retried
└── Reduce batch size → Prevent future timeouts
```

### Error Handling Scenarios

**Scenario 1: Temporary Auth0 Outage**
```
Challenge Lambda → Auth0 API (fails) → Use cached token → Success
If cached token expired → Retry with exponential backoff → DLQ after 3 attempts
```

**Scenario 2: ECS Cluster at Capacity**
```
Challenge Lambda → ECS RunTask (fails: no capacity) → Retry after 30s → Success
If still failing → Exponential backoff → DLQ after 5 minutes
```

**Scenario 3: Malformed Message**
```
Router Lambda → Parse message (fails) → Log error → Send to router-dlq → Continue processing other messages
```

**Scenario 4: Challenge Configuration Missing**
```
Challenge Lambda → SSM GetParameter (not found) → Log error → Send to challenge-dlq → Alert operations team
```

## Dependencies

### Internal Dependencies
- Current MSK cluster and Kafka topics
- Existing ECS cluster and task definitions
- SSM Parameter Store configurations
- Auth0 M2M authentication setup

### External Dependencies
- AWS service availability (Lambda, SQS, SNS, EventBridge)
- Auth0 service availability
- External submission API availability

## Risks and Mitigation

### High Risk
- **Message Loss**: Implement DLQ and monitoring
- **Cache Invalidation**: Implement TTL and refresh mechanisms
- **Increased Complexity**: Comprehensive testing and documentation

### Medium Risk
- **Cold Start Impact**: Implement cache warming
- **Cost Increase**: Monitor and optimize resource usage
- **Debugging Complexity**: Implement comprehensive logging and tracing

## Implementation Phases

### Phase 1: Foundation (Weeks 1-2)
- Implement message router Lambda
- Set up SQS queues and DLQ
- Basic monitoring and logging

### Phase 2: Fan-out (Weeks 3-4)
- Challenge-specific Lambda functions
- SNS/SQS distribution mechanism
- End-to-end message flow testing

### Phase 3: Async Processing (Weeks 5-6)
- Asynchronous ECS task execution
- EventBridge task completion handling
- Retry and error handling mechanisms

### Phase 4: Caching (Weeks 7-8)
- Configuration caching implementation
- Auth0 token caching
- Cache warming and monitoring

### Phase 5: Optimization (Weeks 9-10)
- Performance tuning
- Cost optimization
- Production readiness testing

## Acceptance Testing Strategy

### Load Testing
- Simulate 1000+ submissions per minute
- Test concurrent processing limits
- Validate system behavior under stress

### Failure Testing
- Test DLQ mechanisms
- Validate retry logic
- Test cache failure scenarios

### Integration Testing
- End-to-end submission processing
- Cross-service communication validation
- Monitoring and alerting verification

---

**Document Version**: 1.0  
**Created**: 2026-01-31  
**Status**: Draft  
**Next Review**: TBD