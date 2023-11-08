/*
 * Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { Service } from "../../../helper/service-helper";
import { NagSuppressions } from "cdk-nag";
import { CfnOutput, CustomResource, Names, Stack, NestedStack } from "aws-cdk-lib";
import * as cr from "aws-cdk-lib/custom-resources";
import * as njslambda from "aws-cdk-lib/aws-lambda-nodejs";
import * as path from "path";
import { LAMBDA_NODE_RUNTIME } from '../../../../config/config';
import {
    Port,
    SecurityGroup,
    Vpc,
  } from "aws-cdk-lib/aws-ec2";
  import {
    AnyPrincipal,
    CfnServiceLinkedRole,
    PolicyStatement,
  } from "aws-cdk-lib/aws-iam";
  import { IAMClient, ListRolesCommand } from "@aws-sdk/client-iam";

/* eslint-disable @typescript-eslint/no-empty-interface */
export interface OpensearchProvisionedConstructProps {
    indexName: string;
    dataNodeInstanceType?: string;
    dataNodesCount?: number;
    masterNodeInstanceType?: string;
    masterNodesCount?: number;
    ebsVolumeSize?: number;
    ebsVolumeType?: cdk.aws_ec2.EbsDeviceVolumeType;
    zoneAwareness?: cdk.aws_opensearchservice.ZoneAwarenessConfig;
}

const defaultProps: Partial<OpensearchProvisionedConstructProps > = {
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
    zoneAwareness: { enabled: true }
};

const iam = new IAMClient({});

/*
Deploys an Amazon Opensearch Domain
*/
export class OpensearchProvisionedConstruct extends Construct {

    aosName: string;
    domain: cdk.aws_opensearchservice.Domain;
    domainEndpoint: string;

    constructor(scope: Construct, name: string, props: OpensearchProvisionedConstructProps ) {
        super(scope, name);
        props = { ...defaultProps, ...props };

        this.aosName = name;

        const region = cdk.Stack.of(this).region;
        const account = cdk.Stack.of(this).account;
        const stackName = cdk.Stack.of(this).stackName;

        //https://github.com/aws-samples/opensearch-vpc-cdk/blob/main/lib/opensearch-vpc-cdk-stack.ts

        // VPC
        //const vpc = new Vpc(this, "openSearchVpc", {});

        // Service-linked role that Amazon OpenSearch Service will use
        (async () => {
            const response = await iam.send(
            new ListRolesCommand({
                PathPrefix: "/aws-service-role/opensearchservice.amazonaws.com/",
            })
            );
    
            // Only if the role for OpenSearch Service doesn't exist, it will be created.
            if (response.Roles && response.Roles?.length == 0) {
            new CfnServiceLinkedRole(this, "OpensearchServiceLinkedRole", {
                awsServiceName: "es.amazonaws.com",
            });
            }
        })();

        const osDomain = new cdk.aws_opensearchservice.Domain(this, "OpenSearchDomain", {
            version: cdk.aws_opensearchservice.EngineVersion.OPENSEARCH_2_7,

            ebs: {
                enabled: false,
            },
            // ebs: {
            //    volumeSize: props.ebsVolumeSize,
            //    volumeType: props.ebsVolumeType,
            // },
            nodeToNodeEncryption: true,
            encryptionAtRest: {
                enabled: true,
            },
            //vpc: vpc,
            capacity: {
                dataNodeInstanceType: props.dataNodeInstanceType,
                dataNodes: props.dataNodesCount,
                masterNodeInstanceType: props.masterNodeInstanceType,
                masterNodes: props.masterNodesCount,
            },
            enforceHttps: true,
            zoneAwareness: props.zoneAwareness,
            //Disabled fine grained access control to allow the domain access policy to restrict to IAM roles
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
        this.domainEndpoint = "https://"+osDomain.domainEndpoint;

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
            }
        );

        schemaDeploy.addToRolePolicy(
            new cdk.aws_iam.PolicyStatement({
                actions: ["es:*"],
                resources: [this.domain.domainArn, this.domain.domainArn+"/*"],
                effect: cdk.aws_iam.Effect.ALLOW,
            })
        );
        schemaDeploy.addToRolePolicy(
            new cdk.aws_iam.PolicyStatement({
                actions: ["ssm:*"],
                resources: ["*"],
                // resources: [`arn:<AWS::Partition>:ssm:::parameter/${cdk.Stack.of(this).stackName}/*`],
                effect: cdk.aws_iam.Effect.ALLOW,
            })
        );

        this.grantDomainAccess(schemaDeploy);


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
                domainEndpoint: "https://"+osDomain.domainEndpoint,
                indexName: props.indexName,
                stackName: cdk.Stack.of(this).stackName,
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
        NagSuppressions.addResourceSuppressions(
            schemaDeployProvider,
            [
                {
                    id: "AwsSolutions-L1",
                    reason: "Configured as intended.",
                },
            ]
        );

        NagSuppressions.addResourceSuppressions(
            osDomain,
            [
                {
                    id: "AwsSolutions-OS1",
                    reason: "Configured as intended. Provisioned configuration meant primarily for GovCloud deployment that won't be public and restricted to individual lambda roles for access to the domain.",
                },
                {
                    id: "AwsSolutions-OS3",
                    reason: "Configured as intended. Provisioned configuration meant primarily for GovCloud deployment that won't be public and restricted to individual lambda roles for access to the domain.",
                },
            ]
        );

    }

    public endpointSSMParameterName(): string {
        return "/" + [cdk.Stack.of(this).stackName, this.aosName, "endpoint"].join("/");
    }

    public grantDomainAccess(construct: Construct & { role?: cdk.aws_iam.IRole }) {

        //Restrict to role ARNS of the lambda functions accessing opensearch (main access policy for opensearch provisionned with no VPC)
        const opensearchDomainPolicy = new cdk.aws_iam.PolicyStatement({
            effect: cdk.aws_iam.Effect.ALLOW,
            principals: [construct.role!], 
            resources: [this.domain.domainArn+"/*"], 
            actions: ["es:ESHttp*"],
        });

        this.domain.addAccessPolicies(opensearchDomainPolicy);

        return opensearchDomainPolicy;
    }

}


