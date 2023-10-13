/*
 * Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as lambda from "aws-cdk-lib/aws-lambda";
import * as path from "path";
import { Construct } from "constructs";
import { Duration } from "aws-cdk-lib";
import { OpensearchServerlessConstruct } from "../constructs/opensearch-serverless";
import { storageResources } from "../storage-builder";
import * as cdk from "aws-cdk-lib";
import { LayerVersion } from 'aws-cdk-lib/aws-lambda';
import { LAMBDA_PYTHON_RUNTIME } from '../../config/config';

export function buildSearchFunction(
    scope: Construct,
    lambdaCommonBaseLayer: LayerVersion,
    aossEndpoint: string,
    indexNameParam: string,
    aossConstruct: OpensearchServerlessConstruct,
    storageResources: storageResources
): lambda.Function {
    const name = "search";
    const fun = new lambda.Function(scope, name, {
        code: lambda.Code.fromAsset(path.join(__dirname, `../../../backend/backend`)),
        handler: `handlers.search.${name}.lambda_handler`,
        runtime: LAMBDA_PYTHON_RUNTIME,
        layers: [lambdaCommonBaseLayer],
        timeout: Duration.minutes(15),
        memorySize: 3008,
        environment: {
            AOSS_ENDPOINT_PARAM: aossEndpoint,
            AOSS_INDEX_NAME_PARAM: indexNameParam,
            AUTH_ENTITIES_TABLE: storageResources.dynamo.authEntitiesStorageTable.tableName,
            DATABASE_STORAGE_TABLE_NAME: storageResources.dynamo.databaseStorageTable.tableName,
        },
    });

    // add access to read the parameter store param aossEndpoint
    fun.role?.addToPrincipalPolicy(
        new cdk.aws_iam.PolicyStatement({
            actions: ["ssm:GetParameter"],
            resources: [
                `arn:aws:ssm:${cdk.Stack.of(scope).region}:${
                    cdk.Stack.of(scope).account
                }:parameter/${cdk.Stack.of(scope).stackName}/*`,
            ],
        })
    );

    storageResources.dynamo.authEntitiesStorageTable.grantReadData(fun);
    storageResources.dynamo.databaseStorageTable.grantReadData(fun);
    aossConstruct.grantCollectionAccess(fun);

    return fun;
}
