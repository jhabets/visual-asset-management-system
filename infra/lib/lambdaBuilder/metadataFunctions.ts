/*
 * Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as lambda from "aws-cdk-lib/aws-lambda";
import * as path from "path";
import { Construct } from "constructs";
import { Duration } from "aws-cdk-lib";
import { storageResources } from "../nestedStacks/storage/storageBuilder-nestedStack";
import * as cdk from "aws-cdk-lib";
import { LayerVersion } from "aws-cdk-lib/aws-lambda";
import { LAMBDA_PYTHON_RUNTIME } from "../../config/config";
import * as Service from "../../lib/helper/service-helper";
import * as Config from "../../config/config";
import * as ec2 from "aws-cdk-lib/aws-ec2";

export function buildMetadataFunctions(
    scope: Construct,
    lambdaCommonBaseLayer: LayerVersion,
    storageResources: storageResources,
    config: Config.Config,
    vpc: ec2.IVpc,
    subnets: ec2.ISubnet[]
): lambda.Function[] {
    return ["create", "read", "update", "delete"].map((f) =>
        buildMetadataFunction(scope, lambdaCommonBaseLayer, storageResources, config, vpc, subnets, f)
    );
}

export function buildMetadataFunction(
    scope: Construct,
    lambdaCommonBaseLayer: LayerVersion,
    storageResources: storageResources,
    config: Config.Config,
    vpc: ec2.IVpc,
    subnets: ec2.ISubnet[],
    name: string
): lambda.Function {
    const fun = new lambda.Function(scope, name + "-metadata", {
        code: lambda.Code.fromAsset(path.join(__dirname, `../../../backend/backend`)),
        handler: `handlers.metadata.${name}.lambda_handler`,
        runtime: LAMBDA_PYTHON_RUNTIME,
        layers: [lambdaCommonBaseLayer],
        timeout: Duration.minutes(15),
        memorySize: 3008,
        vpc:
            config.app.useGlobalVpc.enabled && config.app.useGlobalVpc.useForAllLambdas
                ? vpc
                : undefined, //Use VPC when flagged to use for all lambdas
        vpcSubnets: config.app.useGlobalVpc.enabled && config.app.useGlobalVpc.useForAllLambdas? {subnets: subnets} : undefined,
        environment: {
            METADATA_STORAGE_TABLE_NAME: storageResources.dynamo.metadataStorageTable.tableName,
            ASSET_STORAGE_TABLE_NAME: storageResources.dynamo.assetStorageTable.tableName,
            DATABASE_STORAGE_TABLE_NAME: storageResources.dynamo.databaseStorageTable.tableName,
        },
    });
    storageResources.dynamo.metadataStorageTable.grantReadWriteData(fun);
    storageResources.dynamo.assetStorageTable.grantReadData(fun);
    storageResources.dynamo.databaseStorageTable.grantReadData(fun);
    return fun;
}

export function buildMetadataIndexingFunction(
    scope: Construct,
    lambdaCommonBaseLayer: LayerVersion,
    storageResources: storageResources,
    aosEndpoint: string,
    indexNameParam: string,
    handlerType: "a" | "m",
    config: Config.Config,
    vpc: ec2.IVpc,
    subnets: ec2.ISubnet[]
): lambda.Function {
    const fun = new lambda.Function(scope, "idx" + handlerType, {
        code: lambda.Code.fromAsset(path.join(__dirname, `../../../backend/backend`)),
        handler: `handlers.indexing.streams.lambda_handler_${handlerType}`,
        runtime: LAMBDA_PYTHON_RUNTIME,
        layers: [lambdaCommonBaseLayer],
        timeout: Duration.minutes(15),
        memorySize: 3008,
        vpc:
            config.app.openSearch.useProvisioned.enabled ||
            (config.app.useGlobalVpc.enabled && config.app.useGlobalVpc.useForAllLambdas)
                ? vpc
                : undefined, //Use VPC when provisioned OS or flag to use for all lambdas
        vpcSubnets: config.app.openSearch.useProvisioned.enabled ||
                    (config.app.useGlobalVpc.enabled && config.app.useGlobalVpc.useForAllLambdas)? {subnets: subnets} : undefined,

        environment: {
            METADATA_STORAGE_TABLE_NAME: storageResources.dynamo.metadataStorageTable.tableName,
            ASSET_STORAGE_TABLE_NAME: storageResources.dynamo.assetStorageTable.tableName,
            DATABASE_STORAGE_TABLE_NAME: storageResources.dynamo.databaseStorageTable.tableName,
            ASSET_BUCKET_NAME: storageResources.s3.assetBucket.bucketName,
            AOS_ENDPOINT_PARAM: aosEndpoint,
            AOS_INDEX_NAME_PARAM: indexNameParam,
            AOS_TYPE: config.app.openSearch.useProvisioned.enabled ? "es" : "aoss",
        },
    });

    // add access to read the parameter store param aossEndpoint
    fun.role?.addToPrincipalPolicy(
        new cdk.aws_iam.PolicyStatement({
            actions: ["ssm:GetParameter"],
            resources: [
                `arn:${Service.Partition()}:ssm:${cdk.Stack.of(scope).region}:${
                    cdk.Stack.of(scope).account
                }:parameter/${config.env.coreStackName}/*`,
            ],
        })
    );

    storageResources.dynamo.metadataStorageTable.grantReadWriteData(fun);
    storageResources.dynamo.assetStorageTable.grantReadData(fun);
    storageResources.dynamo.databaseStorageTable.grantReadData(fun);
    storageResources.s3.assetBucket.grantRead(fun);

    // trigger the lambda from the dynamodb db streams
    storageResources.dynamo.metadataStorageTable.grantStreamRead(fun);
    storageResources.dynamo.assetStorageTable.grantStreamRead(fun);

    return fun;
}
