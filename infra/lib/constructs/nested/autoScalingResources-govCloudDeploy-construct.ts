/*
 * Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import { Construct } from 'constructs';
import { Stack, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { NagSuppressions } from 'cdk-nag';

export interface AutoScalingResourcesGovCloudDeployConstructProps {
	name: string;
	vpcResources: {
		vpc: ec2.Vpc;
		subnets: ec2.ISubnet[];
	};
	launchTemplate: ec2.LaunchTemplate;
	capacity: {
		min: number;
		max: number;
	};
	instanceUserData: string;
}

export class AutoScalingResourcesGovCloudDeployConstruct extends Construct {
	public readonly autoScalingGroup: autoscaling.AutoScalingGroup;

	constructor(scope: Construct, id: string, props: AutoScalingResourcesGovCloudDeployConstructProps) {
		super(scope, id);

		const region: string = Stack.of(this).region;
		const account: string = Stack.of(this).account;

		this.autoScalingGroup = new autoscaling.AutoScalingGroup(
			this,
			`${props.name}AutoScalingGroup`,
			{
				vpc: props.vpcResources.vpc,
				vpcSubnets: { subnets: props.vpcResources.subnets },
				associatePublicIpAddress: false,
				minCapacity: props.capacity.min,
				maxCapacity: props.capacity.max,
				launchTemplate: props.launchTemplate,
				updatePolicy: autoscaling.UpdatePolicy.replacingUpdate(),
				healthCheck: autoscaling.HealthCheck.ec2({ grace: Duration.minutes(1) }),
			}
		);

		if(props.instanceUserData != ""){
			this.autoScalingGroup.addUserData(props.instanceUserData)
		}


		NagSuppressions.addResourceSuppressions(
			this.autoScalingGroup,
			[
				{
					id: 'AwsSolutions-AS3',
					reason:
						'Autoscaling Event notifications: Backlogged',
				},
			],
			true
		);
	}
}
