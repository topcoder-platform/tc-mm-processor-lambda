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
    auth0Url: string;
    auth0Audience: string;
    auth0ClientId: string;
    auth0ClientSecret: string;
    auth0ProxyUrl: string;
}
export declare const config: AppConfig;
export declare const devChallengeId = "30096756";
export declare const devScorers: {
    name: string;
    testerClass: string;
    timeLimit: number;
    timeout: number;
    compileTimeout: number;
    startSeed: number;
    numberOfTests: number;
    phases: {
        name: string;
        reviewTypeId: string;
        scoreCardId: string;
    }[];
}[];
