// Interface for the configuration structure
export interface AppConfig {
  submissionApiUrl: string;
  reviewScorecardId: string;
  reviewTypeName: string;
  logLevel: string;
  mskClusterName: string;
  ecsClusterName: string;
  logGroupName: string;
  taskTimeoutSeconds: string;
  maxRetries: string;
  // Auth0 M2M configuration
  auth0Url: string;
  auth0Audience: string;
  auth0ClientId: string;
  auth0ClientSecret: string;
  auth0ProxyUrl: string;
}

// Function to load configuration from environment variables and file
function loadConfig(): AppConfig {
  return {
    submissionApiUrl: process.env.SUBMISSION_API_URL || 'https://api.topcoder-dev.com/v5',
    reviewScorecardId: process.env.REVIEW_SCORECARD_ID || '30001852',
    reviewTypeName: process.env.REVIEW_TYPE_NAME || 'MMScorer',
    logLevel: process.env.LOG_LEVEL || 'debug',
    mskClusterName: process.env.MSK_CLUSTER_NAME || 'match-scorer',
    ecsClusterName: process.env.ECS_CLUSTER_NAME || 'match-scorer-ecs-cluster',
    logGroupName: process.env.LOG_GROUP_NAME || '/ecs/match-scorer',
    taskTimeoutSeconds: process.env.TASK_TIMEOUT_SECONDS || '60',
    maxRetries: process.env.MAX_RETRIES || '3',
    // Auth0 M2M defaults (can be overridden via env vars)
    auth0Url: process.env.AUTH0_URL || 'https://topcoder-dev.auth0.com/oauth/token',
    auth0Audience: process.env.AUTH0_AUDIENCE || 'https://m2m.topcoder-dev.com/',
    auth0ClientId: process.env.AUTH0_CLIENT_ID || '',
    auth0ClientSecret: process.env.AUTH0_CLIENT_SECRET || '',
    auth0ProxyUrl: process.env.AUTH0_PROXY_URL || 'https://auth0proxy.topcoder-dev.com/token',
  };
}

// Export the loaded configuration
export const config: AppConfig = loadConfig();

// Add dev challengeId and scorer types for Parameter Store setup
export const devChallengeId = '30096756';
export const devScorers = [
  {
    name: 'BioSlime',
    testerClass: 'com.topcoder.challenges.mm160.BioSlimeTester',
    timeLimit: 10000,
    timeout: 10000,
    compileTimeout: 10000,
    startSeed: 42,
    numberOfTests: 1,
    phases: [
      {
        name: 'example',
        reviewTypeId: '70a39434-ff40-430c-bbe0-b00882e7f92e',
        scoreCardId: '30001852'
      },
      {
        name: 'provisional',
        reviewTypeId: '2ef9953d-49e9-47fc-842e-c2b9b18a9e3b',
        scoreCardId: '30001852'
      }
    ]
  }
];
 