/*
 * Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as cloudfrontOrigins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3 from "aws-cdk-lib/aws-s3";
import { BlockPublicAccess } from "aws-cdk-lib/aws-s3";
import * as s3deployment from "aws-cdk-lib/aws-s3-deployment";
import * as cdk from "aws-cdk-lib";
import { Duration } from "aws-cdk-lib";
import { Construct } from "constructs";
import { requireTLSAddToResourcePolicy } from "../../../helper/security";
import { NagSuppressions } from "cdk-nag";
import * as Config from "../../../../config/config";
import { Service } from "../../../helper/service-helper";

export interface CloudFrontS3WebSiteConstructProps extends cdk.StackProps {
    /**
     * The path to the build directory of the web site, relative to the project root
     * ex: "./app/build"
     */
    config: Config.Config;
    webSiteBuildPath: string;
    webAcl: string;
    apiUrl: string;
    assetBucketUrl: string;
    cognitoDomain: string;
}

/**
 * Default input properties
 */
const defaultProps: Partial<CloudFrontS3WebSiteConstructProps> = {
    stackName: "",
    env: {},
};

/**
 * Deploys a static website to s3 with a cloud front distribution.
 * Creates:
 * - S3 bucket
 * - CloudFrontDistribution
 * - OriginAccessIdentity
 *
 * On redeployment, will automatically invalidate the CloudFront distribution cache
 */
export class CloudFrontS3WebSiteConstruct extends Construct {
    /**
     * The origin access identity used to access the S3 website
     */
    public originAccessIdentity: cloudfront.OriginAccessIdentity;

    /**
     * The cloud front distribution to attach additional behaviors like `/api`
     */
    public cloudFrontDistribution: cloudfront.Distribution;

    public endPointURL: string;
    public webAppBucketName: string;

