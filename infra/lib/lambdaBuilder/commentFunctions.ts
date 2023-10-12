import * as lambda from "aws-cdk-lib/aws-lambda";
import * as path from "path";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";
import { Duration } from "aws-cdk-lib";
import { suppressCdkNagErrorsByGrantReadWrite } from "../security";
import { LayerVersion } from 'aws-cdk-lib/aws-lambda';

export function buildAddCommentLambdaFunction(
    scope: Construct,
    lambdaCommonBaseLayer: LayerVersion,
    commentStorageTable: dynamodb.Table
): lambda.Function {
    const name = "addComment";
    const addCommentFunction = new lambda.Function(scope, name, {
        code: lambda.Code.fromAsset(path.join(__dirname, `../../../backend/backend`)),
        handler: `handlers.comments.${name}.lambda_handler`,
        runtime: lambda.Runtime.PYTHON_3_10,
        layers: [lambdaCommonBaseLayer],
        timeout: Duration.minutes(15),
        memorySize: 3008,
        environment: {
            COMMENT_STORAGE_TABLE_NAME: commentStorageTable.tableName,
        },
    });
    commentStorageTable.grantReadWriteData(addCommentFunction);
    return addCommentFunction;
}

export function buildEditCommentLambdaFunction(
    scope: Construct,
    lambdaCommonBaseLayer: LayerVersion,
    commentStorageTable: dynamodb.Table
): lambda.Function {
    const name = "editComment";
    const editCommentFunction = new lambda.Function(scope, name, {
        code: lambda.Code.fromAsset(path.join(__dirname, `../../../backend/backend`)),
        handler: `handlers.comments.${name}.lambda_handler`,
        runtime: lambda.Runtime.PYTHON_3_10,
        layers: [lambdaCommonBaseLayer],
        timeout: Duration.minutes(15),
        memorySize: 3008,
        environment: {
            COMMENT_STORAGE_TABLE_NAME: commentStorageTable.tableName,
        },
    });
    commentStorageTable.grantReadWriteData(editCommentFunction);
    return editCommentFunction;
}

export function buildCommentService(
    scope: Construct,
    lambdaCommonBaseLayer: LayerVersion,
    commentStorageTable: dynamodb.Table,
    assetStorageTable: dynamodb.Table
): lambda.Function {
    const name = "commentService";
    const commentService = new lambda.Function(scope, name, {
        code: lambda.Code.fromAsset(path.join(__dirname, `../../../backend/backend`)),
        handler: `handlers.comments.${name}.lambda_handler`,
        runtime: lambda.Runtime.PYTHON_3_10,
        layers: [lambdaCommonBaseLayer],
        timeout: Duration.minutes(15),
        memorySize: 3008,
        environment: {
            COMMENT_STORAGE_TABLE_NAME: commentStorageTable.tableName,
            ASSET_STORAGE_TABLE_NAME: assetStorageTable.tableName,
        },
    });
    assetStorageTable.grantReadWriteData(commentService);
    commentStorageTable.grantReadWriteData(commentService);

    suppressCdkNagErrorsByGrantReadWrite(scope);

    return commentService;
}
