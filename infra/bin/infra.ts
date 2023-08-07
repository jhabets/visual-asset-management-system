#!/usr/bin/env node

/*
 * Copyright 2022 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { VAMS } from "../lib/infra-stack";
import { CfWafStack } from "../lib/cf-waf-stack";
import { AwsSolutionsChecks } from "cdk-nag";
import { Aspects } from "aws-cdk-lib";
import { WAFScope } from "../lib/constructs/wafv2-basic-construct";

const app = new cdk.App();

/** development variables **/
const region = process.env.AWS_REGION || app.node.tryGetContext("region") || "us-east-1";
const stackName = (process.env.STACK_NAME || app.node.tryGetContext("stack-name")) + "-" + region;
const dockerDefaultPlatform = process.env.DOCKER_DEFAULT_PLATFORM;
const enableCdkNag = true;
const stagingBucket = process.env.STAGING_BUCKET || app.node.tryGetContext("staging-bucket");

///Setup optional configurations
//Deploy VAMS on GovCloud (swap out Cloudfront for an ALB, use FIPS end-points, exclude other non-govcloud services/features)
const govCloudDeployment = (process.env.GOVCLOUD_DEPLOYMENT || app.node.tryGetContext("govCloudDeployment")) === "true";
const govCloudDeploymentHostDomain = (process.env.GOVCLOUD_DEPLOYMENT_HOSTDOMAIN || app.node.tryGetContext("govCloudDeploymentHostDomain") || `vams.${stackName}.com`);
const govCloudDeploymentPublicAccess = (process.env.GOVCLOUD_DEPLOYMENT_PUBLICACCESS || app.node.tryGetContext("govCloudDeploymentPublicAccess")) === "true";


console.log("CDK_NAG_ENABLED 👉", enableCdkNag);
console.log("STACK_NAME 👉", stackName);
console.log("REGION 👉", region);
console.log("DOCKER_DEFAULT_PLATFORM 👉", dockerDefaultPlatform);
if (stagingBucket) {
    console.log("STAGING_BUCKET 👉", stagingBucket);
}
console.log("GOVCLOUD_DEPLOYMENT 👉", govCloudDeployment);

if (enableCdkNag) {
    Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
}

//Deploy web access firewall to us-east-1 for cloudfront or in-region for non-cloudfront deployments
const wafRegion = govCloudDeployment? region : "us-east-1" ;
const wafScope = govCloudDeployment? WAFScope.REGIONAL : WAFScope.CLOUDFRONT;

//The web access firewall
const cfWafStack = new CfWafStack(app, `vams-waf-${stackName || process.env.DEMO_LABEL || "dev"}`, {
    stackName: `vams-waf-${stackName || process.env.DEPLOYMENT_ENV || "dev"}`,
    env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: wafRegion,
    },
    wafScope: wafScope,
});


const vamsStack = new VAMS(app, `vams-${stackName || process.env.DEMO_LABEL || "dev"}`, {
    prod: false,
    stackName: `vams-${stackName || process.env.DEPLOYMENT_ENV || "dev"}`,
    env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: region,
    },
    ssmWafArnParameterName: cfWafStack.ssmWafArnParameterName,
    ssmWafArnParameterRegion: cfWafStack.region,
    ssmWafArn: cfWafStack.wafArn,
    stagingBucket: stagingBucket,
    govCloudDeployment: govCloudDeployment,
    govCloudDeploymentPublicAccess: govCloudDeploymentPublicAccess,
    govCloudDeploymentHostDomain: govCloudDeploymentHostDomain 
});

vamsStack.addDependency(cfWafStack);
//new VAMS(app, 'prod', {prod: true, stackName: 'vams--prod'});

app.synth();
