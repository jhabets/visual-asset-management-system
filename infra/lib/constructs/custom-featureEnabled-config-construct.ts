/*
 * Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import {RetentionDays} from "aws-cdk-lib/aws-logs";
import {AwsCustomResource, AwsCustomResourcePolicy, AwsSdkCall, PhysicalResourceId} from "aws-cdk-lib/custom-resources";
import {Effect, PolicyStatement} from "aws-cdk-lib/aws-iam";
import { Duration } from "aws-cdk-lib";
import { Construct } from "constructs";


/* eslint-disable @typescript-eslint/no-empty-interface */
export interface CustomFeatureEnabledConfigConstructProps {
    appFeatureEnabledTable: dynamodb.Table;
    featuresEnabled: string[];
}

interface RequestItem {
    [key: string]: any[]
  }

  interface DynamoInsert {
    RequestItems: RequestItem
  }

  interface IAppFeatureEnabled {
    enabled: { S: string };
    featureName: { S: string };
  }

const defaultProps: Partial<CustomFeatureEnabledConfigConstructProps> = {};

/**
 * Custom configuration for VAMS App Features Enabled.
 */
export class CustomFeatureEnabledConfigConstruct extends Construct {

    constructor(parent: Construct, name: string, props: CustomFeatureEnabledConfigConstructProps) {
        super(parent, name);

        props = { ...defaultProps, ...props };

        /**
         * Use the AWS SDK to add records to dynamoDB "App Features Enabled", e.g.
         *
         * @type {AwsCustomResource}
         *
         * @see https://docs.aws.amazon.com/cdk/api/latest/docs/@aws-cdk_custom-resources.AwsCustomResource.html
         */
        
        const appFeatureItems: any[] = []
        props.featuresEnabled.forEach(feature => appFeatureItems.push({
            enabled: {S:"true"},
            featureName: {S:feature},
        }));

        this.insertMultipleRecord(props.appFeatureEnabledTable,
            appFeatureItems)
    }

    //Note: Allows for 25 items to be written as part of BatchWriteItem. If more needed, batch over many different AwsCustomResource
    //Third Party Blog: https://dev.to/elthrasher/exploring-aws-cdk-loading-dynamodb-with-custom-resources-jlf, 
    // https://kevin-van-ingen.medium.com/aws-cdk-custom-resources-for-dynamodb-inserts-2d79cb1ae395
    private insertMultipleRecord(appFeatureEnabledTable: dynamodb.Table, items: any[]) {
        //const records = this.constructBatchInsertObject(items, tableName);

        const awsSdkCall: AwsSdkCall = {
            service: 'DynamoDB',
            action: 'batchWriteItem',
            physicalResourceId: PhysicalResourceId.of(Date.now().toString()),
            //parameters: records
            parameters: {
                RequestItems: {
                  [appFeatureEnabledTable.tableName]: this.constructBatchInsertObject(items),
                },
            },
        }

        const customResource: AwsCustomResource = new AwsCustomResource(this, "appFeatureEnabled_tablePopulate_custom_resource", {
                onCreate: awsSdkCall,
                onUpdate: awsSdkCall,
                installLatestAwsSdk: false,
                policy: AwsCustomResourcePolicy.fromStatements([
                    new PolicyStatement({
                    sid: 'DynamoWriteAccess',
                    effect: Effect.ALLOW,
                    actions: ['dynamodb:BatchWriteItem'],
                    resources: [appFeatureEnabledTable.tableName],
                    })
                ]),
                timeout: Duration.minutes(5)
            }
        );

        customResource.node.addDependency(appFeatureEnabledTable);
    }

    // private constructBatchInsertObject(items: any[], tableName: string) {
    //     const itemsAsDynamoPutRequest: any[] = [];
    //     items.forEach(item => itemsAsDynamoPutRequest.push({
    //     PutRequest: {
    //         Item: item
    //     }
    //     }));
    //     const records: DynamoInsert =
    //         {
    //         RequestItems: {}
    //         };
    //     records.RequestItems[tableName] = itemsAsDynamoPutRequest;
    //     return records;
    // }

    private constructBatchInsertObject(items: any[]) {
        const itemsAsDynamoPutRequest: any[] = [];
        items.forEach(item => itemsAsDynamoPutRequest.push({
        PutRequest: {
            Item: item
        }
        }));
        return itemsAsDynamoPutRequest;
    }

}
