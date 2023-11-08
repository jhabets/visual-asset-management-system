/* eslint-disable @typescript-eslint/no-unused-vars */
/*
 * Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { Construct } from "constructs";
import { Names } from "aws-cdk-lib";
import { LayerVersion } from "aws-cdk-lib/aws-lambda";
import * as cdk from "aws-cdk-lib";
import { NestedStack } from "aws-cdk-lib";
import { LAMBDA_PYTHON_RUNTIME } from "../../../config/config";
import * as pylambda from "@aws-cdk/aws-lambda-python-alpha";

export type LambdaLayersBuilderNestedStackProps = cdk.StackProps;

/**
 * Default input properties
 */
const defaultProps: Partial<LambdaLayersBuilderNestedStackProps> = {
    //stackName: "",
    //env: {},
};

export class LambdaLayersBuilderNestedStack extends NestedStack {
    public lambdaCommonBaseLayer: pylambda.PythonLayerVersion;
    public lambdaCommonServiceSDKLayer: pylambda.PythonLayerVersion;

    constructor(parent: Construct, name: string, props: LambdaLayersBuilderNestedStackProps) {
        super(parent, name);

        props = { ...defaultProps, ...props };

        //Todo: Implement post-local bundling command execution to reduce and remove unwatnted lambda layer library files (*boto*, __pycache__, tests)

        //Deploy Common Base Lambda Layer
        this.lambdaCommonBaseLayer = new pylambda.PythonLayerVersion(this, "VAMSLayerBase", {
            layerVersionName: "vams_layer_base",
            entry: "../backend/lambdaLayers/base",
            compatibleRuntimes: [LAMBDA_PYTHON_RUNTIME],
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            bundling: {},
        });

        //Deploy Common Service SDK Lambda Layer
        this.lambdaCommonServiceSDKLayer = new pylambda.PythonLayerVersion(
            this,
            "VAMSLayerServiceSDK",
            {
                layerVersionName: "vams_layer_servicesdk",
                entry: "../backend/lambdaLayers/serviceSDK",
                compatibleRuntimes: [LAMBDA_PYTHON_RUNTIME],
                removalPolicy: cdk.RemovalPolicy.DESTROY,
                bundling: {},
            }
        );
    }

    afterBundling(inputDir: string, outputDir: string): string[] {
        return [
            `cd ${outputDir} && find . -type d -name __pycache__ -prune -exec rm -rf {} \; && find . -type d -name tests -prune -exec rm -rf {} \; && find . -type d -name *boto* -prune -exec rm -rf {} \;`,
        ];
    }
}
