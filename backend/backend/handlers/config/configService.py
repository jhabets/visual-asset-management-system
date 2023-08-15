#  Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#  SPDX-License-Identifier: Apache-2.0

import json
import os
import boto3
from boto3.dynamodb.conditions import Key
from backend.common.validators import validate

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


def lambda_handler(event, context):
    try:
        # Initialize DynamoDB client
        dynamo_client = boto3.client('dynamodb')

        print("Looking up the requested resource")
        assetS3Bucket = os.getenv("ASSET_STORAGE_BUCKET", None)
        appFeatureEnabledDynamoDBTable = os.getenv("APPFEATUREENABLED_STORAGE_TABLE_NAME", None)

        # Specify the column name you want to aggregate
        appFeatureEnableDynamoDB_feature_column_name = 'featureName'
        appFeatureEnableDynamoDB_enabled_column_name = 'enabled'

        # Initialize an empty list to store column values
        appFeatureEnableDynamoDB_column_values = []

        table = dynamo_client.Table(appFeatureEnabledDynamoDBTable)
        record = table.query(
            KeyConditionExpression=Key(appFeatureEnableDynamoDB_enabled_column_name).eq("true")
        )

        # Loop through the query results and fetch the aggregated values
        while 'Items' in record:
            appFeatureEnableDynamoDB_column_values.extend(
                [item[appFeatureEnableDynamoDB_feature_column_name]['S'] for item in response['Items']])

        # Create a concatenated string from the column values
        appFeatureEnabledconcatenated_string = ','.join(appFeatureEnableDynamoDB_column_values)

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
