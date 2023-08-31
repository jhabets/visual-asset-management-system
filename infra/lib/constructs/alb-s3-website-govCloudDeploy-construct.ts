/*
 * Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as s3 from "aws-cdk-lib/aws-s3";
import { BlockPublicAccess } from "aws-cdk-lib/aws-s3";
import * as s3deployment from "aws-cdk-lib/aws-s3-deployment";
import * as cdk from "aws-cdk-lib";
import { Duration, Stack } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as iam from "aws-cdk-lib/aws-iam";
import { requireTLSAddToResourcePolicy } from "../security";
import * as logs from 'aws-cdk-lib/aws-logs';
import { aws_wafv2 as wafv2 } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { CfnLoadBalancer } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elbv2_targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import customResources = require('aws-cdk-lib/custom-resources');
import * as route53 from "aws-cdk-lib/aws-route53";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53targets from "aws-cdk-lib/aws-route53-targets";
//import { ReverseProxyGovCloudDeployConstruct } from "./nested/reverseProxy-govCloudDeploy-construct";
import { NagSuppressions } from "cdk-nag";

export interface AlbS3WebsiteGovCloudDeployConstructProps extends cdk.StackProps {
    /**
     * The path to the build directory of the web site, relative to the project root
     * ex: "./app/build"
     */
    artefactsBucket: s3.IBucket;
    domainHostName: string;
    webSiteBuildPath: string;
    webAcl: string;
    apiUrl: string;
    vpc: ec2.Vpc;
    subnets: ec2.ISubnet[];
    setupPublicAccess: boolean;
    acmCertARN: string;
    optionalHostedZoneId: string;
}

/**
 * Default input properties
 */
const defaultProps: Partial<AlbS3WebsiteGovCloudDeployConstructProps> = {
    stackName: "",
    env: {},
};

/**
 * Deploys a static website to s3 with a ALB distribution for GovCloud deployments.
 * Creates:
 * - S3 bucket
 * - ALB
 *
 */
export class AlbS3WebsiteGovCloudDeployConstruct extends Construct {

    /**
     * Returns the ALB URL instance for the static webpage
     */
    public websiteUrl: string;

