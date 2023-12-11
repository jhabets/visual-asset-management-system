/*
 * Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as lambda from "aws-cdk-lib/aws-lambda";
import * as path from "path";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { Duration } from "aws-cdk-lib";
import { suppressCdkNagErrorsByGrantReadWrite } from "../helper/security";
import { storageResources } from "../nestedStacks/storage/storageBuilder-nestedStack";
import { IAMArn, Service } from "../helper/service-helper";
import { LayerVersion } from "aws-cdk-lib/aws-lambda";
import { LAMBDA_PYTHON_RUNTIME } from "../../config/config";
import * as Config from "../../config/config";
import * as ec2 from "aws-cdk-lib/aws-ec2";

export function buildCreatePipelineFunction(
    scope: Construct,
    lambdaCommonBaseLayer: LayerVersion,
    pipelineStorageTable: dynamodb.Table,
    artefactsBucket: s3.Bucket,
    sagemakerBucket: s3.Bucket,
    assetBucket: s3.Bucket,
    enablePipelineFunction: lambda.Function,
    config: Config.Config,
    vpc: ec2.IVpc,
    subnets: ec2.ISubnet[]
): lambda.Function {
    const name = "createPipeline";
    const newPipelineLambdaRole = createRoleToAttachToLambdaPipelines(scope, assetBucket);
    const newPipelineSubnetIds = buildPipelineLambdaSubnetIds(scope, subnets, config);
    const newPipelineLambdaSecurityGroup = buildPipelineLambdaSecurityGroup(scope, vpc, config);
    const createPipelineFunction = new lambda.Function(scope, name, {
        code: lambda.Code.fromAsset(path.join(__dirname, `../../../backend/backend`)),
        handler: `handlers.pipelines.${name}.lambda_handler`,
        runtime: LAMBDA_PYTHON_RUNTIME,
        layers: [lambdaCommonBaseLayer],
        timeout: Duration.minutes(15),
        memorySize: 3008,
        vpc:
            config.app.useGlobalVpc.enabled && config.app.useGlobalVpc.useForAllLambdas
                ? vpc
                : undefined, //Use VPC when flagged to use for all lambdas
        vpcSubnets:
            config.app.useGlobalVpc.enabled && config.app.useGlobalVpc.useForAllLambdas
                ? { subnets: subnets }
                : undefined,
        environment: {
            PIPELINE_STORAGE_TABLE_NAME: pipelineStorageTable.tableName,
            S3_BUCKET: artefactsBucket.bucketName,
            SAGEMAKER_BUCKET_NAME: sagemakerBucket.bucketName,
            SAGEMAKER_BUCKET_ARN: sagemakerBucket.bucketArn,
            ASSET_BUCKET_ARN: assetBucket.bucketArn,
            ENABLE_PIPELINE_FUNCTION_NAME: enablePipelineFunction.functionName,
            ENABLE_PIPELINE_FUNCTION_ARN: enablePipelineFunction.functionArn,
            LAMBDA_PIPELINE_SAMPLE_FUNCTION_BUCKET: artefactsBucket.bucketName,
            LAMBDA_PIPELINE_SAMPLE_FUNCTION_KEY:
                "sample_lambda_pipeline/lambda_pipeline_deployment_package.zip",
            ROLE_TO_ATTACH_TO_LAMBDA_PIPELINE: newPipelineLambdaRole.roleArn,
            SAGEMAKER_PRINCIPAL: Service("SAGEMAKER").PrincipalString,
            ECR_DKR_ENDPOINT: Service("ECR_DKR").Endpoint,
            LAMBDA_PYTHON_VERSION: LAMBDA_PYTHON_RUNTIME.name,
            SUBNET_IDS: newPipelineSubnetIds, //Determines if we put the pipeline lambdas in a VPC or not
            SECURITYGROUP_IDS: newPipelineLambdaSecurityGroup? newPipelineLambdaSecurityGroup.securityGroupId : "", //used if subnet IDs are passed in
        },
    });
    enablePipelineFunction.grantInvoke(createPipelineFunction);
    artefactsBucket.grantRead(createPipelineFunction);
    pipelineStorageTable.grantReadWriteData(createPipelineFunction);
    createPipelineFunction.addToRolePolicy(
        new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                "cloudFormation:CreateStack",
                "cloudFormation:UntagResource",
                "cloudFormation:TagResource",
            ],
            // actions: [ '*' ],
            resources: ["*"],

            // conditions: {
            //     "StringEquals": {"aws:ResourceTag/StackController": "VAMS"}
            // }
        })
    );
    createPipelineFunction.addToRolePolicy(
        new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                "iam:PassRole",
                "iam:CreateRole",
                "iam:GetRole",
                "iam:DeleteRole",
                "iam:CreatePolicy",
                "iam:GetPolicy",
                "iam:DeletePolicy",
                "iam:ListPolicyVersions",
                "iam:AttachRolePolicy",
                "iam:DetachRolePolicy",
            ],
            resources: [IAMArn("*NotebookIAMRole*").role, IAMArn("*NotebookIAMRolePolicy*").policy],
        })
    );
    createPipelineFunction.addToRolePolicy(
        new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["iam:PassRole"],
            resources: [newPipelineLambdaRole.roleArn],
        })
    );
    createPipelineFunction.addToRolePolicy(
        new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                "ecr:CreateRepository",
                "ecr:DeleteRepository",
                "ecr:DescribeRepositories",
                "ecr:TagResource",
            ],
            resources: ["*"],
        })
    );
    createPipelineFunction.addToRolePolicy(
        new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                "sagemaker:CreateNotebookInstanceLifecycleConfig",
                "sagemaker:DescribeNotebookInstanceLifecycleConfig",
                "sagemaker:DeleteNotebookInstanceLifecycleConfig",
                "sagemaker:CreateNotebookInstance",
                "sagemaker:DescribeNotebookInstance",
                "sagemaker:DeleteNotebookInstance",
                "sagemaker:AddTags",
            ],
            resources: ["*"],
        })
    );

    createPipelineFunction.addToRolePolicy(
        new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                "lambda:CreateFunction",
                "lambda:UpdateFunctionConfiguration",
                "ec2:DescribeSecurityGroups",
                "ec2:DescribeSubnets",
                "ec2:DescribeVpcs",
            ],
            resources: ["*"],
        })
    );

    suppressCdkNagErrorsByGrantReadWrite(createPipelineFunction);
    return createPipelineFunction;
}

function createRoleToAttachToLambdaPipelines(scope: Construct, assetBucket: s3.Bucket) {
    const newPipelineLambdaRole = new iam.Role(scope, "lambdaPipelineRole", {
        assumedBy: Service("LAMBDA").Principal,
        inlinePolicies: {
            ReadWriteAssetBucketPolicy: new iam.PolicyDocument({
                statements: [
                    new iam.PolicyStatement({
                        actions: [
                            "s3:PutObject",
                            "s3:GetObject",
                            "s3:ListBucket",
                            "s3:DeleteObject",
                            "s3:GetObjectVersion",
                        ],
                        resources: [`${assetBucket.bucketArn}`, `${assetBucket.bucketArn}/*`],
                    }),
                ],
            }),
        },
    });
    newPipelineLambdaRole.addManagedPolicy(
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaVPCAccessExecutionRole")
    );
    return newPipelineLambdaRole;
}

export function buildPipelineService(
    scope: Construct,
    lambdaCommonBaseLayer: LayerVersion,
    storageResources: storageResources,
    config: Config.Config,
    vpc: ec2.IVpc,
    subnets: ec2.ISubnet[]
): lambda.Function {
    const name = "pipelineService";
    const pipelineService = new lambda.Function(scope, name, {
        code: lambda.Code.fromAsset(path.join(__dirname, `../../../backend/backend`)),
        handler: `handlers.pipelines.${name}.lambda_handler`,
        runtime: LAMBDA_PYTHON_RUNTIME,
        layers: [lambdaCommonBaseLayer],
        timeout: Duration.minutes(15),
        memorySize: 3008,
        vpc:
            config.app.useGlobalVpc.enabled && config.app.useGlobalVpc.useForAllLambdas
                ? vpc
                : undefined, //Use VPC when flagged to use for all lambdas
        vpcSubnets:
            config.app.useGlobalVpc.enabled && config.app.useGlobalVpc.useForAllLambdas
                ? { subnets: subnets }
                : undefined,
        environment: {
            PIPELINE_STORAGE_TABLE_NAME: storageResources.dynamo.pipelineStorageTable.tableName,
            ASSET_STORAGE_TABLE_NAME: storageResources.dynamo.assetStorageTable.tableName,
            DATABASE_STORAGE_TABLE_NAME: storageResources.dynamo.databaseStorageTable.tableName,
        },
    });
    storageResources.dynamo.databaseStorageTable.grantReadData(pipelineService);
    storageResources.dynamo.pipelineStorageTable.grantReadWriteData(pipelineService);
    pipelineService.addToRolePolicy(
        new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["cloudFormation:DeleteStack"],
            resources: ["*"],
            conditions: {
                StringEquals: { "aws:ResourceTag/StackController": "VAMS" },
            },
        })
    );
    pipelineService.addToRolePolicy(
        new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                "iam:GetPolicy",
                "iam:GetRole",
                "iam:DeleteRole",
                "iam:DeletePolicy",
                "iam:ListPolicyVersions",
                "iam:DeletePolicyVersion",
                "iam:DetachRolePolicy",
            ],
            resources: [IAMArn("*NotebookIAMRole*").role, IAMArn("*NotebookIAMRolePolicy*").policy],
        })
    );
    pipelineService.addToRolePolicy(
        new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["ecr:DeleteRepository", "ecr:DescribeRepositories"],
            resources: ["*"],
        })
    );
    pipelineService.addToRolePolicy(
        new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                "sagemaker:DescribeNotebookInstanceLifecycleConfig",
                "sagemaker:DeleteNotebookInstanceLifecycleConfig",
                "sagemaker:DescribeNotebookInstance",
                "sagemaker:DeleteNotebookInstance",
                "sagemaker:StopNotebookInstance",
            ],
            resources: ["*"],
        })
    );
    pipelineService.addToRolePolicy(
        new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["lambda:DeleteFunction"],
            resources: ["*"],
        })
    );
    return pipelineService;
}

export function buildEnablePipelineFunction(
    scope: Construct,
    lambdaCommonBaseLayer: LayerVersion,
    pipelineStorageTable: dynamodb.Table,
    config: Config.Config,
    vpc: ec2.IVpc,
    subnets: ec2.ISubnet[]
) {
    const name = "enablePipeline";
    const enablePipelineFunction = new lambda.Function(scope, name, {
        code: lambda.Code.fromAsset(path.join(__dirname, `../../../backend/backend`)),
        handler: `handlers.pipelines.${name}.lambda_handler`,
        runtime: LAMBDA_PYTHON_RUNTIME,
        layers: [lambdaCommonBaseLayer],
        timeout: Duration.minutes(15),
        memorySize: 3008,
        vpc:
            config.app.useGlobalVpc.enabled && config.app.useGlobalVpc.useForAllLambdas
                ? vpc
                : undefined, //Use VPC when flagged to use for all lambdas
        vpcSubnets:
            config.app.useGlobalVpc.enabled && config.app.useGlobalVpc.useForAllLambdas
                ? { subnets: subnets }
                : undefined,
        environment: {
            PIPELINE_STORAGE_TABLE_NAME: pipelineStorageTable.tableName,
        },
    });
    pipelineStorageTable.grantReadWriteData(enablePipelineFunction);
    return enablePipelineFunction;
}

export function buildPipelineLambdaSecurityGroup(
    scope: Construct,
    vpc: ec2.IVpc,
    config: Config.Config
): ec2.ISecurityGroup | undefined {
    if (config.app.useGlobalVpc.enabled && config.app.useGlobalVpc.useForAllLambdas) {
        const pipelineLambdaSecurityGroup = new ec2.SecurityGroup(scope, "VPCeSecurityGroup", {
            vpc: vpc,
            allowAllOutbound: true,
            description: "VPC Endpoints Security Group",
        });

        return pipelineLambdaSecurityGroup;
    } else {
        return undefined;
    }
}

export function buildPipelineLambdaSubnetIds(
    scope: Construct,
    subnets: ec2.ISubnet[],
    config: Config.Config
): string {
    if (config.app.useGlobalVpc.enabled && config.app.useGlobalVpc.useForAllLambdas) {
        const subnetsArray: string[] = [];

        subnets.forEach((element) => {
            subnetsArray.push(element.subnetId);
        });
        return subnetsArray.join(",");
    } else {
        return "";
    }
}
