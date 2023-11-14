/*
 * Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { Service } from "../../../helper/service-helper";
import { NagSuppressions } from "cdk-nag";
import { CfnOutput, CustomResource } from "aws-cdk-lib";
import * as cr from "aws-cdk-lib/custom-resources";
import * as njslambda from "aws-cdk-lib/aws-lambda-nodejs";
import * as path from "path";
import { LAMBDA_NODE_RUNTIME } from "../../../../config/config";
import { Port, SecurityGroup, Vpc } from "aws-cdk-lib/aws-ec2";
import { CfnServiceLinkedRole } from "aws-cdk-lib/aws-iam";
import { IAMClient, ListRolesCommand } from "@aws-sdk/client-iam";
import * as Config from "../../../../config/config";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as lambda from "aws-cdk-lib/aws-lambda";

/* eslint-disable @typescript-eslint/no-empty-interface */
export interface OpensearchProvisionedConstructProps {
    indexName: string;
    config: Config.Config;
    vpc: ec2.IVpc;
    dataNodeInstanceType?: string;
    dataNodesCount?: number;
    masterNodeInstanceType?: string;
    masterNodesCount?: number;
    ebsVolumeSize?: number;
    ebsVolumeType?: cdk.aws_ec2.EbsDeviceVolumeType;
    zoneAwareness?: cdk.aws_opensearchservice.ZoneAwarenessConfig;
}

const defaultProps: Partial<OpensearchProvisionedConstructProps> = {
    //  masterNodeInstanceType: 'r6g.2xlarge.search',
    //  dataNodeInstanceType: 'r6g.2xlarge.search',
    // masterNodeInstanceType: 'r6g.large.search',
    masterNodeInstanceType: "r6g.large.search",
    // masterNodeInstanceType: 'r5.large.search',
    // dataNodeInstanceType:   'r6g.large.search',
    // dataNodeInstanceType: 'r6g.2xlarge.search',
    // dataNodeInstanceType: 'i3.2xlarge.search',
    dataNodeInstanceType: "r6gd.large.search",
    masterNodesCount: 3, //Minimum of 3
    dataNodesCount: 2, //Minimum of 2, must be even number.
    // ebsVolumeSize: 256,
    // ebsVolumeType: cdk.aws_ec2.EbsDeviceVolumeType.GENERAL_PURPOSE_SSD_GP3,
    zoneAwareness: { enabled: true },
};

const iam = new IAMClient({});

/*
Deploys an Amazon Opensearch Domain
*/
export class OpensearchProvisionedConstruct extends Construct {
    aosName: string;
    domain: cdk.aws_opensearchservice.Domain;
    domainEndpoint: string;
    config: Config.Config

