/*
 * Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { CfnOutput } from "aws-cdk-lib";
import { Stack } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { NagSuppressions } from "cdk-nag";

/* eslint-disable @typescript-eslint/no-empty-interface */
export interface VpcGatewayGovCloudConstructProps extends cdk.StackProps {
    vpcCidrRange: string
    setupPublicAccess:boolean
}

const defaultProps: Partial<VpcGatewayGovCloudConstructProps> = {
    stackName: "",
    env: {},
};

/**
 * Custom configuration to Cognito.
 */
export class VpcGatewayGovCloudConstruct extends Construct {
    readonly vpc: ec2.Vpc;
    readonly subnets: {
        webApp: ec2.ISubnet[];
    };

    constructor(
        parent: Construct,
        name: string,
        props: VpcGatewayGovCloudConstructProps
    ) {
        super(parent, name);

        props = { ...defaultProps, ...props };

        /**
         * VPC + Logs
         */
        const vpcLogsGroups = new LogGroup(this, "CloudWatchVPCWebDistroLogs", {
            retention: RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
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
