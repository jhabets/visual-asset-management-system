/* eslint-disable @typescript-eslint/no-unused-vars */
/*
 * Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as cdk from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as cloudTrail from "aws-cdk-lib/aws-cloudtrail";
import { apiBuilder } from "./api-builder";
import { storageResourcesBuilder } from "./storage-builder";
import {
    AmplifyConfigLambdaConstruct,
    AmplifyConfigLambdaConstructProps,
} from "./constructs/amplify-config-lambda-construct";
import { CloudFrontS3WebSiteConstruct } from "./constructs/cloudfront-s3-website-construct";
import { VpcGatewayAlbDeployConstruct } from "./constructs/vpc-gateway-albDeploy-construct";
import { AlbS3WebsiteAlbDeployConstruct } from "./constructs/alb-s3-website-albDeploy-construct";
import {
    CognitoWebNativeConstruct,
    CognitoWebNativeConstructProps,
} from "./constructs/cognito-web-native-construct";
import { ApiGatewayV2CloudFrontConstruct } from "./constructs/apigatewayv2-cloudfront-construct";
import { Construct } from "constructs";
import { NagSuppressions } from "cdk-nag";
import { CustomCognitoConfigConstruct } from "./constructs/custom-cognito-config-construct";
import { CustomFeatureEnabledConfigConstruct } from "./constructs/custom-featureEnabled-config-construct";
import { samlSettings } from "../config/saml-config";
import { LocationServiceConstruct } from "./constructs/location-service-construct";
import { searchBuilder } from "./search-builder";
//import customResources = require('aws-cdk-lib/custom-resources');
import * as Config from '../config/config';
import { LAMBDA_PYTHON_RUNTIME } from '../config/config';
import { VAMS_APP_FEATURES } from '../config/common/vamsAppFeatures';
import { VpcSecurityGroupGatewayVisualizerPipelineConstruct } from "./constructs/vpc-securitygroup-gateway-visualizerPipeline-construct";
import { VisualizationPipelineConstruct } from "./constructs/visualizerPipeline-construct";
import * as pylambda from "@aws-cdk/aws-lambda-python-alpha";


export interface EnvProps {
    env: cdk.Environment;
    stackName: string;
    config: Config.Config;
}

export class CoreVAMSStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: EnvProps) {
        super(scope, id, { ...props, crossRegionReferences: true });


        ///Optional Pipeline Constructs
        //Point Cloud (PC) Visualizer Pipeline
        if (props.config.app.pipelines.usePointCloudVisualization.enabled) {
            const visualizerPipelineNetwork =
                new VpcSecurityGroupGatewayVisualizerPipelineConstruct(
                    this,
                    "VisualizerPipelineNetwork",
                    {
                        ...props,
                        vpcCidrRange: props.config.app.pipelines.usePointCloudVisualization.vpcCidrRange,
                    }
                );

            const visualizerPipeline = new VisualizationPipelineConstruct(
                this,
                "VisualizerPipeline",
                {
                    ...props,
                    storage: storageResources,
                    vpc: visualizerPipelineNetwork.vpc,
                    visualizerPipelineSubnets: visualizerPipelineNetwork.subnets.pipeline,
                    visualizerPipelineSecurityGroups: [
                        visualizerPipelineNetwork.securityGroups.pipeline,
                    ],
                    lambdaCommonBaseLayer
                }
            );
        }

        cdk.Tags.of(this).add("vams:stackname", props.stackName);

        //Add for Systems Manager->Application Manager Cost Tracking for main VAMS Stack
        //TODO: Figure out why tag is not getting added to stack
        cdk.Tags.of(this).add("AppManagerCFNStackKey", this.stackId, {
            includeResourceTypes: ['AWS::CloudFormation::Stack'],
        });

        //Global Nag Supressions
        this.node.findAll().forEach((item) => {
            if (item instanceof cdk.aws_lambda.Function) {
                const fn = item as cdk.aws_lambda.Function;
                // python3.10 suppressed for CDK Bucket Deployment
                // nodejs14.x suppressed for use of custom resource to deploy saml in CustomCognitoConfigConstruct
                if (fn.runtime.name === "python3.10" || fn.runtime.name === "nodejs14.x") {
                    NagSuppressions.addResourceSuppressions(fn, [
                        {
                            id: "AwsSolutions-L1",
                            reason: "The lambda function is configured with the appropriate runtime version",
                        },
                    ]);
                }
                return;
            }
            return;
        });

        NagSuppressions.addResourceSuppressions(
            this,
            [
                {
                    id: "AwsSolutions-IAM4",
                    reason: "Intend to use AWSLambdaBasicExecutionRole as is at this stage of this project.",
                    appliesTo: [
                        {
                            regex: "/.*AWSLambdaBasicExecutionRole$/g",
                        },
                    ],
                },
            ],
            true
        );


    }

}