    constructor(scope: Construct, name: string, props: OpensearchProvisionedConstructProps) {
        super(scope, name);
        props = { ...defaultProps, ...props };

        this.aosName = name;

        this.config = props.config;

        //https://github.com/aws-samples/opensearch-vpc-cdk/blob/main/lib/opensearch-vpc-cdk-stack.ts

        // Service-linked role that Amazon OpenSearch Service will use
        (async () => {
            const response = await iam.send(
                new ListRolesCommand({
                    PathPrefix: `/aws-service-role/${Service("ES").PrincipalString}/`,
                })
            );

            // Only if the role for OpenSearch Service doesn't exist, it will be created.
            if (response.Roles && response.Roles?.length == 0) {
                new CfnServiceLinkedRole(this, "OpensearchServiceLinkedRole", {
                    awsServiceName: "es.amazonaws.com", //Currently fixed name and not related to principal name
                });
            }
        })();

        //Loop through all private + isolated subnets and store subnets in an array up to the total number of data nodes specified
        //Note: Make sure each subnet chosen is in a different availability zone. OS Domains are very sensitive about choosing the right subnets. 
        let subnets:ec2.ISubnet[] = []
        let azUsed:string[] = []

        props.vpc.isolatedSubnets.forEach( (element) => {
            if (azUsed.indexOf(element.availabilityZone) == -1 && subnets.length < props.dataNodesCount!) {
                azUsed.push(element.availabilityZone)
                subnets.push(element)
            }
        });
        props.vpc.privateSubnets.forEach( (element) => {
            if (azUsed.indexOf(element.availabilityZone) == -1 && subnets.length < props.dataNodesCount!) {
                azUsed.push(element.availabilityZone)
                subnets.push(element)
            }
        });

        const osDomain = new cdk.aws_opensearchservice.Domain(this, "OpenSearchDomain", {
            version: Config.OPENSEARCH_VERSION,

            ebs: {
                enabled: false,
                // volumeSize: props.ebsVolumeSize,
                // volumeType: props.ebsVolumeType,
            },
            nodeToNodeEncryption: true,
            encryptionAtRest: {
                enabled: true,
            },
            vpc: props.vpc,
            vpcSubnets: [{subnets: subnets,
                        onePerAz: true }],
            capacity: {
                dataNodeInstanceType: props.dataNodeInstanceType,
                dataNodes: props.dataNodesCount,
                masterNodeInstanceType: props.masterNodeInstanceType,
                masterNodes: props.masterNodesCount,
            },
            enforceHttps: true,
            zoneAwareness: props.zoneAwareness,
            //Disabled fine grained access control to allow the VPC and domain access policy to restrict to IAM roles
            //fineGrainedAccessControl: {
            //    masterUserArn: props.cognitoAuthenticatedRole,
            //},
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            enableVersionUpgrade: true,
            enableAutoSoftwareUpdate: true,
            logging: {
                //auditLogEnabled: true, //Used only for fine-grained access control
                slowSearchLogEnabled: true,
                appLogEnabled: true,
                slowIndexLogEnabled: true,
            },
        });

        this.domain = osDomain;
        this.domainEndpoint = "https://" + osDomain.domainEndpoint;

        const schemaDeploy = new njslambda.NodejsFunction(
            this,
            "OpensearchProvisionedDeploySchema",
            {
                entry: path.join(__dirname, "./schemaDeploy/deployschemaprovisioned.ts"),
                handler: "handler",
                bundling: {
                    externalModules: ["aws-sdk"],
                },
                runtime: LAMBDA_NODE_RUNTIME,
                vpc: props.vpc
                //Note: This schema deploy resource must run in the VPC in order to communicate with the AOS provisioned running in the VPC. 
            }
        );

        schemaDeploy.addToRolePolicy(
            new cdk.aws_iam.PolicyStatement({
                actions: ["es:*"],
                resources: [this.domain.domainArn, this.domain.domainArn + "/*"],
                effect: cdk.aws_iam.Effect.ALLOW,
            })
        );
        schemaDeploy.addToRolePolicy(
            new cdk.aws_iam.PolicyStatement({
                actions: ["ssm:*"],
                resources: ["*"],
                // resources: [`arn:<AWS::Partition>:ssm:::parameter/${this.config.env.coreStackName}/*`],
                effect: cdk.aws_iam.Effect.ALLOW,
            })
        );

        this.grantOSDomainAccess(schemaDeploy);
        
        const schemaDeployProvider = new cr.Provider(
            this,
            "OpensearchProvisionedDeploySchemaProvider",
            {
                onEventHandler: schemaDeploy,
            }
        );

        schemaDeployProvider.node.addDependency(schemaDeploy);
        schemaDeployProvider.node.addDependency(osDomain);

        new CustomResource(this, "DeploySSMIndexSchema", {
            serviceToken: schemaDeployProvider.serviceToken,
            properties: {
                aosName: this.aosName,
                domainEndpoint: "https://" + osDomain.domainEndpoint,
                indexName: props.indexName,
                stackName: this.config.env.coreStackName,
                version: "1",
            },
        });

        /**
         * Outputs
         */
        new CfnOutput(this, "OpenSearchProvisionedDomainEndpoint", {
            value: this.domainEndpoint,
        });

        //NAG Surpressions
        NagSuppressions.addResourceSuppressions(schemaDeployProvider, [
            {
                id: "AwsSolutions-L1",
                reason: "Configured as intended.",
            },
        ]);

        NagSuppressions.addResourceSuppressions(osDomain, [
            {
                id: "AwsSolutions-OS1",
                reason: "Configured as intended. Provisioned configuration meant primarily for GovCloud deployment that won't be public and restricted to individual lambda roles for access to the domain.",
            },
            {
                id: "AwsSolutions-OS3",
                reason: "Configured as intended. Provisioned configuration meant primarily for GovCloud deployment that won't be public and restricted to individual lambda roles for access to the domain.",
            },
        ]);
    }

    public endpointSSMParameterName(): string {
        return "/" + [this.config.env.coreStackName, this.aosName, "endpoint"].join("/");
    }

    public grantOSDomainAccess(lambdaFunction: lambda.Function & { role?: cdk.aws_iam.IRole }) {

        //Restrict to role ARNS of the lambda functions accessing opensearch (main access policy for opensearch provisioned + VPC security group)
        const opensearchDomainPolicy = new cdk.aws_iam.PolicyStatement({
            effect: cdk.aws_iam.Effect.ALLOW,
            principals: [lambdaFunction.role!],
            resources: [this.domain.domainArn + "/*"],
            actions: ["es:ESHttp*"],
        });

        this.domain.addAccessPolicies(opensearchDomainPolicy);
        this.domain.connections.allowFrom(lambdaFunction, Port.tcp(443));

        return opensearchDomainPolicy;
    }
}
