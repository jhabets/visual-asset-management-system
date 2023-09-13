#!/usr/bin/env node

/*
 * Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
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
import * as Service from '../lib/helper/service-helper';

const app = new cdk.App();


//Set stack configuration
const config = Config.getConfig(app);
Service.SetConfig(config);

console.log("DEPLOYMENT CONFIGURATION 👉", config);

//console.log(Service.Service("EC2").ARN("role", "*VAMS*"));
//console.log(Service.Service("EC2").Principal);
//console.log(Service.Service("EC2").Endpoint);

if (config.enableCdkNag) {
    Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
}

//Deploy web access firewall to us-east-1 for cloudfront or in-region for non-cloudfront (ALB) deployments
const wafRegion = config.app.useAlb.enabled? config.env.region : "us-east-1" ;
const wafScope = config.app.useAlb.enabled? WAFScope.REGIONAL : WAFScope.CLOUDFRONT;

//The web access firewall
const wafStackName = `${config.name}-waf-${config.app.baseStackName || process.env.DEPLOYMENT_ENV || "dev"}`;
const cfWafStack = new CfWafStack(app, wafStackName, {
    stackName: wafStackName,
    env: {
        account: config.env.account,
        region: wafRegion,
    },
    wafScope: wafScope,
});

const vamsStackName = `${config.name}-${config.app.baseStackName || process.env.DEMO_LABEL || "dev"}`;
const vamsStack = new VAMS(app, vamsStackName, {
    stackName: vamsStackName,
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