    constructor(parent: Construct, name: string, props: CloudFrontS3WebSiteConstructProps) {
        super(parent, name);

        props = { ...defaultProps, ...props };

        const accessLogsBucket = new s3.Bucket(this, "AccessLogsBucket", {
            encryption: s3.BucketEncryption.S3_MANAGED,
            serverAccessLogsPrefix: "web-app-access-log-bucket-logs/",
            versioned: true,
            blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
            objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
        });
        requireTLSAddToResourcePolicy(accessLogsBucket);

        accessLogsBucket.addLifecycleRule({
            enabled: true,
            expiration: Duration.days(3650),
        });

        // When using Distribution, do not set the s3 bucket website documents
        // if these are set then the distribution origin is configured for HTTP communication with the
        // s3 bucket and won't configure the cloudformation correctly.
        const siteBucket = new s3.Bucket(this, "WebApp", {
            // websiteIndexDocument: "index.html",
            // websiteErrorDocument: "index.html",
            encryption: s3.BucketEncryption.S3_MANAGED,
            autoDeleteObjects: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            serverAccessLogsBucket: accessLogsBucket,
            serverAccessLogsPrefix: "web-app-access-log-bucket-logs/",
            blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
            objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
        });
        requireTLSAddToResourcePolicy(siteBucket);

        const originAccessIdentity = new cloudfront.OriginAccessIdentity(
            this,
            "OriginAccessIdentity"
        );
        siteBucket.grantRead(originAccessIdentity);

        const s3origin = new cloudfrontOrigins.S3Origin(siteBucket, {
            originAccessIdentity: originAccessIdentity,
        });

        const connectSrc = [
            "'self'",
            "blob:",
            props.cognitoDomain,
            `https://${Service("COGNITO_IDP").Endpoint}/`,
            `https://${Service("COGNITO_IDENTITY").Endpoint}/`,
            `https://${props.apiUrl}`,
            `https://${props.assetBucketUrl}`,
            `https://maps.${Service("GEO").Endpoint}/`,
        ];

        const scriptSrc = [
            "'self'",
            "blob:",
            "'sha256-fUpTbA+CO0BMxLmoVHffhbh3ZTLkeobgwlFl5ICCQmg='", // script in index.html
            props.cognitoDomain,
            `https://${Service("COGNITO_IDP").Endpoint}/`,
            `https://${Service("COGNITO_IDENTITY").Endpoint}/`,
            `https://${props.apiUrl}`,
            `https://${props.assetBucketUrl}`,
        ];

        const responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(
            this,
            "ResponseHeadersPolicy",
            {
                securityHeadersBehavior: {
                    strictTransportSecurity: {
                        accessControlMaxAge: Duration.days(365 * 2),
                        includeSubdomains: true,
                        override: true,
                    },
                    xssProtection: {
                        override: true,
                        protection: true,
                        modeBlock: true,
                    },
                    frameOptions: {
                        frameOption: cloudfront.HeadersFrameOption.SAMEORIGIN,
                        override: true,
                    },
                    contentTypeOptions: {
                        override: true,
                    },
                    contentSecurityPolicy: {
                        contentSecurityPolicy:
                            `default-src 'none'; style-src 'self' 'unsafe-inline'; ` +
                            `connect-src ${connectSrc.join(" ")}; ` +
                            `script-src ${scriptSrc.join(" ")}; ` +
                            `img-src 'self' blob: data: https://${props.assetBucketUrl}; ` +
                            `media-src 'self' blob: data: https://${props.assetBucketUrl}; ` +
                            `object-src 'none'; ` +
                            `frame-ancestors 'none'; font-src 'self'; ` +
                            `manifest-src 'self'`,
                        override: true,
                    },
                },
            }
        );

        const cloudFrontDistribution = new cloudfront.Distribution(this, "WebAppDistribution", {
            defaultBehavior: {
                compress: true,
                responseHeadersPolicy: {
                    responseHeadersPolicyId: responseHeadersPolicy.responseHeadersPolicyId,
                },
                origin: s3origin,
                cachePolicy: new cloudfront.CachePolicy(this, "CachePolicy", {
                    defaultTtl: cdk.Duration.hours(1),
                }),
                allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            },

            errorResponses: [
                {
                    httpStatus: 404,
                    ttl: cdk.Duration.hours(0),
                    responseHttpStatus: 200,
                    responsePagePath: "/index.html",
                },
            ],
            defaultRootObject: "index.html",
            webAclId: props.webAcl != "" ? props.webAcl : undefined,
            minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021, // Required by security
            enableLogging: true,
            logBucket: accessLogsBucket,
            logFilePrefix: "cloudfront-access-logs/",
        });

        new s3deployment.BucketDeployment(this, "DeployWithInvalidation", {
            sources: [s3deployment.Source.asset(props.webSiteBuildPath)],
            destinationBucket: siteBucket,
            distribution: cloudFrontDistribution, // this assignment, on redeploy, will automatically invalidate the cloudfront cache
            distributionPaths: ["/*"],
            memoryLimit: 1024,
        });

        //Nag supressions
        NagSuppressions.addResourceSuppressions(
            cloudFrontDistribution,
            [
                {
                    id: "AwsSolutions-CFR4",
                    reason: "This requires use of a custom viewer certificate which should be provided by customers.",
                },
            ],
            true
        );

        // export any cf outputs
        new cdk.CfnOutput(this, "WebAppBucket", { value: siteBucket.bucketName });
        new cdk.CfnOutput(this, "CloudFrontDistributionId", {
            value: cloudFrontDistribution.distributionId,
        });
        new cdk.CfnOutput(this, "CloudFrontDistributionDomainName", {
            value: cloudFrontDistribution.distributionDomainName,
        });

        new cdk.CfnOutput(this, "CloudFrontDistributionUrl", {
            value: `https://${cloudFrontDistribution.distributionDomainName}`,
        });
        // assign public properties
        this.originAccessIdentity = originAccessIdentity;
        this.cloudFrontDistribution = cloudFrontDistribution;
        this.endPointURL = `https://${cloudFrontDistribution.distributionDomainName}`;
        this.webAppBucketName = siteBucket.bucketName;
    }
}

/**
 * Adds a proxy route from CloudFront /api to the api gateway url
 *
 * Deploys Api gateway (proxied through a CloudFront distribution at route `/api` if deploying through cloudfront)
 *
 * Any Api's attached to the gateway should be located at `/api/*` so that requests are correctly proxied.
 * Make sure Api's return the header `"Cache-Control" = "no-cache, no-store"` or CloudFront will cache responses
 *
 */
export function addBehaviorToCloudFrontDistribution(
    scope: Construct,
    cloudFrontDistribution: cloudfront.Distribution,
    apiUrl: string
) {
    cloudFrontDistribution.addBehavior(
        "/api/*",
        new cloudfrontOrigins.HttpOrigin(apiUrl, {
            originSslProtocols: [cloudfront.OriginSslPolicy.TLS_V1_2],
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        }),
        {
            cachePolicy: new cloudfront.CachePolicy(scope, "CachePolicy", {
                // required or CloudFront will strip the Authorization token from the request.
                // must be in the cache policy
                headerBehavior: cloudfront.CacheHeaderBehavior.allowList("Authorization"),
                enableAcceptEncodingGzip: true,
            }),
            originRequestPolicy: new cloudfront.OriginRequestPolicy(scope, "OriginRequestPolicy", {
                // required or CloudFront will strip all query strings off the request
                queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
            }),
            allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        }
    );
}
