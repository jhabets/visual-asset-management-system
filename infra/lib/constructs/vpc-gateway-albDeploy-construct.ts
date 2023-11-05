/*
 * Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { CfnOutput, Names } from "aws-cdk-lib";
import { Stack } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { NagSuppressions } from "cdk-nag";

/* eslint-disable @typescript-eslint/no-empty-interface */
export interface VpcGatewayAlbDeployConstructProps extends cdk.StackProps {
    optionalExistingVPCId: string
    vpcCidrRange: string
    setupPublicAccess:boolean
}

const defaultProps: Partial<VpcGatewayAlbDeployConstructProps> = {
    stackName: "",
    env: {},
};

/**
 * Custom configuration to Cognito.
 */
export class VpcGatewayAlbDeployConstruct extends Construct {
    readonly vpc: ec2.IVpc
    readonly subnets: {
        webApp: ec2.ISubnet[];
    };

    constructor(
        parent: Construct,
        name: string,
        props: VpcGatewayAlbDeployConstructProps
    ) {
        super(parent, name);

        props = { ...defaultProps, ...props };


        if(props.optionalExistingVPCId != null && props.optionalExistingVPCId != "undefined")
        {
            //Use Existing VPC
            const getExistingVpc = ec2.Vpc.fromLookup(this, "ImportedVPC", {
                isDefault: false,
                vpcId: props.optionalExistingVPCId
            });

            if((!props.setupPublicAccess && getExistingVpc.isolatedSubnets.length == 0) || (props.setupPublicAccess && getExistingVpc.publicSubnets.length == 0))
            {
                throw new Error("Provided ALB Optional Existing VPC must have at least 1 private or public subnet already setup, depending on if ALB public access is enabled!");
            }

            this.vpc = getExistingVpc;
        }
        else
        {
            //Create new VPC + Log group

            /**
             * VPC + Logs
             */
            const vpcLogsGroups = new LogGroup(this, "CloudWatchVPCWebDistroLogs", {
                logGroupName: "/aws/vendedlogs/VAMSCloudWatchVPCWebDistroLogs"+Math.floor(Math.random() * 100000000),
                retention: RetentionDays.ONE_WEEK,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
            });

            //const cidrRange = "10.1.0.0/16"; // 4096

            //Create VPC that auto creates 1 private and 1 public subnet per AZ
            this.vpc = new ec2.Vpc(this, "Vpc", {
                ipAddresses: ec2.IpAddresses.cidr(props.vpcCidrRange),
                maxAzs: 2, //Two AZs for VPC for now
                enableDnsHostnames: true,
                enableDnsSupport: true,
                flowLogs: {
                    "vpc-logs": {
                        destination: ec2.FlowLogDestination.toCloudWatchLogs(vpcLogsGroups),
                        trafficType: ec2.FlowLogTrafficType.ALL,
                    },
                },
            });

        }

        this.subnets = {
            webApp: props.setupPublicAccess? this.vpc.publicSubnets : this.vpc.isolatedSubnets,
        };

        /**
         * Outputs
         */
        new CfnOutput(this, "WebDistroVpcId", {
            value: this.vpc.vpcId,
        });
    }
}
