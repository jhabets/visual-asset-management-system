/*
 * Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import * as path from "path";
import { Construct } from "constructs";
import { Duration } from "aws-cdk-lib";
import { storageResources } from "../nestedStacks/storage/storageBuilder-nestedStack";
import { LayerVersion } from "aws-cdk-lib/aws-lambda";
import { LAMBDA_PYTHON_RUNTIME } from "../../config/config";
import * as ServiceHelper from "../../lib/helper/service-helper";
import { Service } from "../helper/service-helper";

interface AuthFunctions {
    groups: lambda.Function;
    constraints: lambda.Function;
    scopeds3access: lambda.Function;
}

export function buildAuthFunctions(
    scope: Construct,
    lambdaCommonBaseLayer: LayerVersion,
    storageResources: storageResources
): AuthFunctions {
    const storageBucketRole = new iam.Role(scope, "storageBucketRole", {
        assumedBy: Service("LAMBDA").Principal, 
    });

    storageResources.s3.assetBucket.grantReadWrite(storageBucketRole);

    const scopeds3access = buildAuthFunction(
        scope,
        lambdaCommonBaseLayer,
        storageResources,
        "scopeds3access",
        {
            AWS_PARTITION: ServiceHelper.Partition(),
            ROLE_ARN: storageBucketRole.roleArn,
            S3_BUCKET: storageResources.s3.assetBucket.bucketName,
        }
    );

    storageBucketRole.assumeRolePolicy?.addStatements(
        new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["sts:AssumeRole"],
            principals: [scopeds3access.role!],
        })
    );

    return {
        groups: buildAuthFunction(scope, lambdaCommonBaseLayer, storageResources, "groups"),
        constraints: buildAuthFunction(
            scope,
            lambdaCommonBaseLayer,
            storageResources,
            "finegrainedaccessconstraints"
        ),
        scopeds3access,
    };
}

export function buildAuthFunction(
    scope: Construct,
    lambdaCommonBaseLayer: LayerVersion,
    storageResources: storageResources,
    name: string,
    environment?: { [key: string]: string }
): lambda.Function {
    const fun = new lambda.Function(scope, name, {
        code: lambda.Code.fromAsset(path.join(__dirname, `../../../backend/backend`)),
        handler: `handlers.auth.${name}.lambda_handler`,
        runtime: LAMBDA_PYTHON_RUNTIME,
        layers: [lambdaCommonBaseLayer],
        timeout: Duration.minutes(1),
        memorySize: 512,
        environment: {
            TABLE_NAME: storageResources.dynamo.authEntitiesStorageTable.tableName,
            ASSET_STORAGE_TABLE_NAME: storageResources.dynamo.assetStorageTable.tableName,
            DATABASE_STORAGE_TABLE_NAME: storageResources.dynamo.databaseStorageTable.tableName,
            ...environment,
        },
    });
    storageResources.dynamo.authEntitiesStorageTable.grantReadWriteData(fun);
    storageResources.dynamo.assetStorageTable.grantReadData(fun);
    storageResources.dynamo.databaseStorageTable.grantReadData(fun);
    return fun;
}
