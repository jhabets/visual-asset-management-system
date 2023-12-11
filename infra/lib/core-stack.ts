/* eslint-disable @typescript-eslint/no-unused-vars */
/*
 * Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as cdk from "aws-cdk-lib";
import * as cloudTrail from "aws-cdk-lib/aws-cloudtrail";
import { ApiBuilderNestedStack } from "./nestedStacks/apiLambda/apiBuilder-nestedStack";
import { StorageResourcesBuilderNestedStack } from "./nestedStacks/storage/storageBuilder-nestedStack";
import {
    CognitoWebNativeNestedStack,
    CognitoWebNativeNestedStackProps,
} from "./nestedStacks/auth/cognito-web-native-nestedStack";
import { ApiGatewayV2AmplifyNestedStack } from "./nestedStacks/apiLambda/apigatewayv2-amplify-nestedStack";
import { Construct } from "constructs";
import { NagSuppressions } from "cdk-nag";
import { CustomFeatureEnabledConfigNestedStack } from "./nestedStacks/featureEnabled/custom-featureEnabled-config-nestedStack";
import { samlSettings } from "../config/saml-config";
import { LocationServiceNestedStack } from "./nestedStacks/locationService/location-service-nestedStack";
import { SearchBuilderNestedStack } from "./nestedStacks/search/searchBuilder-nestedStack";
import { StaticWebBuilderNestedStack } from "./nestedStacks/staticWebApp/staticWebBuilder-nestedStack";
import * as Config from "../config/config";
import { VAMS_APP_FEATURES } from "../config/common/vamsAppFeatures";
import { VisualizerPipelineBuilderNestedStack } from "./nestedStacks/visualizerPipelines/visualizerPipelineBuilder-nestedStack";
import { LambdaLayersBuilderNestedStack } from "./nestedStacks/apiLambda/lambdaLayersBuilder-nestedStack";
import { VPCBuilderNestedStack } from "./nestedStacks/vpc/vpcBuilder-nestedStack";
import { IamRoleTransform } from "./aspects/iam-role-transform.aspect";
import { Aspects } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";

export interface EnvProps {
    env: cdk.Environment;
    stackName: string;
    ssmWafArn: string;
    config: Config.Config;
}

export class CoreVAMSStack extends cdk.Stack {
    private enabledFeatures: string[] = [];
    private webAppBuildPath = "../web/build";

    private vpc: ec2.IVpc;
    private subnetsPrivate: ec2.ISubnet[];
    private subnetsPublic: ec2.ISubnet[];
    private vpceSecurityGroup: ec2.ISecurityGroup;

    constructor(scope: Construct, id: string, props: EnvProps) {
        super(scope, id, { ...props, crossRegionReferences: true });

        const adminEmailAddress = new cdk.CfnParameter(this, "adminEmailAddress", {
            type: "String",
            description:
                "Email address for login and where your password is sent to. You will be sent a temporary password to authenticate to Cognito.",
            default: props.config.app.adminEmailAddress,
        });

        //Add tags to stack with cdk.json "environment" settings (if defined)
        //Modify roles with cdk.json "aws" settings (if defined)
        const environments = this.node.tryGetContext("environments");
        const commonEnv = environments["common"] || undefined;
        const awsEnv = environments["aws"] || undefined;
        if (commonEnv) {
            Object.keys(commonEnv).forEach(function (key) {
                if (commonEnv[key] != "") {
                    cdk.Tags.of(scope).add(key, commonEnv[key]);
                }
            });
        }
        if (awsEnv) {
            Aspects.of(this).add(
                new IamRoleTransform(
                    this,
                    awsEnv["IamRoleNamePrefix"],
                    awsEnv["PermissionBoundaryArn"]
                )
            );
        }

        //Setup GovCloud Feature Enabled
        if (props.config.app.govCloud.enabled) {
            this.enabledFeatures.push(VAMS_APP_FEATURES.GOVCLOUD);
        }

        //Setup ALB Feature Enabled
        if (props.config.app.useAlb.enabled) {
            this.enabledFeatures.push(VAMS_APP_FEATURES.ALBDEPLOY);
        }

        //Select auth provider
        if (props.config.app.authProvider.useCognito.enabled) {
            this.enabledFeatures.push(VAMS_APP_FEATURES.AUTHPROVIDER_COGNITO);
        } else if (props.config.app.authProvider.useExternalOathIdp.enabled) {
            this.enabledFeatures.push(VAMS_APP_FEATURES.AUTHPROVIDER_EXTERNALOATHIDP);
        }

        //Deploy VPC (nested stack)
        if (props.config.app.useGlobalVpc.enabled) {
            const vpcBuilderNestedStack = new VPCBuilderNestedStack(this, "VPCBuilder", {
                config: props.config,
            });

            this.vpc = vpcBuilderNestedStack.vpc;
            this.vpceSecurityGroup = vpcBuilderNestedStack.vpceSecurityGroup;
            this.subnetsPrivate = vpcBuilderNestedStack.privateSubnets;
            this.subnetsPublic = vpcBuilderNestedStack.publicSubnets;

            const vpcIdOutput = new cdk.CfnOutput(this, "VpcIdOutput", {
                value: this.vpc.vpcId,
                description: "VPC ID created or used by VAMS deployment",
            });
        }

        //Deploy Storage Resources (nested stack)
        const storageResourcesNestedStack = new StorageResourcesBuilderNestedStack(
            this,
            "StorageResourcesBuilder",
            props.config.app.stagingBucketName
        );

        //Setup cloud trail
        const trail = new cloudTrail.Trail(this, "CloudTrail-VAMS", {
            isMultiRegionTrail: false,
            bucket: storageResourcesNestedStack.storageResources.s3.accessLogsBucket,
            s3KeyPrefix: "cloudtrail-logs",
        });
        trail.logAllLambdaDataEvents();
        trail.logAllS3DataEvents();

        //Deploy Lambda Layers (nested stack)
        const lambdaLayers = new LambdaLayersBuilderNestedStack(this, "LambdaLayers", {});

        //Setup Cognito (Nested Stack)
        const cognitoProps: CognitoWebNativeNestedStackProps = {
            ...props,
            lambdaCommonBaseLayer: lambdaLayers.lambdaCommonBaseLayer,
            storageResources: storageResourcesNestedStack.storageResources,
            config: props.config,
        };

        //See if we have enabled SAML settings
        //TODO: Migrate rest of settings to main config file
        if (props.config.app.authProvider.useCognito.useSaml) {
            cognitoProps.samlSettings = samlSettings;
            this.enabledFeatures.push(VAMS_APP_FEATURES.AUTHPROVIDER_COGNITO_SAML);
        }

        const cognitoResourcesNestedStack = new CognitoWebNativeNestedStack(
            this,
            "Cognito",
            cognitoProps
        );

        //Ignore stacks if we are only loading context (mostly for Imported VPC)
        if (!props.config.env.loadContextIgnoreVPCStacks) {
            // Deploy api gateway + amplify configuration endpoints (nested stack)
            const apiNestedStack = new ApiGatewayV2AmplifyNestedStack(this, "Api", {
                ...props,
                userPool: cognitoResourcesNestedStack.userPool,
                userPoolClient: cognitoResourcesNestedStack.webClientUserPool,
                config: props.config,
                cognitoWebClientId: cognitoResourcesNestedStack.webClientId,
                cognitoIdentityPoolId: cognitoResourcesNestedStack.identityPoolId,
            });

            //Deploy Static Website and any API proxies (nested stack)
            const staticWebBuilderNestedStack = new StaticWebBuilderNestedStack(this, "StaticWeb", {
                config: props.config,
                vpc: this.vpc,
                subnetsPrivate: this.subnetsPrivate,
                subnetsPublic: this.subnetsPublic,
                webAppBuildPath: this.webAppBuildPath,
                apiUrl: apiNestedStack.apiEndpoint,
                storageResources: storageResourcesNestedStack.storageResources,
                ssmWafArn: props.ssmWafArn,
                cognitoWebClientId: cognitoResourcesNestedStack.webClientId,
                cognitoUserPoolId: cognitoResourcesNestedStack.userPoolId,
            });

            //Deploy Backend API framework (nested stack)
            const apiBuilderNestedStack = new ApiBuilderNestedStack(
                this,
                "ApiBuilder",
                props.config,
                apiNestedStack.apiGatewayV2,
                storageResourcesNestedStack.storageResources,
                lambdaLayers.lambdaCommonBaseLayer,
                lambdaLayers.lambdaCommonServiceSDKLayer,
                this.vpc,
                this.subnetsPrivate
            );

            //Deploy OpenSearch Serverless (nested stack)
            //Note: If we are loading context, this is one of the stacks we are ignoring
            const searchBuilderNestedStack = new SearchBuilderNestedStack(
                this,
                "SearchBuilder",
                props.config,
                apiNestedStack.apiGatewayV2,
                storageResourcesNestedStack.storageResources,
                lambdaLayers.lambdaCommonBaseLayer,
                this.vpc,
                this.subnetsPrivate
            );

            ///Optional Pipelines (Nested Stack)
            if (props.config.app.pipelines.usePointCloudVisualization.enabled) {
                const visualizerPipelineNetworkNestedStack =
                    new VisualizerPipelineBuilderNestedStack(this, "VisualizerPipelineBuilder", {
                        ...props,
                        config: props.config,
                        storageResources: storageResourcesNestedStack.storageResources,
                        lambdaCommonBaseLayer: lambdaLayers.lambdaCommonBaseLayer,
                        vpc: this.vpc,
                        vpceSecurityGroup: this.vpceSecurityGroup,
                        subnets: this.subnetsPrivate,
                    });
            }

            //Write final output configurations (pulling forward from nested stacks)
            const endPointURLParamsOutput = new cdk.CfnOutput(this, "WebsiteEndpointURLOutput", {
                value: staticWebBuilderNestedStack.endpointURL,
                description: "Website endpoint URL",
            });

            const webAppS3BucketNameParamsOutput = new cdk.CfnOutput(
                this,
                "WebAppS3BucketNameOutput",
                {
                    value: staticWebBuilderNestedStack.webAppS3BucketName,
                    description: "S3 Bucket for static web app files",
                }
            );

            if (props.config.app.useAlb.enabled) {
                const albEndpointOutput = new cdk.CfnOutput(this, "AlbEndpointOutput", {
                    value: staticWebBuilderNestedStack.albEndpoint,
                    description:
                        "ALB DNS Endpoint to use for primary domain host DNS routing to static web site",
                });
            }

            const gatewayURLParamsOutput = new cdk.CfnOutput(this, "APIGatewayEndpointOutput", {
                value: `${apiNestedStack.apiEndpoint}`,
                description: "API Gateway endpoint",
            });

            //Nag supressions
            const refactorPaths = [
                `/${props.stackName}/ApiBuilder/VAMSWorkflowIAMRole/Resource`,
                `/${props.stackName}/ApiBuilder/storageBucketRole/DefaultPolicy/Resource`,
            ];

            for (const path of refactorPaths) {
                const reason = `Intention is to refactor this model away moving forward 
                so that this type of access is not required within the stack.
                Customers are advised to isolate VAMS to its own account in test and prod
                as a substitute to tighter resource access.`;
                NagSuppressions.addResourceSuppressionsByPath(
                    this,
                    path,
                    [
                        {
                            id: "AwsSolutions-IAM5",
                            reason: reason,
                        },
                        {
                            id: "AwsSolutions-IAM4",
                            reason: reason,
                        },
                    ],
                    true
                );
            }
        }

        //Deploy Location Services (Nested Stack) and setup feature enabled
        if (props.config.app.useLocationService.enabled) {
            const locationServiceNestedStack = new LocationServiceNestedStack(
                this,
                "LocationService",
                {}
            );

            locationServiceNestedStack.addMapPermissionsToRole(
                cognitoResourcesNestedStack.authenticatedRole
            );
            locationServiceNestedStack.addMapPermissionsToRole(
                cognitoResourcesNestedStack.superAdminRole
            );
            this.enabledFeatures.push(VAMS_APP_FEATURES.LOCATIONSERVICES);
        }

        //Deploy Enabled Feature Tracking (Nested Stack)
        const customFeatureEnabledConfigNestedStack = new CustomFeatureEnabledConfigNestedStack(
            this,
            "CustomFeatureEnabledConfig",
            {
                appFeatureEnabledTable:
                    storageResourcesNestedStack.storageResources.dynamo
                        .appFeatureEnabledStorageTable,
                featuresEnabled: this.enabledFeatures,
            }
        );

        //Write final output configurations (pulling forward from nested stacks)

        const authCognitoUserPoolIdParamsOutput = new cdk.CfnOutput(
            this,
            "AuthCognito_UserPoolId",
            {
                value: cognitoResourcesNestedStack.userPoolId,
            }
        );
        const authCognitoIdentityPoolIdParamsOutput = new cdk.CfnOutput(
            this,
            "AuthCognito_IdentityPoolId",
            {
                value: cognitoResourcesNestedStack.identityPoolId,
            }
        );
        const authCognitoUserWebClientIdParamsOutput = new cdk.CfnOutput(
            this,
            "AuthCognito_WebClientId",
            {
                value: cognitoResourcesNestedStack.webClientId,
            }
        );

        const assetBucketOutput = new cdk.CfnOutput(this, "AssetS3BucketNameOutput", {
            value: storageResourcesNestedStack.storageResources.s3.assetBucket.bucketName,
            description: "S3 bucket for asset storage",
        });

        const assetVisualizerBucketOutput = new cdk.CfnOutput(
            this,
            "AssetVisualizerS3BucketNameOutput",
            {
                value: storageResourcesNestedStack.storageResources.s3.assetVisualizerBucket
                    .bucketName,
                description: "S3 bucket for visualization asset storage",
            }
        );

        const artefactsBucketOutput = new cdk.CfnOutput(this, "ArtefactsS3BucketNameOutput", {
            value: storageResourcesNestedStack.storageResources.s3.artefactsBucket.bucketName,
            description: "S3 bucket for template notebooks",
        });

        //Add tags to stack
        cdk.Tags.of(this).add("vams:stackname", props.stackName);

        //Add for Systems Manager->Application Manager Cost Tracking for main VAMS Stack
        //TODO: Figure out why tag is not getting added to stack
        cdk.Tags.of(this).add("AppManagerCFNStackKey", this.stackId, {
            includeResourceTypes: ["AWS::CloudFormation::Stack"],
        });

        //Global Nag Supressions
        this.node.findAll().forEach((item) => {
            if (item instanceof cdk.aws_lambda.Function) {
                const fn = item as cdk.aws_lambda.Function;
                // python3.9 suppressed for CDK Bucket Deployment
                // python3.10 suppressed for all lambdas due to restriction on file size when going over 3.10 currently (implement layer code reduction size functionality)
                // nodejs18.x suppressed for use of custom resource to deploy saml in CustomCognitoConfigConstruct
                if (
                    fn.runtime.name === "python3.9" ||
                    fn.runtime.name === "python3.10" ||
                    fn.runtime.name === "nodejs18.x"
                ) {
                    //console.log(item.node.path,fn.runtime.name)
                    NagSuppressions.addResourceSuppressions(fn, [
                        {
                            id: "AwsSolutions-L1",
                            reason: "The lambda function is configured with the appropriate runtime version",
                        },
                    ]);
                }
                return;
            }
            return;
        });

        NagSuppressions.addResourceSuppressions(
            this,
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

        NagSuppressions.addResourceSuppressions(
            this,
            [
                {
                    id: "AwsSolutions-IAM4",
                    reason: "Intend to use AWSLambdaVPCAccessExecutionRole as is at this stage of this project.",
                    appliesTo: [
                        {
                            regex: "/.*AWSLambdaVPCAccessExecutionRole$/g",
                        },
                    ],
                },
            ],
            true
        );

        NagSuppressions.addResourceSuppressions(
            this,
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

        const refactorPaths = [
            `/${props.stackName}/Cognito/DefaultUnauthenticatedRole/DefaultPolicy/Resource`,
            `/${props.stackName}/Cognito/DefaultAuthenticatedRole/DefaultPolicy/Resource`,
            `/${props.stackName}/Cognito/SuperAdminRole/DefaultPolicy/Resource`,
        ];

        for (const path of refactorPaths) {
            const reason = `Intention is to refactor this model away moving forward 
            so that this type of access is not required within the stack.
            Customers are advised to isolate VAMS to its own account in test and prod
            as a substitute to tighter resource access.`;
            NagSuppressions.addResourceSuppressionsByPath(
                this,
                path,
                [
                    {
                        id: "AwsSolutions-IAM5",
                        reason: reason,
                    },
                    {
                        id: "AwsSolutions-IAM4",
                        reason: reason,
                    },
                ],
                true
            );
        }
    }
}
