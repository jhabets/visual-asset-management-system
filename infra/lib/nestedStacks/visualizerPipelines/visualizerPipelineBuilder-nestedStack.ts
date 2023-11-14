/* eslint-disable @typescript-eslint/no-unused-vars */
/*
 * Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { Construct } from "constructs";
import { Names } from "aws-cdk-lib";
import { storageResources } from "../storage/storageBuilder-nestedStack";
import { LayerVersion } from "aws-cdk-lib/aws-lambda";
import * as cdk from "aws-cdk-lib";
import { NestedStack } from "aws-cdk-lib";
import { SecurityGroupGatewayVisualizerPipelineConstruct } from "./constructs/securitygroup-gateway-visualizerPipeline-construct";
import { VisualizationPipelineConstruct } from "./constructs/visualizerPipeline-construct";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as Config from "../../../config/config";

export interface VisualizerPipelineBuilderNestedStackProps extends cdk.StackProps {
    config: Config.Config;
    vpc: ec2.IVpc;
    storageResources: storageResources;
    lambdaCommonBaseLayer: LayerVersion;
}

/**
 * Default input properties
 */
const defaultProps: Partial<VisualizerPipelineBuilderNestedStackProps> = {
    //stackName: "",
    //env: {},
};

export class VisualizerPipelineBuilderNestedStack extends NestedStack {
    constructor(parent: Construct, name: string, props: VisualizerPipelineBuilderNestedStackProps) {
        super(parent, name);

        props = { ...defaultProps, ...props };

        const visualizerPipelineNetwork = new SecurityGroupGatewayVisualizerPipelineConstruct(
            this,
            "VisualizerPipelineNetwork",
            {
                ...props,
                config: props.config,
                vpc: props.vpc
            }
        );

        const visualizerPipeline = new VisualizationPipelineConstruct(this, "VisualizerPipeline", {
            ...props,
            config: props.config,
            storage: props.storageResources,
            vpc: props.vpc,
            visualizerPipelineSubnets: visualizerPipelineNetwork.subnets.pipeline,
            visualizerPipelineSecurityGroups: [visualizerPipelineNetwork.securityGroups.pipeline],
            lambdaCommonBaseLayer: props.lambdaCommonBaseLayer,
        });
    }
}
