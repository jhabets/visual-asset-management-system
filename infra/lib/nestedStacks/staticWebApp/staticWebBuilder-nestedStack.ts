/* eslint-disable @typescript-eslint/no-unused-vars */
/*
 * Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { Construct } from "constructs";
import { NestedStack } from "aws-cdk-lib";
import * as cdk from "aws-cdk-lib";
import * as Config from "../../../config/config";
import { samlSettings } from "../../../config/saml-config";
import { storageResources } from "../storage/storageBuilder-nestedStack";
import { CloudFrontS3WebSiteConstruct } from "./constructs/cloudfront-s3-website-construct";
import { GatewayAlbDeployConstruct } from "./constructs/gateway-albDeploy-construct";
import { AlbS3WebsiteAlbDeployConstruct } from "./constructs/alb-s3-website-albDeploy-construct";
import { CustomCognitoConfigConstruct } from "./constructs/custom-cognito-config-construct";
import { addBehaviorToCloudFrontDistribution } from "./constructs/cloudfront-s3-website-construct";
import { NagSuppressions } from "cdk-nag";
import * as ec2 from "aws-cdk-lib/aws-ec2";

export interface StaticWebBuilderNestedStackProps extends cdk.StackProps {
    config: Config.Config;
    webAppBuildPath: string;
    apiUrl: string;
    storageResources: storageResources;
    ssmWafArn: string;
    cognitoWebClientId: string;
    cognitoUserPoolId: string;
    vpc: ec2.IVpc;
    subnetsPrivate: ec2.ISubnet[];
    subnetsPublic: ec2.ISubnet[];
}

/**
 * Default input properties
 */
const defaultProps: Partial<StaticWebBuilderNestedStackProps> = {
    //stackName: "",
    //env: {},
};

export class StaticWebBuilderNestedStack extends NestedStack {
    public endpointURL: string;
    public webAppS3BucketName: string;
    public albEndpoint: string;

    constructor(parent: Construct, name: string, props: StaticWebBuilderNestedStackProps) {
        super(parent, name);

        props = { ...defaultProps, ...props };

        //Deploy website distribution infrastructure and authentication tie-ins
        if (!props.config.app.useAlb.enabled) {
            //Deploy through CloudFront (default)

            const website = new CloudFrontS3WebSiteConstruct(this, "WebApp", {
                ...props,
                config: props.config,
                webSiteBuildPath: props.webAppBuildPath,
                webAcl: props.ssmWafArn,
                apiUrl: props.apiUrl,
                assetBucketUrl: props.storageResources.s3.assetBucket.bucketRegionalDomainName,
                cognitoDomain: props.config.app.authProvider.useCognito.useSaml
                    ? `https://${samlSettings.cognitoDomainPrefix}.auth.${props.config.env.region}.amazoncognito.com`
                    : "",
            });

            // Bind API Gaeway to /api route of cloudfront
            addBehaviorToCloudFrontDistribution(this, website.cloudFrontDistribution, props.apiUrl);

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
                        clientId: props.cognitoWebClientId,
                        userPoolId: props.cognitoUserPoolId,
                        callbackUrls: callbackUrls,
                        logoutUrls: callbackUrls,
                        identityProviders: ["COGNITO", samlSettings.name],
                    }
                );
                customCognitoWebClientConfig.node.addDependency(website);
            }

            this.webAppS3BucketName = website.webAppBucketName;
            this.endpointURL = website.endPointURL;
        } else {
            //Deploy with ALB (aka, use ALB->VPCEndpoint->S3 as path for web deployment)
            const webAppDistroNetwork = new GatewayAlbDeployConstruct(this, "WebAppDistroNetwork", {
                ...props,
                vpc: props.vpc,
                subnetsPrivate: props.subnetsPrivate,
                subnetsPublic: props.subnetsPublic,
            });

            const website = new AlbS3WebsiteAlbDeployConstruct(this, "WebApp", {
                ...props,
                config: props.config,
                artefactsBucket: props.storageResources.s3.artefactsBucket,
                webSiteBuildPath: props.webAppBuildPath,
                webAcl: props.ssmWafArn,
                apiUrl: props.apiUrl,
                vpc: webAppDistroNetwork.vpc,
                albSubnets: webAppDistroNetwork.subnets.webApp,
                s3VPCEndpoint: webAppDistroNetwork.s3VpcEndpoint,
                albSecurityGroup: webAppDistroNetwork.securityGroups.webAppALB,
                vpceSecurityGroup: webAppDistroNetwork.securityGroups.webAppVPCE,
            });

            /**
             * When using federated identities, this list of callback urls must include
             * the set of names that VAMSAuth.tsx will resolve when it calls
             * window.location.origin for the redirectSignIn and redirectSignout callback urls.
             */
            const callbackUrls = [
                "http://localhost:3000",
                "http://localhost:3000/",
                `${website.endPointURL}`,
                `${website.endPointURL}/`,
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
                        clientId: props.cognitoWebClientId,
                        userPoolId: props.cognitoUserPoolId,
                        callbackUrls: callbackUrls,
                        logoutUrls: callbackUrls,
                        identityProviders: ["COGNITO", samlSettings.name],
                    }
                );
                customCognitoWebClientConfig.node.addDependency(website);
            }

            this.webAppS3BucketName = website.webAppBucketName;
            this.endpointURL = website.endPointURL;
            this.albEndpoint = website.albEndpoint;
        }

        //Nag supressions
        const reason =
            "The custom resource CDK bucket deployment needs full access to the bucket to deploy web static files";
        NagSuppressions.addResourceSuppressions(
            this,
            [
                {
                    id: "AwsSolutions-IAM5",
                    reason: reason,
                    appliesTo: [
                        {
                            regex: "/Action::s3:.*/g",
                        },
                    ],
                },
                {
                    id: "AwsSolutions-IAM5",
                    reason: reason,
                    appliesTo: [
                        {
                            // https://github.com/cdklabs/cdk-nag#suppressing-a-rule
                            regex: "/^Resource::.*/g",
                        },
                    ],
                },
            ],
            true
        );
    }
}
