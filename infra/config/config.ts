/* eslint-disable @typescript-eslint/no-unused-vars */
/*
 * Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import { RemovalPolicy } from 'aws-cdk-lib';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as dotenv from 'dotenv';
import * as cdk from "aws-cdk-lib";


dotenv.config();

export function getConfig(
    app: cdk.App,
): Config {

	const file: string = readFileSync(join(__dirname, 'config.json'), {
		encoding: 'utf8',
		flag: 'r',
	});

	const configPublic: ConfigPublic = JSON.parse(file);
	const config:Config = <Config>configPublic;

	//Debugging Variables
	config.dockerDefaultPlatform = <string>process.env.DOCKER_DEFAULT_PLATFORM;
	config.enableCdkNag = false;

	//Main Variables (Parameter fall-back chain: context -> config file -> environment variables -> other fallback)
	config.env.account = <string>(config.env.account || process.env.CDK_DEFAULT_ACCOUNT);
	config.env.region = <string>(app.node.tryGetContext("region") || config.env.region || process.env.CDK_DEFAULT_REGION || "us-east-1");
	config.app.baseStackName = (app.node.tryGetContext("stack-name") || config.app.baseStackName || process.env.STACK_NAME) + "-" + config.env.region;
	config.app.stagingBucketName = <string>(app.node.tryGetContext("staging-bucket") || config.app.stagingBucketName || process.env.STAGING_BUCKET);
	config.app.adminEmailAddress = <string>(app.node.tryGetContext("adminEmailAddress") || config.app.adminEmailAddress || process.env.ADMIN_EMAIL_ADDRESS);
	config.app.useFips = <boolean>(app.node.tryGetContext("useFips") || process.env.AWS_USE_FIPS_ENDPOINT || config.app.govCloud.enabled || false);

	//If we are govCloud, we always use FIPS, ALB deploy, and disable opensearch serverless + location service (currently not supported in GovCloud 08-29-2023)
	if(config.app.govCloud.enabled) {
		config.app.useFips = true;
		config.app.useAlb.enabled = true;
		config.app.useOpenSearchServerless.enabled = false;
		config.app.useLocationService.enabled = false;
	}

	//Any configuration error checks
	if(config.app.useAlb.enabled && (config.app.useAlb.certificateARN == "UNDEFINED" || config.app.useAlb.domainHost == "UNDEFINED")) {
		throw new Error("Cannot use ALB deployment without specifying a valid domain hostname and a ACM Certificate ARN to use for SSL/TLS security!");
	}

	if(config.app.adminEmailAddress == '' || config.app.adminEmailAddress == 'UNDEFINED') {
		throw new Error("Must specify an initial admin email address as part of this deployment configuration!");
	}

	//Todo: Implement error check when implementing multiple auth providers that only 1 is enabled

	return config;
}

//Public config values that should go into a configuration file
export interface ConfigPublic {
	name: string;
	env: {
		account: string;
		region: string;
	};
	//removalPolicy: RemovalPolicy;
	//autoDelete: boolean;
	app: {
		baseStackName: string;
		stagingBucketName: string;	
		adminEmailAddress: string;
		useFips: boolean;
		govCloud: {
			enabled: boolean;
		};
		useOpenSearchServerless: {
			enabled: boolean;
		};
		useLocationService: {
			enabled: boolean;
		};
		useAlb: {
			enabled: boolean;
			publicSubnet: boolean;
			vpcCidrRange: string;
			domainHost: string;
			certificateARN: string;
			optionalHostedZoneID: string;
		};
		pipelines: {
			usePointCloudVisualization: {
				enabled: boolean;
			}
		}
		authProvider: {
			useCognito: {
				enabled: boolean;
				useSaml: boolean;
			}
		}
	};
}

//Internal variables to add to config that should not go into a normal config file (debugging only)
export interface Config extends ConfigPublic {
	enableCdkNag: boolean;
	dockerDefaultPlatform: string;
}
