/* eslint-disable @typescript-eslint/no-unused-vars */
/*
 * Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { Construct } from "constructs";
import { Names } from "aws-cdk-lib";
import { storageResources } from "../storage/storageBuilder-nestedStack";
import { LayerVersion} from 'aws-cdk-lib/aws-lambda';
import * as cdk from "aws-cdk-lib";
import { NestedStack } from 'aws-cdk-lib';
import { VpcSecurityGroupGatewayVisualizerPipelineConstruct } from "./constructs/vpc-securitygroup-gateway-visualizerPipeline-construct";
import { VisualizationPipelineConstruct } from "./constructs/visualizerPipeline-construct";

export interface VisualizerPipelineBuilderNestedStackProps extends cdk.StackProps {
    storageResources: storageResources;
    lambdaCommonBaseLayer: LayerVersion;
    optionalVPCID: string;
    vpcCidrRange: string;
}

/**
 * Default input properties
 */
const defaultProps: Partial<VisualizerPipelineBuilderNestedStackProps> = {
    stackName: "",
    env: {},
};

export class VisualizerPipelineBuilderNestedStack extends NestedStack {
    constructor(parent: Construct, name: string, props: VisualizerPipelineBuilderNestedStackProps) {
        super(parent, name);

        props = { ...defaultProps, ...props };

        const visualizerPipelineNetwork =
            new VpcSecurityGroupGatewayVisualizerPipelineConstruct(
                this,
                "VisualizerPipelineNetwork",
                {
                    ...props,
                    optionalExistingVPCId: props.optionalVPCID,
                    vpcCidrRange: props.vpcCidrRange,
                }
            );

        const visualizerPipeline = new VisualizationPipelineConstruct(
            this,
            "VisualizerPipeline",
            {
                ...props,
                storage: props.storageResources,
                vpc: visualizerPipelineNetwork.vpc,
                visualizerPipelineSubnets: visualizerPipelineNetwork.subnets.pipeline,
                visualizerPipelineSecurityGroups: [
                    visualizerPipelineNetwork.securityGroups.pipeline,
                ],
                lambdaCommonBaseLayer: props.lambdaCommonBaseLayer
            }
        );
    }
  }