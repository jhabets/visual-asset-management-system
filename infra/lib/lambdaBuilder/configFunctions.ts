/*
 * Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as path from "path";
import { Construct } from "constructs";
import { Duration } from "aws-cdk-lib";
import { LayerVersion } from "aws-cdk-lib/aws-lambda";
import { LAMBDA_PYTHON_RUNTIME } from "../../config/config";

export function buildConfigService(
    scope: Construct,
    lambdaCommonBaseLayer: LayerVersion,
    assetStorageBucket: s3.Bucket,
    appFeatureEnabledStorageTable: dynamodb.Table
): lambda.Function {
    const name = "configService";
    const configService = new lambda.Function(scope, name, {
        code: lambda.Code.fromAsset(path.join(__dirname, `../../../backend/backend`)),
        handler: `handlers.config.${name}.lambda_handler`,
        runtime: LAMBDA_PYTHON_RUNTIME,
        layers: [lambdaCommonBaseLayer],
        timeout: Duration.minutes(15),
        memorySize: 3008,
        environment: {
            ASSET_STORAGE_BUCKET: assetStorageBucket.bucketName,
            APPFEATUREENABLED_STORAGE_TABLE_NAME: appFeatureEnabledStorageTable.tableName,
        },
    });

    appFeatureEnabledStorageTable.grantReadData(configService);
    return configService;
}
