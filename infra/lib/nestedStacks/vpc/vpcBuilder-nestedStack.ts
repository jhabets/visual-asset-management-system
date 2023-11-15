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
    public vpceSecurityGroup: ec2.ISecurityGroup

    private azCount:number

    constructor(parent: Construct, name: string, props: VPCBuilderNestedStackProps) {
        super(parent, name);

        props = { ...defaultProps, ...props };

        //Set how many AZ's we need. Note: GovCloud only has max 3 AZs as of 11/09/2023
        //VisualizerPipelineReqs - 1Az - Private Subnet (Each)
        //ALBReqs - 2AZ - Private or PublicSubnet (Each)
        //OpenSearchProvisioned - 3AZ - Private Subnet (Each)
        if(props.config.app.openSearch.useProvisioned.enabled) {
            this.azCount = 3;
        }
        else if(props.config.app.useAlb.enabled) {
            this.azCount = 2;
        }
        else
            //Visualizer pipeline and/or lambda functions only
            this.azCount = 1;

        console.log("VPC AZ Count: ", this.azCount);

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

            /**
                 * Security Groups
                 */
            const vpceSecurityGroup = new ec2.SecurityGroup(
                this,
                "VPCeSecurityGroup",
                {
                    vpc: this.vpc,
                    allowAllOutbound: true,
                    description: "VPC Endpoints Security Group",
                }
            );

            this.vpceSecurityGroup = vpceSecurityGroup;

            // add ingress rules for most service to service oriented communications
            vpceSecurityGroup.addIngressRule(
                ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
                ec2.Port.tcp(443),
                "Allow HTTPS Access"
            );
            vpceSecurityGroup.addIngressRule(
                ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
                ec2.Port.tcp(53),
                "Allow TCP for ECR Access"
            );
            vpceSecurityGroup.addIngressRule(
                ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
                ec2.Port.udp(53),
                "Allow UDP for ECR Access"
            );

                /**
             * VPC Endpoints
             */

            //Get subnets to put Endpoints in (no more than 1 subnet per AZ)
            const subnets:ec2.ISubnet[] = []
            const azUsed:string[] = []
    
            this.vpc.isolatedSubnets.forEach( (element) => {
                if (azUsed.indexOf(element.availabilityZone) == -1) {
                    azUsed.push(element.availabilityZone)
                    subnets.push(element)
                }
            });

            this.vpc.privateSubnets.forEach( (element) => {
                if (azUsed.indexOf(element.availabilityZone) == -1) {
                    azUsed.push(element.availabilityZone)
                    subnets.push(element)
                }
            });

            this.vpc.publicSubnets.forEach( (element) => {
                if (azUsed.indexOf(element.availabilityZone) == -1) {
                    azUsed.push(element.availabilityZone)
                    subnets.push(element)
                }
            });

            //Add VPC endpoints based on configuration options
            //Note: This is mostly to not duplicate endpoints if bringing in an external VPC that already has the needed endpoints for the services
            //Note: More switching is done to avoid creating endpoints when not needed (mostly for cost)
            if(props.config.app.useGlobalVpc.addVpcEndpoints)
            {
                //Visualizer Pipeline-Only Required Endpoints
                if(props.config.app.pipelines.usePointCloudVisualization.enabled)
                {
                    // Create VPC endpoint for Batch
                    new ec2.InterfaceVpcEndpoint(this, "BatchEndpoint", {
                        vpc: this.vpc,
                        privateDnsEnabled: true,
                        service: ec2.InterfaceVpcEndpointAwsService.BATCH,
                        subnets: { subnets: subnets},
                        securityGroups: [vpceSecurityGroup],
                    });
                }

                //All Lambda and Visualizer Pipeline Required Endpoints
                if(props.config.app.useGlobalVpc.useForAllLambdas || props.config.app.pipelines.usePointCloudVisualization.enabled)
                {
                    // Create VPC endpoint for ECR API
                    new ec2.InterfaceVpcEndpoint(this, "ECRAPIEndpoint", {
                        vpc: this.vpc,
                        privateDnsEnabled: true, // Needed for Fargate<->ECR
                        service: ec2.InterfaceVpcEndpointAwsService.ECR,
                        subnets: { subnets: subnets},
                        securityGroups: [vpceSecurityGroup],
                    });

                    // Create VPC endpoint for ECR Docker API
                    new ec2.InterfaceVpcEndpoint(this, "ECRDockerEndpoint", {
                        vpc: this.vpc,
                        privateDnsEnabled: true, // Needed for Fargate<->ECR
                        service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
                        subnets: { subnets: subnets},
                        securityGroups: [vpceSecurityGroup],
                    });

                    // Create VPC endpoint for CloudWatch Logs
                    new ec2.InterfaceVpcEndpoint(this, "CloudWatchEndpoint", {
                        vpc: this.vpc,
                        privateDnsEnabled: true,
                        service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
                        subnets: { subnets: subnets},
                        securityGroups: [vpceSecurityGroup],
                    });

                    // Create VPC endpoint for SNS
                    new ec2.InterfaceVpcEndpoint(this, "SNSEndpoint", {
                        vpc: this.vpc,
                        privateDnsEnabled: true,
                        service: ec2.InterfaceVpcEndpointAwsService.SNS,
                        subnets: { subnets: subnets},
                        securityGroups: [vpceSecurityGroup],
                    });

                    // Create VPC endpoint for SFN
                    new ec2.InterfaceVpcEndpoint(this, "SFNEndpoint", {
                        vpc: this.vpc,
                        privateDnsEnabled: true,
                        service: ec2.InterfaceVpcEndpointAwsService.STEP_FUNCTIONS,
                        subnets: { subnets: subnets},
                        securityGroups: [vpceSecurityGroup],
                    });

                }

                //All Lambda and OpenSearch Provisioned Required Endpoints
                if(props.config.app.useGlobalVpc.useForAllLambdas || props.config.app.openSearch.useProvisioned.enabled)
                {
                    // Create VPC endpoint for SSM
                    new ec2.InterfaceVpcEndpoint(this, "SSMEndpoint", {
                        vpc: this.vpc,
                        privateDnsEnabled: true,
                        service: ec2.InterfaceVpcEndpointAwsService.SSM,
                        subnets: { subnets: subnets},
                        securityGroups: [vpceSecurityGroup]
                    });
                }

                //All Lambda Required Endpoints
                if(props.config.app.useGlobalVpc.useForAllLambdas)
                {
                    // Create VPC endpoint for Lambda
                    new ec2.InterfaceVpcEndpoint(this, "LambdaEndpoint", {
                        vpc: this.vpc,
                        privateDnsEnabled: true,
                        service: ec2.InterfaceVpcEndpointAwsService.LAMBDA,
                        subnets: { subnets: subnets},
                        securityGroups: [vpceSecurityGroup],
                    });

                    // Create VPC endpoint for STS
                    new ec2.InterfaceVpcEndpoint(this, "STSEndpoint", {
                        vpc: this.vpc,
                        privateDnsEnabled: true,
                        service: ec2.InterfaceVpcEndpointAwsService.STS,
                        subnets: { subnets: subnets},
                        securityGroups: [vpceSecurityGroup],
                    });
                }
            }

            //Add Global Gateway Endpoints (no cost so we add for everything)
            if(props.config.app.useGlobalVpc.addVpcEndpoints) {
                this.vpc.addGatewayEndpoint("S3Endpoint", {
                    service: ec2.GatewayVpcEndpointAwsService.S3,
                    subnets: [{subnets: subnets}],
                });

                this.vpc.addGatewayEndpoint("DynamoEndpoint", {
                    service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
                    subnets: [{ subnets: subnets}],
                });
            }


        //Nag Supressions
        NagSuppressions.addResourceSuppressions(
            vpceSecurityGroup,
            [
                {
                    id: "AwsSolutions-EC23",
                    reason: "VPCe Security Group is restricted to VPC cidr range on ports 443 and 53",
                },
                {
                    id: "CdkNagValidationFailure",
                    reason: "Validation failure due to inherent nature of CDK Nag Validations of CIDR ranges", //https://github.com/cdklabs/cdk-nag/issues/817
                },
            ]
        );
            

        }


        /**
         * Outputs
         */
        new CfnOutput(this, "VPCId", {
            value: this.vpc.vpcId,
        });
    

    }
}