    constructor(parent: Construct, name: string, props: AlbS3WebsiteGovCloudDeployConstructProps) {
        super(parent, name);

        props = { ...defaultProps, ...props };

        const accessLogsBucket = new s3.Bucket(this, "AccessLogsBucket", {
            encryption: s3.BucketEncryption.S3_MANAGED,
            serverAccessLogsPrefix: "web-app-access-log-S3bucket-logs/",
            versioned: true,
            blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
            objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
        });
        requireTLSAddToResourcePolicy(accessLogsBucket);

        accessLogsBucket.addLifecycleRule({
            enabled: true,
            expiration: Duration.days(3650),
        });

        //Setup S3 WebApp Distro bucket (public website contents) with the name that matches the deployed domain hostname (in order to work with the ALB/Endpoint)
        //Note: Bucket name must match final domain name for the ALB/VPCEndpoint architecture to work as ALB does not support host/path rewriting
        const webAppBucket = new s3.Bucket(this, "WebAppBucket", {
            bucketName: props.domainHostName,
            encryption: s3.BucketEncryption.S3_MANAGED,
            autoDeleteObjects: true,
            versioned: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            serverAccessLogsBucket: accessLogsBucket,
            serverAccessLogsPrefix: "web-app-access-log-bucket-logs/",
            blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
            objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
        });
        requireTLSAddToResourcePolicy(webAppBucket);

        //Use provided ACM certificate
        const acmDomainCertificate = acm.Certificate.fromCertificateArn(this, 'DomainCertificateImported', props.acmCertARN);

        //Create ALB security group and open to any IP on port 443/80
        const webAppALBSecurityGroup = new ec2.SecurityGroup(
            this,
            "WepAppDistroALBSecurityGroup",
            {
                vpc: props.vpc,
                allowAllOutbound: true,
                description: "Web Application Distribution for ALB Security Group",
            }
        );

        webAppALBSecurityGroup.connections.allowFromAnyIpv4(ec2.Port.tcp(80))
        webAppALBSecurityGroup.connections.allowFromAnyIpv4(ec2.Port.tcp(443))

        // Create an ALB
        const alb = new elbv2.ApplicationLoadBalancer(this, 'WebAppDistroALB', {
            loadBalancerName: `${props.stackName}-WebAppALB`.substring(0, 32),
            internetFacing: props.setupPublicAccess,
            vpc: props.vpc,
            securityGroup: webAppALBSecurityGroup,

        });

        //Add access logging on ALB
        alb.logAccessLogs(accessLogsBucket,"web-app-access-log-alb-logs");


        // Add a listener to the ALB
        const listener = alb.addListener('WebAppDistroALBListener', {
            port: 443, // The port on which the ALB listens
            certificates: [acmDomainCertificate], // The certificate to use for the listener
        });


        //Setup target group to point to VPC Endpoint Interface
        const targetGroup1 = new elbv2.ApplicationTargetGroup(this, 'WebAppALBTargetGroup', {
            port: 443,
            vpc: props.vpc,
            targetType: elbv2.TargetType.IP,
            healthCheck: {
            enabled: true,
            healthyHttpCodes: "200,307,405" //These are the health codes we will see returned from VPCEndpointInterface<->S3
            }
        });

        //Create VPC Endpoint for ALB-<->S3 Comms
        const webAppVPCESecurityGroup = new ec2.SecurityGroup(
            this,
            "WepAppDistroVPCS3EndpointSecurityGroup",
            {
                vpc: props.vpc,
                allowAllOutbound: true,
                description: "Web Application Distribution for VPC S3 Endpoint Security Group",
            }
        );

        //TODO: Figure out why an extra rule is getting added to allow all HTTPS inbound traffic from the VPC CIDR
        //Add ingress rules (HTTP/HTTPS) to VPC Endpoint security group
        webAppVPCESecurityGroup.connections.allowFrom(alb, ec2.Port.tcp(443))
        webAppVPCESecurityGroup.connections.allowFrom(alb, ec2.Port.tcp(80))

        // Create VPC interface endpoint for S3 (Needed for ALB<->S3)
        const s3VPCEndpoint = new ec2.InterfaceVpcEndpoint(this, "S3InterfaceVPCEndpoint", {
            vpc: props.vpc,
            privateDnsEnabled: false, 
            service: ec2.InterfaceVpcEndpointAwsService.S3,
            subnets: { subnetType: props.setupPublicAccess? ec2.SubnetType.PUBLIC : undefined},
            securityGroups: [webAppVPCESecurityGroup],
        });

        //TODO: Figure out why this policy is not working and still letting requests through for other bucket names (use ALB dns name to test)
        //TODO?: Specifically add a deny policy for anything outside of bucket
        //Add policy to VPC endpoint to only allow access to the specific S3 Bucket
        s3VPCEndpoint.addToPolicy(new iam.PolicyStatement({
            resources: [
            webAppBucket.arnForObjects("*"), 
            webAppBucket.bucketArn],
            actions: ["s3:Get*", "s3:List*"],
            principals: [new iam.AnyPrincipal()],
        }))

        //Create custom resource to get IP of Interface Endpoint (CDK doesn't support getting the IP directly)
        //https://repost.aws/questions/QUjISNyk6aTA6jZgZQwKWf4Q/how-to-connect-a-load-balancer-and-an-interface-vpc-endpoint-together-using-cdk 
        for (let index = 0; index < props.vpc.availabilityZones.length; index++) {
            const getEndpointIp = new customResources.AwsCustomResource(this, `WebAppGetEndpointIP${index}`, {
                installLatestAwsSdk: false,
                onCreate: {
                    service: "EC2",
                    action: "describeNetworkInterfaces",
                    outputPaths: [`NetworkInterfaces.${index}.PrivateIpAddress`],
                    parameters: {NetworkInterfaceIds: s3VPCEndpoint.vpcEndpointNetworkInterfaceIds,},
                    physicalResourceId: customResources.PhysicalResourceId.of(Date.now().toString()),
                },
                onUpdate: {
                    service: 'EC2',
                    action: 'describeNetworkInterfaces',
                    outputPaths: [`NetworkInterfaces.${index}.PrivateIpAddress`],
                    parameters: { NetworkInterfaceIds: s3VPCEndpoint.vpcEndpointNetworkInterfaceIds },
                    physicalResourceId: customResources.PhysicalResourceId.of(Date.now().toString()),
                },
                policy: {
                    statements: [
                    new iam.PolicyStatement({
                        actions: ["ec2:DescribeNetworkInterfaces"],
                        resources: ["*"],
                    }),
                    ],
                },
            });
            targetGroup1.addTarget(new elbv2_targets.IpTarget(getEndpointIp.getResponseField(`NetworkInterfaces.${index}.PrivateIpAddress`)));
        }

        listener.addTargetGroups("WebAppTargetGroup1", {
            targetGroups: [targetGroup1],
        })

        // //Create ASG Reverse Proxy Security Group
        // const webAppASGESecurityGroup = new ec2.SecurityGroup(
        //     this,
        //     "WepAppDistroVPCS3EndpointSecurityGroup",
        //     {
        //         vpc: props.vpc,
        //         allowAllOutbound: true,
        //         description: "Web Application Distribution for VPC S3 Endpoint Security Group",
        //     }
        // );

        // //Create Reverse Proxy Template + ASG
		// const reverseProxyResources = new ReverseProxyGovCloudDeployConstruct(this, 'ReverseProxyGovCloudDeployConstruct', {
		// 	artefactsBucket: props.artefactsBucket,
        //     webAppBucket: webAppBucket,
        //     arnBaseIdentifier: props.arnBaseIdentifier,
        //     domainHostName: props.domainHostName,
		// 	vpc: props.vpc,
		// 	subnets: props.subnets.reverseProxy,
		// 	securityGroup: webAppASGESecurityGroup,
		// });

        // //Set ASG as ALB target group
        // const targetGroupASG = new elbv2.ApplicationTargetGroup(this, 'WebAppALBTargetGroup', {
        //     port: 80,
        //     vpc: props.vpc,
        //     targetType: elbv2.TargetType.IP,
        //     healthCheck: {
        //     enabled: true,
        //     healthyHttpCodes: "200"
        //     }
        // });

        // targetGroupASG.addTarget(reverseProxyResources.autoScalingGroup);

        // listener.addTargetGroups("WebAppTargetGroupASG", {
        //     targetGroups: [targetGroupASG],
        // })
        

        //Setup listener rule to rewrite path to forward to API Gateway for backend API calls
        const applicationListenerRuleBackendAPI= new elbv2.ApplicationListenerRule(this, 'WebAppnListenerRuleBackendAPI', {
            listener: listener,
            priority: 1,
            action: elbv2.ListenerAction.redirect({
                host: `${props.apiUrl}`,
                port: "443",
                protocol: "HTTPS",
                permanent: true,
            }),
            conditions: [elbv2.ListenerCondition.pathPatterns(['/api*'])],
        });

        //Setup listener rule to rewrite path to forward to API Gateway for backend API calls
        const applicationListenerRuleBackendSecureConfig= new elbv2.ApplicationListenerRule(this, 'WebAppnListenerRuleBackendSecureConfig', {
            listener: listener,
            priority: 2,
            action: elbv2.ListenerAction.redirect({
                host: `${props.apiUrl}`,
                port: "443",
                protocol: "HTTPS",
                permanent: true,
            }),
            conditions: [elbv2.ListenerCondition.pathPatterns(['/secure-config*'])],
        });

        //Setup listener rule to forward index.html to S3
        const applicationListenerRuleBackendIndex= new elbv2.ApplicationListenerRule(this, 'WebAppnListenerRuleBackendIndex', {
            listener: listener,
            priority: 3,
            targetGroups: [targetGroup1],
            conditions: [elbv2.ListenerCondition.pathPatterns(['/index.html*'])],
        });

        //Setup listener rule to forward individual file requests to S3
        const applicationListenerRuleBackendIndividualFile= new elbv2.ApplicationListenerRule(this, 'WebAppnListenerRuleBackendIndividualFile', {
            listener: listener,
            priority: 4,
            targetGroups: [targetGroup1],
            conditions: [elbv2.ListenerCondition.pathPatterns(['*/*.*'])],
        });

        //Setup listener rule to rewrite path to forward to index.html for a no path route
        const applicationListenerRuleBaseRoute = new elbv2.ApplicationListenerRule(this, 'WebAppnListenerRuleBaseRoute', {
            listener: listener,
            priority: 5,
            action: elbv2.ListenerAction.redirect({
                path: "/#{path}index.html",
                permanent: false,
            }),
            conditions: [elbv2.ListenerCondition.pathPatterns(['*/'])],
        });

        //Setup listener rule to rewrite path to forward to index.html for any other (no file) path route
        const applicationListenerRuleOtherRoute = new elbv2.ApplicationListenerRule(this, 'WebAppnListenerRuleOtherRoute', {
            listener: listener,
            priority: 6,
            action: elbv2.ListenerAction.redirect({
                path: "/index.html",
                permanent: false,
            }),
            conditions: [elbv2.ListenerCondition.pathPatterns(['/*'])],
        });

        // Enable a ALB redirect from port 80 to 443
        alb.addRedirect()

        // //Optional: Add alias to ALB if hosted zone ID provided (must match domain root of provided domain host)
        if(props.optionalHostedZoneId != "" && props.optionalHostedZoneId != "UNDEFINED") {
            const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'ExistingRoute53HostedZone', {
                zoneName: props.domainHostName.substring(props.domainHostName.indexOf(".")+1, props.domainHostName.length),
                hostedZoneId: props.optionalHostedZoneId, 
            });

            // Add a Route 53 alias with the Load Balancer as the target (using sub-domain in provided domain host)
            new route53.ARecord(this, "WebAppALBAliasRecord", {
                zone: zone,
                recordName: `${props.domainHostName}.`,
                target: route53.RecordTarget.fromAlias(
                new route53targets.LoadBalancerTarget(alb)
                ),
            });
        }

