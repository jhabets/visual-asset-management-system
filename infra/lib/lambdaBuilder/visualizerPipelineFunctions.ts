/*
 * Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as lambda from "aws-cdk-lib/aws-lambda";
import * as path from "path";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as sns from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";
import { Duration } from "aws-cdk-lib";
import { LayerVersion } from "aws-cdk-lib/aws-lambda";
import { LAMBDA_PYTHON_RUNTIME } from "../../config/config";
import * as Config from "../../config/config";

export function buildExecuteVisualizerPCPipelineFunction(
    scope: Construct,
    lambdaCommonBaseLayer: LayerVersion,
    assetBucket: s3.Bucket,
    assetVisualizerBucket: s3.Bucket,
    pipelineSNSTopic: sns.Topic,
    config: Config.Config,
    vpc: ec2.IVpc,
    subnets: ec2.ISubnet[]
): lambda.Function {
    const name = "executeVisualizerPCPipeline";
    const fun = new lambda.Function(scope, name, {
        code: lambda.Code.fromAsset(path.join(__dirname, `../../../backend/backend`)),
        handler: `handlers.visualizerpipelines.${name}.lambda_handler`,
        runtime: LAMBDA_PYTHON_RUNTIME,
        layers: [lambdaCommonBaseLayer],
        timeout: Duration.minutes(5),
        memorySize: 256,
        vpc:
            config.app.useGlobalVpc.enabled && config.app.useGlobalVpc.useForAllLambdas
                ? vpc
                : undefined, //Use VPC when flagged to use for all lambdas
        vpcSubnets:
            config.app.useGlobalVpc.enabled && config.app.useGlobalVpc.useForAllLambdas
                ? { subnets: subnets }
                : undefined,
        environment: {
            DEST_BUCKET_NAME: assetVisualizerBucket.bucketName,
            SNS_VISUALIZER_PIPELINE_PC_TOPICARN: pipelineSNSTopic.topicArn,
        },
    });

    assetBucket.grantRead(fun);
    assetVisualizerBucket.grantRead(fun);
    pipelineSNSTopic.grantPublish(fun);

    return fun;
}

export function buildOpenPipelineFunction(
    scope: Construct,
    lambdaCommonBaseLayer: LayerVersion,
    assetBucket: s3.Bucket,
    assetVisualizerBucket: s3.Bucket,
    pipelineStateMachine: sfn.StateMachine,
    allowedPipelineInputExtensions: string,
    vpc: ec2.IVpc,
    subnets: ec2.ISubnet[]
): lambda.Function {
    const name = "openPipeline";
    const vpcSubnets = vpc.selectSubnets({
        subnets: subnets,
    });

    const fun = new lambda.Function(scope, name, {
        code: lambda.Code.fromAsset(path.join(__dirname, `../../../backend/backend`)),
        handler: `handlers.visualizerpipelines.${name}.lambda_handler`,
        runtime: LAMBDA_PYTHON_RUNTIME,
        layers: [lambdaCommonBaseLayer],
        timeout: Duration.minutes(5),
        memorySize: 256,
        vpc: vpc, //open pipeline always in VPC
        vpcSubnets: vpcSubnets,
        environment: {
            SOURCE_BUCKET_NAME: assetBucket.bucketName,
            DEST_BUCKET_NAME: assetVisualizerBucket.bucketName,
            STATE_MACHINE_ARN: pipelineStateMachine.stateMachineArn,
            ALLOWED_INPUT_FILEEXTENSIONS: allowedPipelineInputExtensions,
        },
    });

    assetBucket.grantRead(fun);
    assetVisualizerBucket.grantRead(fun);
    pipelineStateMachine.grantStartExecution(fun);

    return fun;
}

export function buildConstructPipelineFunction(
    scope: Construct,
    lambdaCommonBaseLayer: LayerVersion,
    vpc: ec2.IVpc,
    subnets: ec2.ISubnet[],
    pipelineSecurityGroups: ec2.ISecurityGroup[]
): lambda.Function {
    const name = "constructPipeline";
    const vpcSubnets = vpc.selectSubnets({
        subnets: subnets,
    });

    const fun = new lambda.Function(scope, name, {
        code: lambda.Code.fromAsset(path.join(__dirname, `../../../backend/backend`)),
        handler: `handlers.visualizerpipelines.${name}.lambda_handler`,
        runtime: LAMBDA_PYTHON_RUNTIME,
        layers: [lambdaCommonBaseLayer],
        timeout: Duration.minutes(5),
        memorySize: 128,
        vpc: vpc, //construct pipeline always in VPC
        vpcSubnets: vpcSubnets,
        securityGroups: pipelineSecurityGroups,
    });

    return fun;
}

export function buildPipelineEndFunction(
    scope: Construct,
    lambdaCommonBaseLayer: LayerVersion,
    assetBucket: s3.Bucket,
    assetVisualizerBucket: s3.Bucket,
    vpc: ec2.IVpc,
    subnets: ec2.ISubnet[],
    pipelineSecurityGroups: ec2.ISecurityGroup[]
): lambda.Function {
    const name = "pipelineEnd";
    const vpcSubnets = vpc.selectSubnets({
        subnets: subnets,
    });

    const fun = new lambda.Function(scope, name, {
        code: lambda.Code.fromAsset(path.join(__dirname, `../../../backend/backend`)),
        handler: `handlers.visualizerpipelines.${name}.lambda_handler`,
        runtime: LAMBDA_PYTHON_RUNTIME,
        layers: [lambdaCommonBaseLayer],
        timeout: Duration.minutes(5),
        memorySize: 256,
        vpc: vpc, //Pipeline end always in VPC
        vpcSubnets: vpcSubnets,
        securityGroups: pipelineSecurityGroups,
        environment: {
            SOURCE_BUCKET_NAME: assetBucket.bucketName,
            DEST_BUCKET_NAME: assetVisualizerBucket.bucketName,
        },
    });

    assetBucket.grantRead(fun);
    assetVisualizerBucket.grantRead(fun);

    return fun;
}
