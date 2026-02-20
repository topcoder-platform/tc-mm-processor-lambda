const { ECSClient, RunTaskCommand, DescribeTasksCommand, StopTaskCommand } = require('@aws-sdk/client-ecs');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const axios = require('@aws-sdk/client-ssm');
const ecs = new ECSClient();
const ssm = new SSMClient();

// Configuration from environment variables
const config = {
  cluster: process.env.ECS_CLUSTER,
  taskDefinition: process.env.ECS_TASK_DEFINITION, // Default/fallback task definition
  subnets: process.env.ECS_SUBNETS.split(','),
  securityGroups: [process.env.ECS_SECURITY_GROUPS],
  containerName: process.env.ECS_CONTAINER_NAME,
  taskTimeoutSeconds: parseInt(process.env.TASK_TIMEOUT_SECONDS || '60'),
  maxRetries: parseInt(process.env.MAX_RETRIES || '3'),
};

/**
 * Wait for a specified time
 * @param {number} ms - Time to wait in milliseconds
 * @returns {Promise} - Promise that resolves after the specified time
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Check if a task is still running
 * @param {string} taskArn - ARN of the task to check
 * @returns {Promise<boolean>} - Promise that resolves to true if task is still running
 */
const isTaskRunning = async (taskArn) => {
  try {
    const command = new DescribeTasksCommand({
      cluster: config.cluster,
      tasks: [taskArn]
    });
    const { tasks } = await ecs.send(command);

    if (!tasks || tasks.length === 0) {
      return false;
    }

    const task = tasks[0];
    return task.lastStatus === 'RUNNING';
  } catch (error) {
    console.error('Error checking task status:', error);
    return false;
  }
};

/**
 * Get challenge configuration from SSM Parameter Store
 * @param {string} challengeId - Challenge ID
 * @returns {Promise<Object>} - Challenge configuration
 */
async function getChallengeConfig(challengeId) {
  const paramName = `/scorer/challenges/${challengeId}/config`;
  const command = new GetParameterCommand({ Name: paramName });
  const response = await ssm.send(command);
  return JSON.parse(response.Parameter.Value);
}

/**
 * Get scorer configuration from SSM Parameter Store
 * @param {string} challengeId - Challenge ID
 * @param {string} scorerType - Scorer type
 * @returns {Promise<Object>} - Scorer configuration
 */
const getScorerConfig = async (challengeId, scorerType) => {
  const paramName = `/scorer/challenges/${challengeId}/scorers/${scorerType}/config`;
  const command = new GetParameterCommand({ Name: paramName });
  const response = await ssm.send(command);
  return JSON.parse(response.Parameter.Value);
};

/**
 * Get task definition ARN for a specific challenge
 * Supports multiple strategies:
 * 1. SSM Parameter Store (recommended)
 * 2. Environment variable mapping
 * 3. Naming convention
 * 4. Default fallback
 * 
 * @param {string} challengeId - Challenge ID
 * @returns {Promise<string>} - Task definition ARN or family name
 */
const getTaskDefinition = async (challengeId) => {
  // Strategy 1: Try to get from SSM Parameter Store
  try {
    const paramName = `/scorer/challenges/${challengeId}/taskDefinition`;
    const command = new GetParameterCommand({ Name: paramName });
    const response = await ssm.send(command);
    const taskDef = response.Parameter.Value;
    console.log(`Using task definition from SSM for challenge ${challengeId}: ${taskDef}`);
    return taskDef;
  } catch (error) {
    console.log(`Task definition not found in SSM for challenge ${challengeId}, trying other strategies`);
  }

  // Strategy 2: Try environment variable mapping
  if (process.env.ECS_TASK_DEFINITION_MAP) {
    try {
      const taskDefMap = JSON.parse(process.env.ECS_TASK_DEFINITION_MAP);
      if (taskDefMap[challengeId]) {
        console.log(`Using task definition from env map for challenge ${challengeId}: ${taskDefMap[challengeId]}`);
        return taskDefMap[challengeId];
      }
    } catch (error) {
      console.error('Error parsing ECS_TASK_DEFINITION_MAP:', error);
    }
  }

  // Strategy 4: Fallback to default task definition
  console.log(`Using default task definition for challenge ${challengeId}: ${config.taskDefinition}`);
  return config.taskDefinition;
};

/**
 * Get Auth0 access token
 * @returns {Promise<string>} - Access token
 */
const getAccessToken = async () => {
  const {
    AUTH0_URL,
    AUTH0_AUDIENCE,
    AUTH0_CLIENT_ID,
    AUTH0_CLIENT_SECRET,
    AUTH0_PROXY_URL,
  } = process.env;
  if (!AUTH0_URL || !AUTH0_AUDIENCE || !AUTH0_CLIENT_ID || !AUTH0_CLIENT_SECRET || !AUTH0_PROXY_URL) {
    throw new Error('Missing required Auth0 M2M configuration (AUTH0_URL, AUTH0_AUDIENCE, AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET, AUTH0_PROXY_URL)');
  }
  const payload = {
    grant_type: 'client_credentials',
    client_id: AUTH0_CLIENT_ID,
    client_secret: AUTH0_CLIENT_SECRET,
    audience: AUTH0_AUDIENCE,
    auth0_url: AUTH0_URL,
  };
  const response = await axios.post(AUTH0_PROXY_URL, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 10000,
  });
  if (!response.data || !response.data.access_token) {
    throw new Error('Auth0 proxy response did not include access_token');
  }
  return response.data.access_token;
};

