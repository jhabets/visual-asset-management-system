/*
 * Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import { Construct } from 'constructs';
import { Stack, Tags } from 'aws-cdk-lib';
import { NagSuppressions } from 'cdk-nag';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as asg from 'aws-cdk-lib/aws-autoscaling';
import { AutoScalingResourcesGovCloudDeployConstruct } from './autoScalingResources-govCloudDeploy-construct';
import * as ReverseProxyEc2NginxUserData from '../../../config/reverseProxy/reverseProxyEc2NginxUserData';

export interface ReverseProxyGovCloudDeployConstructProps {
	artefactsBucket: s3.IBucket;
	webAppBucket: s3.IBucket;
	arnBaseIdentifier: string;
	domainHostName: string;
	vpc: ec2.Vpc;
	subnets: ec2.ISubnet[];
	securityGroup: ec2.SecurityGroup;
}

export class ReverseProxyGovCloudDeployConstruct extends Construct {
	public readonly autoScalingGroup: asg.AutoScalingGroup;

	constructor(scope: Construct, id: string, props: ReverseProxyGovCloudDeployConstructProps) {
		super(scope, id);

		const region: string = Stack.of(this).region;
		const account: string = Stack.of(this).account;
		const stackName: string = Stack.of(this).stackName;

		const instanceRole = new iam.Role(this, 'ReverseProxyInstanceRole', {
			assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
			description: 'EC2 Instance Role',
			managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
			inlinePolicies: {
				reverseProxyInstancePolicy: new iam.PolicyDocument({
					statements: [
						new iam.PolicyStatement({
							resources: [
								`${props.artefactsBucket.bucketArn}`,
								`${props.artefactsBucket.bucketArn}/*`,
								`${props.webAppBucket.bucketArn}/*`,
								`${props.webAppBucket.bucketArn}/*`,
							],
							actions: ['s3:ListBucket', 's3:GetObject'],
						}),
						new iam.PolicyStatement({
							actions: [
								'logs:CreateLogGroup',
								'logs:CreateLogStream',
								'logs:DescribeLogStreams',
								'logs:PutLogEvents',
							],
							resources: [`${props.arnBaseIdentifier}:logs:${region}:${account}:log-group:/aws/ssm/*`],
						}),
					],
				}),
			},
		});

		const ebsVolume: ec2.BlockDevice = {
			deviceName: '/dev/xvda',
			volume: ec2.BlockDeviceVolume.ebs(8, {
				encrypted: true,
			}),
		};

		const machineImage = ec2.MachineImage.latestAmazonLinux2();

		// --------------------------------------------------------------------
		// AUTO SCALING RESOURCES
		// --------------------------------------------------------------------
		const launchTemplate = new ec2.LaunchTemplate(this, 'ReverseProxyLaunchTemplate', {
			launchTemplateName: 'NginxReverseProxy',
			instanceType: new ec2.InstanceType('t3.medium'),
			blockDevices: [ebsVolume],
			role: instanceRole,
			securityGroup: props.securityGroup,
			machineImage: machineImage,
			detailedMonitoring: true,
			userData: ec2.UserData.forLinux(),
		});

		Tags.of(launchTemplate).add('Name', `${stackName}/ReverseProxyServer`);


		const webAppS3BucketURL = ""

		const autoScalingResources = new AutoScalingResourcesGovCloudDeployConstruct(
			this,
			'ReverseProxyAutoScalingResources',
			{
				name: 'ReverseProxy',
				vpcResources: {
					vpc: props.vpc,
					subnets: props.subnets,
				},
				launchTemplate: launchTemplate,
				capacity: {
					min: 1,
					max: 3,
				},
				instanceUserData: ReverseProxyEc2NginxUserData.getUserData(props.artefactsBucket.bucketName, props.domainHostName, webAppS3BucketURL)
			}
		);

		autoScalingResources.autoScalingGroup.scaleOnCpuUtilization('ReverseProxyScalingPolicy', {
			targetUtilizationPercent: 70,
		});

		this.autoScalingGroup = autoScalingResources.autoScalingGroup;

	}
}
