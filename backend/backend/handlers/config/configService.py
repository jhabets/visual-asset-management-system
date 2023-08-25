#  Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#  SPDX-License-Identifier: Apache-2.0

import json
import os
import boto3
from boto3.dynamodb.conditions import Key
from backend.common.validators import validate
from boto3.dynamodb.types import TypeDeserializer

response = {
    'statusCode': 200,
    'body': '',
    'headers': {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Credentials': True,
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Allow-Methods': 'OPTIONS,POST,GET'
    }
}

dynamo_client = boto3.client('dynamodb')
deserializer = TypeDeserializer()


def lambda_handler(event, context):
    try:
        print("Looking up the requested resource")
        assetS3Bucket = os.getenv("ASSET_STORAGE_BUCKET", None)
        appFeatureEnabledDynamoDBTable = os.getenv("APPFEATUREENABLED_STORAGE_TABLE_NAME", None)

        # Specify the column name you want to aggregate
        appFeatureEnableDynamoDB_feature_column_name = 'featureName'

        # Initialize an empty list to store column values
        appFeatureEnableDynamoDB_column_values = []

        paginator = dynamo_client.get_paginator('scan')
        pageIterator = paginator.paginate(
            TableName=appFeatureEnabledDynamoDBTable,
            PaginationConfig={
                'MaxItems': 100,
                'PageSize': 100,
                'StartingToken': None
            }
        ).build_full_result()

        print("Fetching results")
        result = {}
        items = []
        for item in pageIterator['Items']:
            deserialized_document = {
                k: deserializer.deserialize(v) for k, v in item.items()}
            items.append(deserialized_document)
        result['Items'] = items

        if 'NextToken' in pageIterator:
            result['NextToken'] = pageIterator['NextToken']
        # print(result)

        for item in items:
            appFeatureEnableDynamoDB_column_values.append(
                item[appFeatureEnableDynamoDB_feature_column_name])

        print(appFeatureEnableDynamoDB_column_values)

        # Create a concatenated string from the column values
        appFeatureEnabledconcatenated_string = ','.join(
            appFeatureEnableDynamoDB_column_values)

        response = {
            "bucket": assetS3Bucket,
            "featuresEnabled": appFeatureEnabledconcatenated_string,
        }
        print("Success")
        return {
            "statusCode": "200",
            "body": json.dumps(response),
            "headers": {
                "Content-Type": "application/json",
            },
        }
    except Exception as e:
        response['statusCode'] = 500
        print("Error!", e.__class__, "occurred.")
        try:
            print(e)
            response['body'] = json.dumps({"message": str(e)})
        except:
            print("Can't Read Error")
            response['body'] = json.dumps({"message": "An unexpected error occurred while executing the request"})
        return response
