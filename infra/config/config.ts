/* eslint-disable @typescript-eslint/no-unused-vars */
/*
 * Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import { RemovalPolicy } from "aws-cdk-lib";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { readFileSync } from "fs";
import { join } from "path";
import * as dotenv from "dotenv";
import * as cdk from "aws-cdk-lib";

dotenv.config();

//Top level configurations
export const LAMBDA_PYTHON_RUNTIME = Runtime.PYTHON_3_10;
export const LAMBDA_NODE_RUNTIME = Runtime.NODEJS_18_X;
export const OPENSEARCH_VERSION = cdk.aws_opensearchservice.EngineVersion.OPENSEARCH_2_7;

export function getConfig(app: cdk.App): Config {
    const file: string = readFileSync(join(__dirname, "config.json"), {
        encoding: "utf8",
        flag: "r",
    });

    const configPublic: ConfigPublic = JSON.parse(file);
    const config: Config = <Config>configPublic;

    //Debugging Variables
    config.dockerDefaultPlatform = <string>process.env.DOCKER_DEFAULT_PLATFORM;
    config.enableCdkNag = true;

    console.log("Python Version: ", LAMBDA_PYTHON_RUNTIME.name);
    console.log("Node Version: ", LAMBDA_NODE_RUNTIME.name);

    //Main Variables (Parameter fall-back chain: context -> config file -> environment variables -> other fallback)
    config.env.account = <string>(app.node.tryGetContext("account") || config.env.account || process.env.CDK_DEFAULT_ACCOUNT);
    config.env.region = <string>(
        (app.node.tryGetContext("region") ||
            config.env.region ||
            process.env.CDK_DEFAULT_REGION ||
            "us-east-1")
    );
    config.app.baseStackName =
        (app.node.tryGetContext("stack-name") ||
            config.app.baseStackName ||
            process.env.STACK_NAME) +
        "-" +
        config.env.region;
    config.app.stagingBucketName = <string>(
        (app.node.tryGetContext("staging-bucket") ||
            config.app.stagingBucketName ||
            process.env.STAGING_BUCKET)
    );
    config.app.adminEmailAddress = <string>(
        (app.node.tryGetContext("adminEmailAddress") ||
            config.app.adminEmailAddress ||
            process.env.ADMIN_EMAIL_ADDRESS)
    );
    config.app.useFips = <boolean>(
        (app.node.tryGetContext("useFips") ||
            config.app.useFips ||
            process.env.AWS_USE_FIPS_ENDPOINT ||
            false)
    );
    config.app.useWaf = <boolean>(
        (app.node.tryGetContext("useWaf") || config.app.useWaf || process.env.AWS_USE_WAF || false)
    );
    config.env.loadContextIgnoreVPCStacks = <boolean>(
        (app.node.tryGetContext("loadContextIgnoreVPCStacks") ||
            config.env.loadContextIgnoreVPCStacks ||
            false)
    );

    //If we are govCloud, we always use Full VPC, ALB deploy, use OpenSearch Provisioned (serverless not available in GovCloud), and disable location service (currently not supported in GovCloud 08-29-2023)
    if (config.app.govCloud.enabled) {
        if (
            //!config.app.useFips ||
            !config.app.useGlobalVpc.enabled ||
            !config.app.useGlobalVpc.useForAllLambdas ||
            !config.app.useAlb.enabled ||
            config.app.openSearch.useProvisioned.enabled ||
            config.app.useLocationService.enabled
        ) {
            console.warn(
                "Configuration Warning: Due to GovCloud being enabled, auto-enabling Use Global VPC, use VPC For All Lambdas, Use ALB, Use OpenSearch Provisioned, and disable Use Location Services"
            );
        }

        //config.app.useFips = true; //not required for use in GovCloud. Some GovCloud endpoints are natively FIPS compliant regardless of this flag to use specific FIPS endpoints.
        config.app.useGlobalVpc.enabled = true;
        config.app.useGlobalVpc.useForAllLambdas = true; //FedRAMP best practices require all Lambdas/OpenSearch behind VPC
        config.app.useAlb.enabled = true;
        config.app.openSearch.useProvisioned.enabled = true;
        config.app.useLocationService.enabled = false;
    }

    //If using ALB, visualizer pipelines, or opensearch provisioned, make sure Global VPC is on as this needs to be in a VPC
    if (
        config.app.useAlb.enabled ||
        config.app.pipelines.usePointCloudVisualization.enabled ||
        config.app.openSearch.useProvisioned.enabled
    ) {
        if (!config.app.useGlobalVpc.enabled) {
            console.warn(
                "Configuration Warning: Due to ALB, Visualization Pipeline, or OpenSearch Provisioned being enabled, auto-enabling Use Global VPC flag"
            );
        }

        config.app.useGlobalVpc.enabled = true;
    }

    //Any configuration warnings/errors checks
    if (
        config.app.useGlobalVpc.enabled &&
        config.app.useGlobalVpc.optionalExternalVpcId &&
        !config.env.loadContextIgnoreVPCStacks
    ) {
        console.warn(
            "Configuration Notice: You have elected to import external VPCs/Subnets. If experiencing VPC/Subnet lookup errors, synethize your CDK first with the 'loadContextIgnoreVPCStacks' flag first."
        );
    }

    if (config.app.useGlobalVpc.enabled && !config.app.useGlobalVpc.addVpcEndpoints) {
        console.warn(
            "Configuration Warning: This configuration has disabled Add VPC Endpoints. Please manually ensure the VPC used has all nessesary VPC Interface Endpoints to ensure proper VAMS operations."
        );
    }

    if (config.app.useAlb.enabled && config.app.useAlb.usePublicSubnet) {
        console.warn(
            "Configuration Warning: YOU HAVE ENABLED ALB PUBLIC SUBNETS. THIS CAN EXPOSE YOUR STATIC WEBSITE SOLUTION TO THE PUBLIC INTERNET. PLEASE VERIFY THIS IS CORRECT."
        );
    }

    if (!config.app.useWaf) {
        console.warn(
            "Configuration Warning: YOU HAVE DISABLED USING WEB APPLICATION FIREWALL (WAF). ENSURE YOU HAVE OTHER FIREWALL MEASURES IN PLACE TO PREVENT ILLICIT NETWORK ACCESS. PLEASE VERIFY THIS IS CORRECT."
        );
    }

    if (
        config.app.useGlobalVpc.enabled &&
        (config.app.useGlobalVpc.vpcCidrRange == "UNDEFINED" ||
            config.app.useGlobalVpc.vpcCidrRange == "") &&
        (config.app.useGlobalVpc.optionalExternalVpcId == "UNDEFINED" ||
            config.app.useGlobalVpc.optionalExternalVpcId == "")
    ) {
        throw new Error(
            "Configuration Error: Must define either a global VPC Cidr Range or an External VPC ID."
        );
    }

    if (
        config.app.useGlobalVpc.enabled &&
        config.app.useGlobalVpc.optionalExternalVpcId != "UNDEFINED" &&
        config.app.useGlobalVpc.optionalExternalPrivateSubnetIds != ""
    ) {
        if (
            config.app.useGlobalVpc.optionalExternalPrivateSubnetIds == "UNDEFINED" ||
            config.app.useGlobalVpc.optionalExternalPrivateSubnetIds == ""
        ) {
            throw new Error(
                "Configuration Error: Must define at least one private subnet ID when using an External VPC ID."
            );
        }
    }

    if (
        config.app.useGlobalVpc.enabled &&
        config.app.useAlb.enabled &&
        config.app.useAlb.usePublicSubnet &&
        config.app.useGlobalVpc.optionalExternalVpcId != "UNDEFINED" &&
        config.app.useGlobalVpc.optionalExternalVpcId != ""
    ) {
        if (
            config.app.useGlobalVpc.optionalExternalPublicSubnetIds == "UNDEFINED" ||
            config.app.useGlobalVpc.optionalExternalPublicSubnetIds == ""
        ) {
            throw new Error(
                "Configuration Error: Must define at least one public subnet ID when using an External VPC ID and Public ALB configuration."
            );
        }
    }

    if (
        config.app.useAlb.enabled &&
        (config.app.useAlb.certificateArn == "UNDEFINED" ||
            config.app.useAlb.certificateArn == "" ||
            config.app.useAlb.domainHost == "UNDEFINED" ||
            config.app.useAlb.domainHost == "")
    ) {
        throw new Error(
            "Configuration Error: Cannot use ALB deployment without specifying a valid domain hostname and a ACM Certificate ARN to use for SSL/TLS security!"
        );
    }

    if (config.app.adminEmailAddress == "" || config.app.adminEmailAddress == "UNDEFINED") {
        throw new Error(
            "Configuration Error: Must specify an initial admin email address as part of this deployment configuration!"
        );
    }

    //Error check when implementing auth providers
    if (
        config.app.authProvider.useCognito.enabled &&
        config.app.authProvider.useExternalOathIdp.enabled
    ) {
        throw new Error("Configuration Error: Must specify only one authentication method!");
    }

    if (
        config.app.authProvider.useExternalOathIdp.enabled &&
        (config.app.authProvider.useExternalOathIdp.idpAuthProviderUrl == "UNDEFINED" ||
            config.app.authProvider.useExternalOathIdp.idpAuthProviderUrl == "")
    ) {
        throw new Error(
            "Configuration Error: Must specify a external IDP auth URL when using an external OATH provider!"
        );
    }

    return config;
}

//Public config values that should go into a configuration file
export interface ConfigPublic {
    name: string;
    env: {
        account: string;
        region: string;
        coreStackName: string; //Will get overwritten always when generated
        loadContextIgnoreVPCStacks: boolean;
    };
    //removalPolicy: RemovalPolicy;
    //autoDelete: boolean;
    app: {
        baseStackName: string;
        stagingBucketName: string;
        adminEmailAddress: string;
        useFips: boolean;
        useWaf: boolean;
        govCloud: {
            enabled: boolean;
        };
        useGlobalVpc: {
            enabled: boolean;
            useForAllLambdas: boolean;
            addVpcEndpoints: boolean;
            optionalExternalVpcId: string;
            optionalExternalPrivateSubnetIds: string;
            optionalExternalPublicSubnetIds: string;
            vpcCidrRange: string;
        };
        openSearch: {
            useProvisioned: {
                enabled: boolean;
            };
        };
        useLocationService: {
            enabled: boolean;
        };
        useAlb: {
            enabled: boolean;
            usePublicSubnet: boolean;
            domainHost: string;
            certificateArn: string;
            optionalHostedZoneId: string;
        };
        pipelines: {
            usePointCloudVisualization: {
                enabled: boolean;
            };
        };
        authProvider: {
            useCognito: {
                enabled: boolean;
                useSaml: boolean;
            };
            useExternalOathIdp: {
                enabled: boolean;
                idpAuthProviderUrl: string;
            };
        };
    };
}

//Internal variables to add to config that should not go into a normal config file (debugging only)
export interface Config extends ConfigPublic {
    enableCdkNag: boolean;
    dockerDefaultPlatform: string;
}
