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
import { LayerVersion } from 'aws-cdk-lib/aws-lambda';
import { LAMBDA_PYTHON_RUNTIME } from '../../config/config';
import * as Service from '../../lib/helper/service-helper';

export function buildSearchFunction(
    scope: Construct,
    lambdaCommonBaseLayer: LayerVersion,
    aosEndpoint: string,
    indexNameParam: string,
    storageResources: storageResources,
    useProvisioned: boolean
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
            AOS_ENDPOINT_PARAM: aosEndpoint,
            AOS_INDEX_NAME_PARAM: indexNameParam,
            AOS_TYPE: useProvisioned? "es" : "aoss",
            AUTH_ENTITIES_TABLE: storageResources.dynamo.authEntitiesStorageTable.tableName,
            DATABASE_STORAGE_TABLE_NAME: storageResources.dynamo.databaseStorageTable.tableName,
        },
    });

    // add access to read the parameter store param aosEndpoint
    fun.role?.addToPrincipalPolicy(
        new cdk.aws_iam.PolicyStatement({
            actions: ["ssm:GetParameter"],
            resources: [
                `arn:${Service.Partition()}:ssm:${cdk.Stack.of(scope).region}:${
                    cdk.Stack.of(scope).account
                }:parameter/${cdk.Stack.of(scope).stackName}/*`,
            ],
        })
    );

    storageResources.dynamo.authEntitiesStorageTable.grantReadData(fun);
    storageResources.dynamo.databaseStorageTable.grantReadData(fun);

    return fun;
}
