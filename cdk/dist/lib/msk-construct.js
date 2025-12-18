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
exports.MskConstruct = void 0;
const ec2 = __importStar(require("aws-cdk-lib/aws-ec2"));
const msk = __importStar(require("aws-cdk-lib/aws-msk"));
const constructs_1 = require("constructs");
class MskConstruct extends constructs_1.Construct {
    constructor(scope, id, props) {
        super(scope, id);
        const { vpc, clusterName } = props;
        // --- Dedicated Security Group for MSK Cluster ---
        this.mskSecurityGroup = new ec2.SecurityGroup(this, 'MskSecurityGroup', {
            vpc,
            description: 'Security group for MSK cluster',
            allowAllOutbound: true,
        });
        // Allow internal MSK communication
        this.mskSecurityGroup.addIngressRule(this.mskSecurityGroup, ec2.Port.tcp(9094), 'Allow internal MSK broker communication (TLS)');
        // Potentially add ZK ports if needed: ec2.Port.tcp(2181)
        // --- MSK Configuration (for auto topic creation) ---
        const mskConfiguration = new msk.CfnConfiguration(this, 'MskConfiguration', {
            name: `${clusterName}-config`,
            serverProperties: 'auto.create.topics.enable=true\n', // Use \n for newline if adding more prop
        });
        // --- MSK Cluster --- 
        this.mskCluster = new msk.CfnCluster(this, 'MatchScorerMSKCluster', {
            clusterName: clusterName,
            kafkaVersion: '3.4.0',
            numberOfBrokerNodes: 2,
            brokerNodeGroupInfo: {
                instanceType: 'kafka.t3.small',
                clientSubnets: vpc.privateSubnets.map(subnet => subnet.subnetId),
                securityGroups: [this.mskSecurityGroup.securityGroupId],
                storageInfo: {
                    ebsStorageInfo: { volumeSize: 100 },
                },
            },
            encryptionInfo: {
                encryptionInTransit: {
                    clientBroker: 'TLS',
                    inCluster: true,
                },
            },
            // Associate the configuration with the cluster
            configurationInfo: {
                arn: mskConfiguration.attrArn,
                revision: mskConfiguration.attrLatestRevisionRevision,
            }
        });
    }
}
exports.MskConstruct = MskConstruct;
//# sourceMappingURL=msk-construct.js.map