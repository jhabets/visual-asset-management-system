/*
 * Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as aoss from "aws-cdk-lib/aws-opensearchserverless";
import * as cr from "aws-cdk-lib/custom-resources";
import * as path from "path";
import { CustomResource, Names, NestedStack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { LAMBDA_NODE_RUNTIME } from "../../../../config/config";
import { NagSuppressions } from "cdk-nag";
import * as Config from "../../../../config/config";
import { generateUniqueNameHash } from "../../../helper/security";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { aws_opensearchserverless as opensearchserverless } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";

interface OpensearchServerlessConstructProps extends cdk.StackProps {
    config: Config.Config;
    principalArn: string[];
    indexName: string;
    vpc: ec2.IVpc;
    subnets: ec2.ISubnet[];
}

export class OpensearchServerlessConstruct extends Construct {
    public aossEndpointUrl: string;
    collectionUid: string;
    config: Config.Config;
    useVPCEndpoint: boolean;
    vpcEndpointAOSS: cdk.aws_opensearchserverless.CfnVpcEndpoint;
    vpcEndpointAOSSSecurityGroup: ec2.SecurityGroup;

    constructor(parent: Construct, name: string, props: OpensearchServerlessConstructProps) {
        super(parent, name);

        this.collectionUid = (
            "collection" +
            generateUniqueNameHash(
                props.config.env.coreStackName,
                props.config.env.account,
                "AOSSCollection",
                10
            )
        ).toLowerCase();
        this.config = props.config;

        this.useVPCEndpoint =
            props.config.app.useGlobalVpc.enabled && props.config.app.useGlobalVpc.useForAllLambdas;

        //Create Open Search VPC endpoint if we are using a VPC for all our lambda functions
        //Note: Ignoring addVpcEndpoint configuration on purpose as this is required to create to attach to a collection network security policy. must create at this juncture
        if (this.useVPCEndpoint) {

            const subNetIDsVPCe = props.vpc.selectSubnets({
                subnets: props.subnets,
            }).subnetIds;

            const aossVPCESecurityGroup = new ec2.SecurityGroup(this, "AossVPCESecurityGroup", {
                vpc: props.vpc,
                allowAllOutbound: true, //allows all output on endpoint to the service
                description: "AOSS VPC Endpoint Security Group",
            });

            //Allow connections from any VPC IP
            aossVPCESecurityGroup.addIngressRule(
                ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
                ec2.Port.tcp(443)
            );
            this.vpcEndpointAOSSSecurityGroup = aossVPCESecurityGroup;

            //Add VPC Endpoint here instead of global VPC as it's directly needed to configure AOSS
            //(https://docs.aws.amazon.com/opensearch-service/latest/developerguide/serverless-network.html, https://docs.aws.amazon.com/opensearch-service/latest/developerguide/serverless-vpc.html, https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_opensearchserverless.CfnVpcEndpoint.html)
            const cfnVpcEndpoint = new opensearchserverless.CfnVpcEndpoint(
                this,
                "AOSSCfnVpcEndpoint",
                {
                    name:
                        "aossendpoint" +
                        generateUniqueNameHash(
                            props.config.env.coreStackName,
                            props.config.env.account,
                            "AOSSCfnVpcEndpoint",
                            10
                        ).toLowerCase(),
                    subnetIds: subNetIDsVPCe,
                    vpcId: props.vpc.vpcId,
                    securityGroupIds: [aossVPCESecurityGroup.securityGroupId],
                }
            );

            cfnVpcEndpoint.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
            this.vpcEndpointAOSS = cfnVpcEndpoint;
        }

        const schemaDeploy = new lambda.Function(this, "OpensearchServerlessDeploySchema", {
            runtime: LAMBDA_NODE_RUNTIME,
            handler: "deployschemaserverless.handler",
            code: lambda.Code.fromAsset(path.join(__dirname, "./schemaDeploy/serverless")),
            vpc: this.useVPCEndpoint ? props.vpc : undefined,
            vpcSubnets: this.useVPCEndpoint ? { subnets: props.subnets } : undefined,
        });

        schemaDeploy.addToRolePolicy(
            new cdk.aws_iam.PolicyStatement({
                actions: ["aoss:*"],
                resources: ["*"],
                effect: cdk.aws_iam.Effect.ALLOW,
            })
        );
        schemaDeploy.addToRolePolicy(
            new cdk.aws_iam.PolicyStatement({
                actions: ["ssm:*"],
                resources: ["*"],
                // resources: [`arn:${Service.Partition()}:ssm:::parameter/${this.config.env.coreStackName}/*`],
                effect: cdk.aws_iam.Effect.ALLOW,
            })
        );

        const principalsForAOSS = [...props.principalArn, schemaDeploy.role?.roleArn];

        const accessPolicy = this._grantCollectionAccess(principalsForAOSS);
        this.grantVPCeAccess(schemaDeploy);

        const collection = new aoss.CfnCollection(this, "OSCollection", {
            name: this.collectionUid,
            type: "SEARCH",
        });

        const encryptionPolicy = {
            Rules: [{ ResourceType: "collection", Resource: [`collection/${collection.name}`] }],
            AWSOwnedKey: true,
        };
        const encryptionPolicyCfn = new aoss.CfnSecurityPolicy(this, "OSEncryptionPolicy", {
            name: (
                `ep` +
                generateUniqueNameHash(
                    props.config.env.coreStackName,
                    props.config.env.account,
                    "OSEncryptionPolicy",
                    20
                )
            ).toLowerCase(),
            policy: JSON.stringify(encryptionPolicy),
            type: "encryption",
        });

        const networkPolicy = [
            {
                Rules: [
                    { ResourceType: "collection", Resource: [`collection/${collection.name}`] },
                    { ResourceType: "dashboard", Resource: [`collection/${collection.name}`] },
                ],
                AllowFromPublic: !this.useVPCEndpoint,
                SourceVPCEs: this.useVPCEndpoint ? [this.vpcEndpointAOSS.ref] : undefined,
            },
        ];

        const networkPolicyCfn = new aoss.CfnSecurityPolicy(this, "OSNetworkPolicy", {
            name: (
                `np` +
                generateUniqueNameHash(
                    props.config.env.coreStackName,
                    props.config.env.account,
                    "OSNetworkPolicy",
                    20
                )
            ).toLowerCase(),
            policy: JSON.stringify(networkPolicy),
            type: "network",
        });

        if (this.useVPCEndpoint) networkPolicyCfn.node.addDependency(this.vpcEndpointAOSS);

        collection.addDependency(encryptionPolicyCfn);
        collection.addDependency(networkPolicyCfn);

        const schemaDeployProvider = new cr.Provider(this, "OSSDeploySchemaProvider", {
            onEventHandler: schemaDeploy,
        });

        schemaDeployProvider.node.addDependency(schemaDeploy);
        schemaDeployProvider.node.addDependency(collection);
        schemaDeployProvider.node.addDependency(accessPolicy);

        if (this.useVPCEndpoint) {
            schemaDeployProvider.node.addDependency(this.vpcEndpointAOSSSecurityGroup);
            schemaDeployProvider.node.addDependency(this.vpcEndpointAOSS);
        }

        new CustomResource(this, "DeploySSMIndexSchema", {
            serviceToken: schemaDeployProvider.serviceToken,
            properties: {
                collectionName: collection.name,
                collectionEndpoint: collection.attrCollectionEndpoint,
                indexName: props.indexName,
                stackName: this.config.env.coreStackName,
                version: "1",
            },
        });

        this.aossEndpointUrl = collection.attrCollectionEndpoint;

        //Nag Supressions
        NagSuppressions.addResourceSuppressions(schemaDeployProvider, [
            {
                id: "AwsSolutions-L1",
                reason: "Configured as intended.",
            },
        ]);

        if (this.useVPCEndpoint) {
            //Nag Supressions
            NagSuppressions.addResourceSuppressions(this.vpcEndpointAOSSSecurityGroup, [
                {
                    id: "AwsSolutions-EC23",
                    reason: "VPC Endpoint Security Group is restricted to VPC cidr range on ports 443",
                },
                {
                    id: "CdkNagValidationFailure",
                    reason: "Validation failure due to inherent nature of CDK Nag Validations of CIDR ranges", //https://github.com/cdklabs/cdk-nag/issues/817
                },
            ]);
        }
    }

    public endpointSSMParameterName(): string {
        return "/" + [this.config.env.coreStackName, this.collectionUid, "endpoint"].join("/");
    }

    public grantCollectionAccess(construct: Construct & { role?: cdk.aws_iam.IRole }) {
        const policy = [
            {
                Description: "Access",
                Rules: [
                    {
                        ResourceType: "index",
                        // Resource: ["index/*/*"],
                        Resource: [`index/${this.collectionUid}/assets1236`],
                        Permission: [
                            // "aoss:*",
                            "aoss:ReadDocument",
                            "aoss:WriteDocument",
                            "aoss:CreateIndex",
                            "aoss:DeleteIndex",
                            "aoss:UpdateIndex",
                            "aoss:DescribeIndex",
                        ],
                    },
                    {
                        ResourceType: "collection",
                        Resource: [`collection/${this.collectionUid}`],
                        Permission: [
                            // "aoss:*",
                            "aoss:CreateCollectionItems",
                            "aoss:DeleteCollectionItems",
                            "aoss:UpdateCollectionItems",
                            "aoss:DescribeCollectionItems",
                        ],
                    },
                ],
                Principal: [construct.role?.roleArn],
            },
        ];

        const accessPolicy = new aoss.CfnAccessPolicy(construct, "Policy", {
            name:
                "ac" +
                generateUniqueNameHash(
                    this.config.env.coreStackName,
                    this.config.env.account,
                    "ac" + construct.role?.roleArn,
                    20
                ),
            type: "data",
            policy: JSON.stringify(policy),
        });

        construct.role?.addToPrincipalPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                resources: ["*"],
                actions: ["aoss:*"],
            })
        );
        return accessPolicy;
    }

    public grantVPCeAccess(lambdaFunction: lambda.Function) {
        //Add rules to VPC endpoints if we created it
        if (this.useVPCEndpoint) {
            this.vpcEndpointAOSSSecurityGroup.connections.allowFrom(
                lambdaFunction,
                ec2.Port.tcp(443)
            );
        }
    }

    private _grantCollectionAccess(principalsForAOSS: (string | undefined)[]) {
        // type that extends Construct and has a role property
        const policy = [
            {
                Description: "Access",
                Rules: [
                    {
                        ResourceType: "index",
                        Resource: [`index/${this.collectionUid}/assets1236`],
                        Permission: ["aoss:*"],
                    },
                    {
                        ResourceType: "collection",
                        Resource: [`collection/${this.collectionUid}`],
                        Permission: ["aoss:*"],
                    },
                ],
                Principal: principalsForAOSS,
            },
        ];

        const accessPolicy = new aoss.CfnAccessPolicy(this, "Policy", {
            name:
                "acp" +
                generateUniqueNameHash(
                    this.config.env.coreStackName,
                    this.config.env.account,
                    "acp" + principalsForAOSS.toString(),
                    20
                ),
            type: "data",
            policy: JSON.stringify(policy),
        });
        return accessPolicy;
    }
}
