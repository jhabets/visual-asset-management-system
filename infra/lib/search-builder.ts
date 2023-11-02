/*
 * Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { storageResources } from "./storage-builder";
import { buildMetadataIndexingFunction } from "./lambdaBuilder/metadataFunctions";
import * as eventsources from "aws-cdk-lib/aws-lambda-event-sources";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { LambdaSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import { NagSuppressions } from "cdk-nag";
import { OpensearchServerlessConstruct } from "./constructs/opensearch-serverless";
import { OpensearchProvisionedConstruct } from "./constructs/opensearch-provisioned";
import { Stack } from "aws-cdk-lib";
import { buildSearchFunction } from "./lambdaBuilder/searchFunctions";
import { attachFunctionToApi } from "./api-builder";
import * as apigwv2 from "@aws-cdk/aws-apigatewayv2-alpha";
import * as cdk from "aws-cdk-lib";
import { LayerVersion} from 'aws-cdk-lib/aws-lambda';

export function searchBuilder(
    scope: Stack,
    api: apigwv2.HttpApi,
    storage: storageResources,
    lambdaCommonBaseLayer: LayerVersion,
    useProvisioned: boolean
) {
    
    const indexName = "assets1236"
    const indexNameParam = "/" + [cdk.Stack.of(scope).stackName, "indexName"].join("/");


    if(!useProvisioned) {
        //Serverless Deployment
        const aoss = new OpensearchServerlessConstruct(scope, "AOSS", {
            principalArn: [],
            indexName: indexName
        });


        const indexingFunction = buildMetadataIndexingFunction(
            scope,
            lambdaCommonBaseLayer,
            storage,
            aoss.endpointSSMParameterName(),
            indexNameParam,
            "m",
            useProvisioned
        );
    
        const assetIndexingFunction = buildMetadataIndexingFunction(
            scope,
            lambdaCommonBaseLayer,
            storage,
            aoss.endpointSSMParameterName(),
            indexNameParam,
            "a",
            useProvisioned
        );
    
        //Add subscriptions to kick-off lambda function for indexing
        storage.sns.assetBucketObjectCreatedTopic.addSubscription(
            new LambdaSubscription(indexingFunction)
        );
    
        storage.sns.assetBucketObjectRemovedTopic.addSubscription(
            new LambdaSubscription(indexingFunction)
        );
    
        indexingFunction.addEventSource(
            new eventsources.DynamoEventSource(storage.dynamo.metadataStorageTable, {
                startingPosition: lambda.StartingPosition.TRIM_HORIZON,
            })
        );
        assetIndexingFunction.addEventSource(
            new eventsources.DynamoEventSource(storage.dynamo.assetStorageTable, {
                startingPosition: lambda.StartingPosition.TRIM_HORIZON,
            })
        );
    
        aoss.grantCollectionAccess(indexingFunction);
        aoss.grantCollectionAccess(assetIndexingFunction);
    
        const searchFun = buildSearchFunction(
            scope,
            lambdaCommonBaseLayer,
            aoss.endpointSSMParameterName(),
            indexNameParam,
            storage,
            useProvisioned
        );
        aoss.grantCollectionAccess(searchFun);

        attachFunctionToApi(scope, searchFun, {
            routePath: "/search",
            method: apigwv2.HttpMethod.POST,
            api: api,
        });
        attachFunctionToApi(scope, searchFun, {
            routePath: "/search",
            method: apigwv2.HttpMethod.GET,
            api: api,
        });

        NagSuppressions.addResourceSuppressionsByPath(
            scope,
            `/${scope.stackName}/AOSS/OpensearchServerlessDeploySchemaProvider/framework-onEvent/Resource`,
            [
                {
                    id: "AwsSolutions-L1",
                    reason: "Configured as intended.",
                },
            ]
        );

    }
    else {
        //Provisioned Deployment
        const aos = new OpensearchProvisionedConstruct(scope, "AOS", {
            indexName: indexName
        });


        const indexingFunction = buildMetadataIndexingFunction(
            scope,
            lambdaCommonBaseLayer,
            storage,
            aos.endpointSSMParameterName(),
            indexNameParam,
            "m",
            useProvisioned
        );
    
        const assetIndexingFunction = buildMetadataIndexingFunction(
            scope,
            lambdaCommonBaseLayer,
            storage,
            aos.endpointSSMParameterName(),
            indexNameParam,
            "a",
            useProvisioned
        );

        aos.grantDomainAccess(assetIndexingFunction);
        aos.grantDomainAccess(indexingFunction);
    
        //Add subscriptions to kick-off lambda function for indexing
        storage.sns.assetBucketObjectCreatedTopic.addSubscription(
            new LambdaSubscription(indexingFunction)
        );
    
        storage.sns.assetBucketObjectRemovedTopic.addSubscription(
            new LambdaSubscription(indexingFunction)
        );
    
        indexingFunction.addEventSource(
            new eventsources.DynamoEventSource(storage.dynamo.metadataStorageTable, {
                startingPosition: lambda.StartingPosition.TRIM_HORIZON,
            })
        );
        assetIndexingFunction.addEventSource(
            new eventsources.DynamoEventSource(storage.dynamo.assetStorageTable, {
                startingPosition: lambda.StartingPosition.TRIM_HORIZON,
            })
        );

        const searchFun = buildSearchFunction(
            scope,
            lambdaCommonBaseLayer,
            aos.endpointSSMParameterName(),
            indexNameParam,
            storage,
            useProvisioned
        );

        aos.grantDomainAccess(searchFun)

        attachFunctionToApi(scope, searchFun, {
            routePath: "/search",
            method: apigwv2.HttpMethod.POST,
            api: api,
        });
        attachFunctionToApi(scope, searchFun, {
            routePath: "/search",
            method: apigwv2.HttpMethod.GET,
            api: api,
        });

        NagSuppressions.addResourceSuppressionsByPath(
            scope,
            `/${scope.stackName}/AOS/OpensearchProvisionedDeploySchemaProvider/framework-onEvent/Resource`,
            [
                {
                    id: "AwsSolutions-L1",
                    reason: "Configured as intended.",
                },
            ]
        );
    }

    NagSuppressions.addResourceSuppressions(
        scope,
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

    NagSuppressions.addResourceSuppressions(scope, [
        {
            id: "AwsSolutions-L1",
            reason: "Configured as intended.",
        },
    ]);

    NagSuppressions.addResourceSuppressions(
        scope,
        [
            {
                id: "AwsSolutions-IAM5",
                reason: "Configured as intended.",
                appliesTo: [
                    {
                        regex: "/.*$/g",
                    },
                ],
            },
        ],
        true
    );
}
