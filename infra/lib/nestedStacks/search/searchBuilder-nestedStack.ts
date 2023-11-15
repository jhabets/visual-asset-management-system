/*
 * Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { storageResources } from "../storage/storageBuilder-nestedStack";
import { buildMetadataIndexingFunction } from "../../lambdaBuilder/metadataFunctions";
import * as eventsources from "aws-cdk-lib/aws-lambda-event-sources";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { LambdaSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import { NagSuppressions } from "cdk-nag";
import { OpensearchServerlessConstruct } from "./constructs/opensearch-serverless";
import { OpensearchProvisionedConstruct } from "./constructs/opensearch-provisioned";
import { Stack, NestedStack } from "aws-cdk-lib";
import { Construct } from "constructs";
import { buildSearchFunction } from "../../lambdaBuilder/searchFunctions";
import { attachFunctionToApi } from "../apiLambda/apiBuilder-nestedStack";
import * as apigwv2 from "@aws-cdk/aws-apigatewayv2-alpha";
import * as cdk from "aws-cdk-lib";
import { LayerVersion } from "aws-cdk-lib/aws-lambda";
import * as Config from "../../../config/config";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { PropagatedTagSource } from "aws-cdk-lib/aws-ecs";

export class SearchBuilderNestedStack extends NestedStack {
    constructor(
        parent: Construct,
        name: string,
        config: Config.Config,
        api: apigwv2.HttpApi,
        storageResources: storageResources,
        lambdaCommonBaseLayer: LayerVersion,
        vpc: ec2.IVpc
    ) {
        super(parent, name);

        searchBuilder(this, config, api, storageResources, lambdaCommonBaseLayer, vpc);
    }
}

export function searchBuilder(
    scope: Construct,
    config: Config.Config,
    api: apigwv2.HttpApi,
    storage: storageResources,
    lambdaCommonBaseLayer: LayerVersion,
    vpc: ec2.IVpc
) {
    const indexName = "assets1236";
    const indexNameParam = "/" + [config.env.coreStackName, "indexName"].join("/");

    if (!config.app.openSearch.useProvisioned.enabled) {
        //Serverless Deployment
        const aoss = new OpensearchServerlessConstruct(scope, "AOSS", {
            config: config,
            principalArn: [],
            indexName: indexName,
            vpc: vpc,
        });

        const indexingFunction = buildMetadataIndexingFunction(
            scope,
            lambdaCommonBaseLayer,
            storage,
            aoss.endpointSSMParameterName(),
            indexNameParam,
            "m",
            config,
            vpc
        );

        const assetIndexingFunction = buildMetadataIndexingFunction(
            scope,
            lambdaCommonBaseLayer,
            storage,
            aoss.endpointSSMParameterName(),
            indexNameParam,
            "a",
            config,
            vpc
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
        aoss.grantVPCeAccess(indexingFunction);
        aoss.grantVPCeAccess(assetIndexingFunction);

        const searchFun = buildSearchFunction(
            scope,
            lambdaCommonBaseLayer,
            aoss.endpointSSMParameterName(),
            indexNameParam,
            storage,
            config,
            vpc
        );
        aoss.grantCollectionAccess(searchFun);
        aoss.grantVPCeAccess(searchFun);

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
    } else {
        //Provisioned Deployment
        const aos = new OpensearchProvisionedConstruct(scope, "AOS", {
            indexName: indexName,
            config: config,
            vpc: vpc,
        });

        const indexingFunction = buildMetadataIndexingFunction(
            scope,
            lambdaCommonBaseLayer,
            storage,
            aos.endpointSSMParameterName(),
            indexNameParam,
            "m",
            config,
            vpc
        );

        const assetIndexingFunction = buildMetadataIndexingFunction(
            scope,
            lambdaCommonBaseLayer,
            storage,
            aos.endpointSSMParameterName(),
            indexNameParam,
            "a",
            config,
            vpc
        );

        aos.grantOSDomainAccess(assetIndexingFunction);
        aos.grantOSDomainAccess(indexingFunction);

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
            config,
            vpc
        );

        aos.grantOSDomainAccess(searchFun);

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