/**
 * Run ECS scorer task for a specific challenge and submission
 * @param {Object} params - Parameters
 * @param {string} params.challengeId - Challenge ID
 * @param {string} params.scorerType - Scorer type
 * @param {string} params.submissionId - Submission ID
 * @returns {Promise<string>} - Task ARN
 */
const runScorerTask = async ({ challengeId, scorerType, submissionId }) => {
  const challengeConfig = await getChallengeConfig(challengeId);
  const scorerConfig = await getScorerConfig(challengeId, scorerType);
  const accessToken = await getAccessToken();
  
  // Get challenge-specific task definition
  const taskDefinition = await getTaskDefinition(challengeId);
  
  console.log(`Running scorer task for challenge ${challengeId}, scorer ${scorerType}, submission ${submissionId}`);
  console.log(`Using task definition: ${taskDefinition}`);
  
  const command = new RunTaskCommand({
    cluster: config.cluster,
    taskDefinition: taskDefinition,  // Challenge-specific task definition
    launchType: 'FARGATE',
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: config.subnets,
        securityGroups: config.securityGroups,
        assignPublicIp: 'DISABLED',
      },
    },
    overrides: {
      containerOverrides: [
        {
          name: config.containerName,
          environment: [
            { name: 'CHALLENGE_ID', value: String(challengeId) },
            { name: 'SCORER_TYPE', value: String(scorerType) },
            { name: 'SUBMISSION_ID', value: String(submissionId) },
            { name: 'CHALLENGE_CONFIG', value: JSON.stringify(challengeConfig) },
            { name: 'SCORER_CONFIG', value: JSON.stringify(scorerConfig) },
            { name: 'ACCESS_TOKEN', value: String(accessToken) },
          ],
        },
      ],
    },
  });
  const { tasks } = await ecs.send(command);
  if (!tasks || tasks.length === 0) throw new Error('Failed to start ECS task');
  
  console.log(`Started ECS task: ${tasks[0].taskArn}`);
  return tasks[0].taskArn;
};

/**
 * Update submission status (placeholder - not implemented in current version)
 * @param {string} submissionId - Submission ID
 * @param {string} status - Status to set
 * @param {string} accessToken - Access token
 * @param {string} submissionApiUrl - Submission API URL
 */
async function updateSubmissionStatus(submissionId, status, accessToken, submissionApiUrl) {
  try {
    const url = `${submissionApiUrl}/submissions/${submissionId}`;
    const response = await axios.patch(
      url,
      { submissionPhase: status },
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log(`Updated submission ${submissionId} status to ${status}: HTTP ${response.status}`);
  } catch (error) {
    console.error(`Failed to update submission ${submissionId} status to ${status}:`, error.response?.data || error.message);
    throw error;
  }
}

/**
 * Lambda handler - Process Kafka messages from MSK
 * @param {Object} event - Lambda event containing Kafka messages
 * @returns {Promise<Object>} - Processing result
 */
exports.handler = async (event) => {
  console.log('Received event:', JSON.stringify(event, null, 2));
  const promises = [];
  
  for (const topicPartitionKey in event.records) {
    if (Object.hasOwnProperty.call(event.records, topicPartitionKey)) {
      const records = event.records[topicPartitionKey];
      
      for (const record of records) {
        try {
          const decodedValue = Buffer.from(record.value, 'base64').toString('utf-8');
          const message = JSON.parse(decodedValue);
          const submissionId = message?.payload?.submissionId;
          const challengeId = message?.payload?.challengeId;
          
          if (!submissionId || !challengeId) {
            console.error('Missing submissionId or challengeId in message payload:', message);
            continue;
          }
          
          console.log(`Processing submission ${submissionId} for challenge ${challengeId}`);
          
          // Fetch challenge config from Parameter Store
          const challengeConfig = await getChallengeConfig(challengeId);
          
          if (!challengeConfig.scorers || !Array.isArray(challengeConfig.scorers)) {
            console.error('No scorers configured for challenge:', challengeId);
            continue;
          }
          
          // Confirmed to ignore updating status in forum. This method needs to be updated when it's clarified how implementation will look like.
          console.log(`(MOCK) Setting submission status to 'submitted' for ${submissionId}`);
          
          // Launch ECS task for each scorer
          for (const scorerType of challengeConfig.scorers) {
            console.log(`Launching scorer ${scorerType} for submission ${submissionId}`);
            promises.push(runScorerTask({ challengeId, scorerType, submissionId }));
          }
        } catch (processingError) {
          console.error('Error processing individual record:', processingError, 'Record:', record);
        }
      }
    }
  }
  
  const results = await Promise.allSettled(promises);
  const failedTasks = results.filter(result => result.status === 'rejected');
  
  if (failedTasks.length > 0) {
    failedTasks.forEach((result, idx) => {
      console.error(`Scorer task ${idx} failed:`, result.reason);
    });
    console.error('All failed task results:', JSON.stringify(failedTasks, null, 2));
    throw new Error(`${failedTasks.length} out of ${promises.length} scorer tasks failed.`);
  }
  
  console.log(`Successfully processed ${promises.length} scorer tasks`);
  return { status: 'Batch processed successfully' };
};