        //Associate WAF to ALB
        const cfnWebACLAssociation = new wafv2.CfnWebACLAssociation(this,'WebAppWAFAssociation', {
        resourceArn: alb.loadBalancerArn,
        webAclArn: props.webAcl,
        });

        //Deploy website to Bucket
        new s3deployment.BucketDeployment(this, "DeployWithInvalidation", {
            sources: [s3deployment.Source.asset(props.webSiteBuildPath)],
            destinationBucket: webAppBucket,
            memoryLimit: 1024,
        });

        //Add Bucket policy to only allow read access from VPC Endpoint
        //TODO?: Specifically add a extra deny policy for anything outside of VPCE
        const webAppBucketPolicy = new iam.PolicyStatement({
            resources: [
            webAppBucket.arnForObjects("*"), 
            webAppBucket.bucketArn],
            actions: ["s3:Get*", "s3:List*"],
            principals: [new iam.AnyPrincipal()]
            
        })

        webAppBucketPolicy.addCondition("StringEquals", {
            "aws:SourceVpce" : s3VPCEndpoint.vpcEndpointId
        })

        webAppBucket.addToResourcePolicy(webAppBucketPolicy);


        // assign public properties 
        this.websiteUrl = `https://${props.domainHostName}`;

        new cdk.CfnOutput(this, "webAppAlbDns", {
            value: alb.loadBalancerDnsName, 
        });

        new cdk.CfnOutput(this, "webDistributionUrl", {
            value: this.websiteUrl, 
        });

        // export any cf outputs
        new cdk.CfnOutput(this, "webAppBucket", { value: webAppBucket.bucketName });

        //Nag Supressions
        NagSuppressions.addResourceSuppressions(
            webAppVPCESecurityGroup,
            [
                {
                    id: "AwsSolutions-EC23",
                    reason: "Web App VPC Endpoint Security Group is restricted to ALB on ports 443 and 80.",
                },
                {
                    id: "CdkNagValidationFailure",
                    reason: "Validation failure due to inherent nature of CDK Nag Validations of CIDR ranges", //https://github.com/cdklabs/cdk-nag/issues/817
                },
            ]
        );

        NagSuppressions.addResourceSuppressions(
            webAppALBSecurityGroup,
            [
                {
                    id: "AwsSolutions-EC23",
                    reason: "Web App ALB Security Group is purposely left open to any IP (0.0.0.0) on port 443 and 80 as this is the public website entry point",
                }
            ]
        );

    }
}
