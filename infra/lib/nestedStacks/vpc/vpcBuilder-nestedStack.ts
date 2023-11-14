/* eslint-disable @typescript-eslint/no-unused-vars */
/*
 * Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { CfnOutput } from "aws-cdk-lib";
import { Stack, NestedStack } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { NagSuppressions } from "cdk-nag";
import * as Config from "../../../config/config";
import { generateUniqueNameHash } from "../../helper/security";

export interface VPCBuilderNestedStackProps extends cdk.StackProps {
    config: Config.Config;
}

/**
 * Default input properties
 */
const defaultProps: Partial<VPCBuilderNestedStackProps> = {
    //stackName: "",
    //env: {},
};

export class VPCBuilderNestedStack extends NestedStack {

    public vpc:ec2.IVpc
    private azCount:number

    constructor(parent: Construct, name: string, props: VPCBuilderNestedStackProps) {
        super(parent, name);

        props = { ...defaultProps, ...props };

        //Set how many AZ's we need. Note: GovCloud only has max 3 AZs as of 11/09/2023
        //VisualizerPipelineReqs - 1Az - Private Subnet (Each)
        //ALBReqs - 2AZ - Private or PublicSubnet (Each)
        //OpenSearchProvisioned - 3AZ - Private Subnet (Each)
        if(props.config.app.openSearch.useProvisioned.enabled) {
            this.azCount = 3
        }
        else if(props.config.app.useAlb.enabled) {
            this.azCount = 2
        }
        else
            //Visualizer pipeline and/or lambda functions only
            this.azCount = 1 

        if (props.config.app.useGlobalVpc.optionalExternalVpcId != null && props.config.app.useGlobalVpc.optionalExternalVpcId != "undefined") {
            //Use Existing VPC
            const getExistingVpc = ec2.Vpc.fromLookup(this, "ImportedVPC", {
                isDefault: false,
                vpcId: props.config.app.useGlobalVpc.optionalExternalVpcId,
            });

            //Error case checks on existing VPC
            if (getExistingVpc.isolatedSubnets.length == 0 && getExistingVpc.privateSubnets.length == 0) {
                throw new Error(
                    "Existing VPC must have at least 1 private/isolated subnet already setup!"
                );
            }

            if(props.config.app.openSearch.useProvisioned.enabled && (getExistingVpc.isolatedSubnets.length+getExistingVpc.privateSubnets.length) < 3) {
                //Todo: check to make sure we have at least 3 AZ coverage on the subnets
                throw new Error(
                    "Existing VPC must have at least 3 private/isolated subnets in different AZs already setup when using OpenSearch provisioned!"
                );
            }

            if (props.config.app.useAlb.enabled && ((props.config.app.useAlb.usePublicSubnet && getExistingVpc.publicSubnets.length < 2) 
            || (!props.config.app.useAlb.usePublicSubnet && (getExistingVpc.isolatedSubnets.length+getExistingVpc.privateSubnets.length) < 2))) {
                throw new Error(
                    "Existing VPC must have at least 2 private or public subnets already setup when specifying the use of a ALB (based on Public Subnet Use Configuration)!"
                );
            }

            this.vpc = getExistingVpc;

        } else {
            /**
             * Subnets
             */
            const subnetPrivateConfig: ec2.SubnetConfiguration = {
                name: "isolated-subnet",
                subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
                cidrMask: 22, // 1024
            };

            const subnetPublicConfig: ec2.SubnetConfiguration = {
                name: "public-subnet",
                subnetType: ec2.SubnetType.PUBLIC,
                cidrMask: 22, // 1024

            };

            /**
             * VPC
             */
            const vpcLogsGroups = new LogGroup(this, "CloudWatchVAMSVpc", {
                logGroupName:
                    "/aws/vendedlogs/VAMSCloudWatchVPCLogs" +
                    generateUniqueNameHash(props.config.env.coreStackName,  props.config.env.account, "VAMSCloudWatchVPCLogs", 10),
                retention: RetentionDays.ONE_WEEK,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
            });

            //const cidrRange = "10.0.0.0/16"; // 4096

            this.vpc = new ec2.Vpc(this, "Vpc", {
                ipAddresses: ec2.IpAddresses.cidr(props.config.app.useGlobalVpc.vpcCidrRange),
                subnetConfiguration: (props.config.app.useAlb.enabled && props.config.app.useAlb.usePublicSubnet)? [subnetPrivateConfig, subnetPublicConfig] : [subnetPrivateConfig], //If the ALB is public, include the public subnets
                maxAzs: this.azCount, 
                enableDnsHostnames: true,
                enableDnsSupport: true,
                flowLogs: {
                    "vpc-logs": {
                        destination: ec2.FlowLogDestination.toCloudWatchLogs(vpcLogsGroups),
                        trafficType: ec2.FlowLogTrafficType.ALL,
                    },
                },
            });

            //Add Global Gateway Endpoints
            if(props.config.app.useGlobalVpc.addVpcEndpoints) {
                this.vpc.addGatewayEndpoint("S3Endpoint", {
                    service: ec2.GatewayVpcEndpointAwsService.S3,
                    subnets: [{ subnets: this.vpc.isolatedSubnets.concat(this.vpc.privateSubnets)}],
                });

                this.vpc.addGatewayEndpoint("DynamoEndpoint", {
                    service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
                    subnets: [{ subnets: this.vpc.isolatedSubnets.concat(this.vpc.privateSubnets)}],
                });
            }
        }


        /**
         * Outputs
         */
        new CfnOutput(this, "VPCId", {
            value: this.vpc.vpcId,
        });
    

    }
}
