import * as lambda from "aws-cdk-lib/aws-lambda";
import * as path from "path";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";
import { Duration } from "aws-cdk-lib";
import { suppressCdkNagErrorsByGrantReadWrite } from "../helper/security";
import { LayerVersion } from "aws-cdk-lib/aws-lambda";
import { LAMBDA_PYTHON_RUNTIME } from "../../config/config";
import * as Config from "../../config/config";
import * as ec2 from "aws-cdk-lib/aws-ec2";

export function buildAddCommentLambdaFunction(
    scope: Construct,
    lambdaCommonBaseLayer: LayerVersion,
    commentStorageTable: dynamodb.Table,
    config: Config.Config,
    vpc: ec2.IVpc,
    subnets: ec2.ISubnet[]
): lambda.Function {
    const name = "addComment";
    const addCommentFunction = new lambda.Function(scope, name, {
        code: lambda.Code.fromAsset(path.join(__dirname, `../../../backend/backend`)),
        handler: `handlers.comments.${name}.lambda_handler`,
        runtime: LAMBDA_PYTHON_RUNTIME,
        layers: [lambdaCommonBaseLayer],
        timeout: Duration.minutes(15),
        memorySize: 3008,
        vpc:
            config.app.useGlobalVpc.enabled && config.app.useGlobalVpc.useForAllLambdas
                ? vpc
                : undefined, //Use VPC when flagged to use for all lambdas
        vpcSubnets: config.app.useGlobalVpc.enabled && config.app.useGlobalVpc.useForAllLambdas? {subnets: subnets} : undefined,
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
    commentStorageTable: dynamodb.Table,
    config: Config.Config,
    vpc: ec2.IVpc,
    subnets: ec2.ISubnet[]
): lambda.Function {
    const name = "editComment";
    const editCommentFunction = new lambda.Function(scope, name, {
        code: lambda.Code.fromAsset(path.join(__dirname, `../../../backend/backend`)),
        handler: `handlers.comments.${name}.lambda_handler`,
        runtime: LAMBDA_PYTHON_RUNTIME,
        layers: [lambdaCommonBaseLayer],
        timeout: Duration.minutes(15),
        memorySize: 3008,
        vpc:
            config.app.useGlobalVpc.enabled && config.app.useGlobalVpc.useForAllLambdas
                ? vpc
                : undefined, //Use VPC when flagged to use for all lambdas
        vpcSubnets: config.app.useGlobalVpc.enabled && config.app.useGlobalVpc.useForAllLambdas? {subnets: subnets} : undefined,
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
    assetStorageTable: dynamodb.Table,
    config: Config.Config,
    vpc: ec2.IVpc,
    subnets: ec2.ISubnet[]
): lambda.Function {
    const name = "commentService";
    const commentService = new lambda.Function(scope, name, {
        code: lambda.Code.fromAsset(path.join(__dirname, `../../../backend/backend`)),
        handler: `handlers.comments.${name}.lambda_handler`,
        runtime: LAMBDA_PYTHON_RUNTIME,
        layers: [lambdaCommonBaseLayer],
        timeout: Duration.minutes(15),
        memorySize: 3008,
        vpc:
            config.app.useGlobalVpc.enabled && config.app.useGlobalVpc.useForAllLambdas
                ? vpc
                : undefined, //Use VPC when flagged to use for all lambdas
        vpcSubnets: config.app.useGlobalVpc.enabled && config.app.useGlobalVpc.useForAllLambdas? {subnets: subnets} : undefined,
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
