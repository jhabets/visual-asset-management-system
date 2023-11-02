/* eslint-disable @typescript-eslint/no-unused-vars */
/*
 * Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as cdk from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as cloudTrail from "aws-cdk-lib/aws-cloudtrail";
import { apiBuilder } from "./api-builder";
import { storageResourcesBuilder } from "./storage-builder";
import {
    AmplifyConfigLambdaConstruct,
    AmplifyConfigLambdaConstructProps,
} from "./constructs/amplify-config-lambda-construct";
import { CloudFrontS3WebSiteConstruct } from "./constructs/cloudfront-s3-website-construct";
import { VpcGatewayAlbDeployConstruct } from "./constructs/vpc-gateway-albDeploy-construct";
import { AlbS3WebsiteAlbDeployConstruct } from "./constructs/alb-s3-website-albDeploy-construct";
import {
    CognitoWebNativeConstruct,
    CognitoWebNativeConstructProps,
} from "./constructs/cognito-web-native-construct";
import { ApiGatewayV2CloudFrontConstruct } from "./constructs/apigatewayv2-cloudfront-construct";
import { Construct } from "constructs";
import { NagSuppressions } from "cdk-nag";
import { CustomCognitoConfigConstruct } from "./constructs/custom-cognito-config-construct";
import { CustomFeatureEnabledConfigConstruct } from "./constructs/custom-featureEnabled-config-construct";
import { samlSettings } from "../config/saml-config";
import { LocationServiceConstruct } from "./constructs/location-service-construct";
import { streamsBuilder } from "./streams-builder";
//import customResources = require('aws-cdk-lib/custom-resources');
import * as Config from '../config/config';
import { LAMBDA_PYTHON_RUNTIME } from '../config/config';
import { VAMS_APP_FEATURES } from '../config/common/vamsAppFeatures';
import { VpcSecurityGroupGatewayVisualizerPipelineConstruct } from "./constructs/vpc-securitygroup-gateway-visualizerPipeline-construct";
import { VisualizationPipelineConstruct } from "./constructs/visualizerPipeline-construct";
import * as pylambda from "@aws-cdk/aws-lambda-python-alpha";


export interface EnvProps {
    env: cdk.Environment;
    stackName: string;
    ssmWafArnParameterName: string;
    ssmWafArnParameterRegion: string;
    ssmWafArn: string;
    config: Config.Config;
}

export class CoreVAMSStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: EnvProps) {
        super(scope, id, { ...props, crossRegionReferences: true });

        const enabledFeatures: string[] = [];

        const adminEmailAddress = new cdk.CfnParameter(this, "adminEmailAddress", {
            type: "String",
            description:
                "Email address for login and where your password is sent to. You will be sent a temporary password to authenticate to Cognito.",
            default: props.config.app.adminEmailAddress,
        });

        const webAppBuildPath = "../web/build";

        const storageResources = storageResourcesBuilder(this, props.config.app.stagingBucketName);

        const trail = new cloudTrail.Trail(this, "CloudTrail-VAMS", {
            isMultiRegionTrail: false,
            bucket: storageResources.s3.accessLogsBucket,
            s3KeyPrefix: "cloudtrail-logs",
        });
        trail.logAllLambdaDataEvents();
        trail.logAllS3DataEvents();

        //Deploy Common Base Lambda Layer
        const lambdaCommonBaseLayer = new pylambda.PythonLayerVersion(
            this,
            "VAMSLayerBase",
            {
              layerVersionName: "vams_layer_base",
              entry: "../backend/lambdaLayers/base", 
              compatibleRuntimes: [LAMBDA_PYTHON_RUNTIME],
              removalPolicy: cdk.RemovalPolicy.DESTROY,
              bundling: {
                
              }
            }
          );

        //Deploy Common Service SDK Lambda Layer
        const lambdaCommonServiceSDKLayer = new pylambda.PythonLayerVersion(
            this,
            "VAMSLayerServiceSDK",
            {
              layerVersionName: "vams_layer_servicesdk",
              entry: "../backend/lambdaLayers/serviceSDK", 
              compatibleRuntimes: [LAMBDA_PYTHON_RUNTIME],
              removalPolicy: cdk.RemovalPolicy.DESTROY,
              bundling: {
                
              }
            }
          );

        const cognitoProps: CognitoWebNativeConstructProps = {
            ...props,
            lambdaCommonBaseLayer: lambdaCommonBaseLayer,
            storageResources: storageResources,
            config: props.config
        };

        //Select auth provider
        if(props.config.app.authProvider.useCognito.enabled)
        {
            enabledFeatures.push(VAMS_APP_FEATURES.AUTHPROVIDER_COGNITO)
        }
        else if(props.config.app.authProvider.useExternalOATHIdp.enabled)
        {
            enabledFeatures.push(VAMS_APP_FEATURES.AUTHPROVIDER_EXTERNALOATHIDP)
        }

        //See if we have enabled SAML settings
        //TODO: Migrate rest of settings to main config file
        if (props.config.app.authProvider.useCognito.useSaml) {
            cognitoProps.samlSettings = samlSettings;
            enabledFeatures.push(VAMS_APP_FEATURES.AUTHPROVIDER_COGNITO_SAML)
        }

        if(props.config.app.govCloud.enabled) {
            enabledFeatures.push(VAMS_APP_FEATURES.GOVCLOUD)
        }

        const cognitoResources = new CognitoWebNativeConstruct(this, "Cognito", cognitoProps);

        const cognitoUser = new cognito.CfnUserPoolUser(this, "AdminUser", {
            username: props.config.app.adminEmailAddress,
            userPoolId: cognitoResources.userPoolId,
            desiredDeliveryMediums: ["EMAIL"],
            userAttributes: [
                {
                    name: "email",
                    value: props.config.app.adminEmailAddress,
                },
            ],
        });

        const userPoolGroup = new cognito.CfnUserPoolGroup(this, "AdminGroup", {
            groupName: "super-admin",
            userPoolId: cognitoResources.userPoolId,
            roleArn: cognitoResources.superAdminRole.roleArn,
        });

        userPoolGroup.node.addDependency(cognitoResources);

        const userGroupAttachment = new cognito.CfnUserPoolUserToGroupAttachment(
            this,
            "AdminUserToGroupAttachment",
            {
                userPoolId: cognitoResources.userPoolId,
                username: props.config.app.adminEmailAddress,
                groupName: "super-admin",
            }
        );
        userGroupAttachment.addDependency(cognitoUser);
        userGroupAttachment.addDependency(userPoolGroup);


        // initialize api gateway
        const api = new ApiGatewayV2CloudFrontConstruct(this, "api", {
            ...props,
            userPool: cognitoResources.userPool,
            userPoolClient: cognitoResources.webClientUserPool,
        });


        //Deploy website distribution infrastructure and authentication tie-ins
        if(!props.config.app.useAlb.enabled) {
            //Deploy through CloudFront (default)

            const website = new CloudFrontS3WebSiteConstruct(this, "WebApp", {
                ...props,
                webSiteBuildPath: webAppBuildPath,
                webAcl: props.ssmWafArn,
                apiUrl: api.apiUrl,
                assetBucketUrl: storageResources.s3.assetBucket.bucketRegionalDomainName,
                cognitoDomain: props.config.app.authProvider.useCognito.useSaml
                    ? `https://${samlSettings.cognitoDomainPrefix}.auth.${props.env.region}.amazoncognito.com`
                    : "",
            });

            // Bind API Gaeway to /api route of cloudfront
            api.addBehaviorToCloudFrontDistribution(website.cloudFrontDistribution);

            /**
             * When using federated identities, this list of callback urls must include
             * the set of names that VAMSAuth.tsx will resolve when it calls
             * window.location.origin for the redirectSignIn and redirectSignout callback urls.
             */
            const callbackUrls = [
                "http://localhost:3000",
                "http://localhost:3000/",
                `https://${website.cloudFrontDistribution.domainName}/`,
                `https://${website.cloudFrontDistribution.domainName}`,
            ];

            /**
             * Propagate Base CloudFront URL to Cognito User Pool Callback and Logout URLs
             * if SAML is enabled.
             */
            if (props.config.app.authProvider.useCognito.useSaml) {
                const customCognitoWebClientConfig = new CustomCognitoConfigConstruct(
                    this,
                    "CustomCognitoWebClientConfig",
                    {
                        name: "Web",
                        clientId: cognitoResources.webClientId,
                        userPoolId: cognitoResources.userPoolId,
                        callbackUrls: callbackUrls,
                        logoutUrls: callbackUrls,
                        identityProviders: ["COGNITO", samlSettings.name],
                    }
                );
                customCognitoWebClientConfig.node.addDependency(website);
            }

            NagSuppressions.addResourceSuppressionsByPath(
                this,
                `/${props.stackName}/WebApp/WebAppDistribution/Resource`,
                [
                    {
                        id: "AwsSolutions-CFR4",
                        reason: "This requires use of a custom viewer certificate which should be provided by customers.",
                    },
                ],
                true
            );

        }
        else {
            //Deploy with ALB (aka, use ALB->VPCEndpoint->S3 as path for web deployment)
            const webAppDistroNetwork =
                new VpcGatewayAlbDeployConstruct(
                    this,
                    "WebAppDistroNetwork",
                    {
                        ...props,
                        vpcCidrRange: props.config.app.useAlb.vpcCidrRange,
                        setupPublicAccess: props.config.app.useAlb.publicSubnet
                    }
                );
                
            const website = new AlbS3WebsiteAlbDeployConstruct(this, "WebApp", {
                ...props,
                artefactsBucket: storageResources.s3.artefactsBucket,
                domainHostName: props.config.app.useAlb.domainHost,
                webSiteBuildPath: webAppBuildPath,
                webAcl: props.ssmWafArn,
                apiUrl: api.apiUrl,
                vpc: webAppDistroNetwork.vpc,
                subnets: webAppDistroNetwork.subnets.webApp,
                setupPublicAccess: props.config.app.useAlb.publicSubnet,
                acmCertARN: props.config.app.useAlb.certificateARN,
                optionalHostedZoneId: props.config.app.useAlb.optionalHostedZoneID
            });

            /**
             * When using federated identities, this list of callback urls must include
             * the set of names that VAMSAuth.tsx will resolve when it calls
             * window.location.origin for the redirectSignIn and redirectSignout callback urls.
             */
            const callbackUrls = [
                "http://localhost:3000",
                "http://localhost:3000/",
                `${website.websiteUrl}`,
                `${website.websiteUrl}/`,
            ];

            /**
             * Propagate Base CloudFront URL to Cognito User Pool Callback and Logout URLs
             * if SAML is enabled.
             */
            if (props.config.app.authProvider.useCognito.useSaml) {
                const customCognitoWebClientConfig = new CustomCognitoConfigConstruct(
                    this,
                    "CustomCognitoWebClientConfig",
                    {
                        name: "Web",
                        clientId: cognitoResources.webClientId,
                        userPoolId: cognitoResources.userPoolId,
                        callbackUrls: callbackUrls,
                        logoutUrls: callbackUrls,
                        identityProviders: ["COGNITO", samlSettings.name],
                    }
                );
                customCognitoWebClientConfig.node.addDependency(website);
            }

            enabledFeatures.push(VAMS_APP_FEATURES.ALBDEPLOY)
        }
        
        //Deploy Backend API framework
        apiBuilder(this, api.apiGatewayV2, storageResources, lambdaCommonBaseLayer, lambdaCommonServiceSDKLayer, props);

        //Deploy OpenSearch Serverless
        streamsBuilder(this, api.apiGatewayV2, storageResources, lambdaCommonBaseLayer, props.config.app.openSearch.useProvisioned.enabled);


        // required by AWS internal accounts.  Can be removed in customer Accounts
        // const wafv2Regional = new Wafv2BasicConstruct(this, "Wafv2Regional", {
        //     ...props,
        //     wafScope: WAFScope.REGIONAL,
        // });

        //Deploy Location Services
        if(props.config.app.useLocationService.enabled) {
            const location = new LocationServiceConstruct(this, "LocationService", {
                role: cognitoResources.authenticatedRole,
            });
            enabledFeatures.push(VAMS_APP_FEATURES.LOCATIONSERVICES)
        }

        const amplifyConfigProps: AmplifyConfigLambdaConstructProps = {
            ...props,
            api: api.apiGatewayV2,
            appClientId: cognitoResources.webClientId,
            identityPoolId: cognitoResources.identityPoolId,
            userPoolId: cognitoResources.userPoolId,
            region: props.config.env.region,
            externalOathIdpURL: props.config.app.authProvider.useExternalOATHIdp.idpAuthProviderUrl
        };

        if (props.config.app.authProvider.useCognito.useSaml) {
            amplifyConfigProps.federatedConfig = {
                customCognitoAuthDomain: `${samlSettings.cognitoDomainPrefix}.auth.${props.config.env.region}.amazoncognito.com`,
                customFederatedIdentityProviderName: samlSettings.name,
                // if necessary, the callback urls can be determined here and passed to the UI through the config endpoint
                // redirectSignIn: callbackUrls[0],
                // redirectSignOut: callbackUrls[0],
            };
        }

        const amplifyConfigFn = new AmplifyConfigLambdaConstruct(
            this,
            "AmplifyConfig",
            amplifyConfigProps
        );

        ///Optional Pipeline Constructs
        //Point Cloud (PC) Visualizer Pipeline
        if (props.config.app.pipelines.usePointCloudVisualization.enabled) {
            const visualizerPipelineNetwork =
                new VpcSecurityGroupGatewayVisualizerPipelineConstruct(
                    this,
                    "VisualizerPipelineNetwork",
                    {
                        ...props,
                        vpcCidrRange: props.config.app.pipelines.usePointCloudVisualization.vpcCidrRange,
                    }
                );

            const visualizerPipeline = new VisualizationPipelineConstruct(
                this,
                "VisualizerPipeline",
                {
                    ...props,
                    storage: storageResources,
                    vpc: visualizerPipelineNetwork.vpc,
                    visualizerPipelineSubnets: visualizerPipelineNetwork.subnets.pipeline,
                    visualizerPipelineSecurityGroups: [
                        visualizerPipelineNetwork.securityGroups.pipeline,
                    ],
                    lambdaCommonBaseLayer
                }
            );
        }

        //Write enabled features to dynamoDB table
        const customFeatureEnabledConfigConstruct = new CustomFeatureEnabledConfigConstruct(
        this,
        "CustomFeatureEnabledConfigConstruct",
        {
            appFeatureEnabledTable: storageResources.dynamo.appFeatureEnabledStorageTable,
            featuresEnabled: enabledFeatures
        });

        //Write outputs
        const assetBucketOutput = new cdk.CfnOutput(this, "AssetBucketNameOutput", {
            value: storageResources.s3.assetBucket.bucketName,
            description: "S3 bucket for asset storage",
        });

        const assetVisualizerBucketOutput = new cdk.CfnOutput(
            this,
            "AssetVisualizerBucketNameOutput",
            {
                value: storageResources.s3.assetVisualizerBucket.bucketName,
                description: "S3 bucket for visualization asset storage",
            }
        );

        const artefactsBucketOutput = new cdk.CfnOutput(this, "artefactsBucketOutput", {
            value: storageResources.s3.artefactsBucket.bucketName,
            description: "S3 bucket for template notebooks",
        });

        if (props.config.app.authProvider.useCognito.useSaml) {
            const samlIdpResponseUrl = new cdk.CfnOutput(this, "SAML_IdpResponseUrl", {
                value: `https://${samlSettings.cognitoDomainPrefix}.auth.${props.env.region}.amazoncognito.com/saml2/idpresponse`,
                description: "SAML IdP Response URL",
            });
        }

        cdk.Tags.of(this).add("vams:stackname", props.stackName);

        //Add for Systems Manager->Application Manager Cost Tracking for main VAMS Stack
        //TODO: Figure out why tag is not getting added to stack
        cdk.Tags.of(this).add("AppManagerCFNStackKey", this.stackId, {
            includeResourceTypes: ['AWS::CloudFormation::Stack'],
        });

        //Global Nag Supressions
        this.node.findAll().forEach((item) => {
            if (item instanceof cdk.aws_lambda.Function) {
                const fn = item as cdk.aws_lambda.Function;
                // python3.10 suppressed for CDK Bucket Deployment
                // nodejs14.x suppressed for use of custom resource to deploy saml in CustomCognitoConfigConstruct
                if (fn.runtime.name === "python3.10" || fn.runtime.name === "nodejs14.x") {
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


        const refactorPaths = [
            `/${props.stackName}/VAMSWorkflowIAMRole/Resource`,
            `/${props.stackName}/lambdaPipelineRole`,
            `/${props.stackName}/pipelineService`,
            `/${props.stackName}/workflowService`,
            `/${props.stackName}/listExecutions`,
        ];

        refactorPaths.concat(`/${props.stackName}/idxa`);
        refactorPaths.concat(`/${props.stackName}/idxm`);


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

    afterBundling(inputDir: string, outputDir: string): string[]{
        return [`cd ${outputDir} && find . -type d -name __pycache__ -prune -exec rm -rf {} \; && find . -type d -name tests -prune -exec rm -rf {} \; && find . -type d -name *boto* -prune -exec rm -rf {} \;`];
      }
}
