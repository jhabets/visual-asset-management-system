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
import { Aspects, Annotations } from "aws-cdk-lib";
import { WAFScope } from "../lib/constructs/wafv2-basic-construct";
import * as Config from '../config/config';

const app = new cdk.App();

//Set stack configuration
const config = Config.getConfig(app);

console.log("DEPLOYMENT CONFIGURATION 👉", config);

if (config.enableCdkNag) {
    Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
}

//Deploy web access firewall to us-east-1 for cloudfront or in-region for non-cloudfront deployments
const wafRegion = config.app.govCloud.enabled? config.env.region : "us-east-1" ;
const wafScope = config.app.govCloud.enabled? WAFScope.REGIONAL : WAFScope.CLOUDFRONT;

//The web access firewall
const cfWafStack = new CfWafStack(app, `${config.name}-waf-${config.app.baseStackName || process.env.DEMO_LABEL || "dev"}`, {
    stackName: `vams-waf-${config.app.baseStackName || process.env.DEPLOYMENT_ENV || "dev"}`,
    env: {
        account: config.env.account,
        region: wafRegion,
    },
    wafScope: wafScope,
});

const vamsStack = new VAMS(app, `${config.name}-${config.app.baseStackName || process.env.DEMO_LABEL || "dev"}`, {
    stackName: `${config.name}-${config.app.baseStackName || process.env.DEPLOYMENT_ENV || "dev"}`,
    env: {
        account: config.env.account,
        region: config.env.region,
    },
    ssmWafArnParameterName: cfWafStack.ssmWafArnParameterName,
    ssmWafArnParameterRegion: cfWafStack.region,
    ssmWafArn: cfWafStack.wafArn,
    config: config
});

vamsStack.addDependency(cfWafStack);

app.synth();
