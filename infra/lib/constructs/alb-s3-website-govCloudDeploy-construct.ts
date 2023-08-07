/*
 * Copyright 2022 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

// import * as apigw from "@aws-cdk/aws-apigatewayv2-alpha";
// import * as ApiGateway from "aws-cdk-lib/aws-apigateway";
// import { IHttpRouteAuthorizer } from "@aws-cdk/aws-apigatewayv2-alpha";
// import * as apigwAuthorizers from "@aws-cdk/aws-apigatewayv2-authorizers-alpha";
import * as s3 from "aws-cdk-lib/aws-s3";
import { BlockPublicAccess } from "aws-cdk-lib/aws-s3";
import * as s3deployment from "aws-cdk-lib/aws-s3-deployment";
import * as cdk from "aws-cdk-lib";
import { Duration, Stack } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as iam from "aws-cdk-lib/aws-iam";
import { requireTLSAddToResourcePolicy } from "../security";
import * as logs from 'aws-cdk-lib/aws-logs';
//import { NagSuppressions } from "cdk-nag";
import { aws_wafv2 as wafv2 } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { CfnLoadBalancer } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elbv2_targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import customResources = require('aws-cdk-lib/custom-resources');
import * as route53 from "aws-cdk-lib/aws-route53";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53targets from "aws-cdk-lib/aws-route53-targets";

export interface AlbS3WebsiteGovCloudDeployConstructProps extends cdk.StackProps {
    /**
     * The path to the build directory of the web site, relative to the project root
     * ex: "./app/build"
     */
    domainHostName: string;
    webSiteBuildPath: string;
    webAcl: string;
    apiUrl: string;
    assetBucketUrl: string;
    cognitoDomain: string;
    vpc: ec2.Vpc;
    subnets: ec2.ISubnet[];
    securityGroups: ec2.SecurityGroup[];
    s3Endpoint: ec2.InterfaceVpcEndpoint;
    setupPublicAccess: boolean;
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

        //Setup S3 WebApp bucket with the name that matches the deployed domain hostname (in order to work with the ALB/Endpoint)
        const webAppBucket = new s3.Bucket(this, "WebAppBucket", {
            //websiteIndexDocument: "index.html",
            //websiteErrorDocument: "index.html",
            bucketName: props.domainHostName,
            encryption: s3.BucketEncryption.S3_MANAGED,
            autoDeleteObjects: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            serverAccessLogsBucket: accessLogsBucket,
            serverAccessLogsPrefix: "web-app-access-log-bucket-logs/",
            blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
            objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
        });
        requireTLSAddToResourcePolicy(webAppBucket);


        // Create the Route 53 Hosted Zone
        //TODO: create private host zone?
        const zone = new route53.HostedZone(this, "HostedZone", {
            zoneName: props.domainHostName,
            vpcs: [props.vpc],
        });
        
        // Create a new SSL certificate in ACM
        const cert = new acm.Certificate(this, "Certificate", {
            domainName: props.domainHostName,
            validation: acm.CertificateValidation.fromDns(zone),
        });

        // Create an ALB
        const alb = new elbv2.ApplicationLoadBalancer(this, 'WebAppDistroALB', {
            loadBalancerName: `${props.stackName}-WebAppALB`,
            internetFacing: props.setupPublicAccess,
            vpc: props.vpc,
            //vpcSubnets: { subnets: props.subnets},
            securityGroup: props.securityGroups[0],

        });

        //Add a L1 construct to add access logging on the ALB (currently not supported in CDK L2)
        const cfnLoadBalancer = alb.node.defaultChild as CfnLoadBalancer;
        cfnLoadBalancer.loadBalancerAttributes = [{
            key: 'access_logs.s3.enabled',
            value: 'true',
          },{
            key: 'access_logs.s3.bucket',
            value: accessLogsBucket.bucketName,
          },{
            key: 'access_logs.s3.prefix',
            value: "web-app-access-log-alb-logs",
          }];

        // Add a listener to the ALB
        const listener = alb.addListener('WebAppDistroALBListener', {
            port: 443, // The port on which the ALB listens
            certificates: [cert], // The certificate to use for the listener
        });

        // //Create custom resource to get IP of Interface Endpoint (CDK doesn't support getting the IP directly)
        // //https://repost.aws/questions/QUjISNyk6aTA6jZgZQwKWf4Q/how-to-connect-a-load-balancer-and-an-interface-vpc-endpoint-together-using-cdk 
        // const eni = new customResources.AwsCustomResource(
        //     this,
        //     "WebAppGetEndpointIPDescribeNetworkInterfaces",
        //     {
        //         onCreate: {
        //             service: "EC2",
        //             action: "describeNetworkInterfaces",
        //             parameters: {
        //             NetworkInterfaceIds: props.s3Endpoint.vpcEndpointNetworkInterfaceIds,
        //             },
        //             physicalResourceId: customResources.PhysicalResourceId.of(Date.now().toString()),
        //         },
        //         onUpdate: {
        //             service: "EC2",
        //             action: "describeNetworkInterfaces",
        //             parameters: {
        //             NetworkInterfaceIds: props.s3Endpoint.vpcEndpointNetworkInterfaceIds,
        //             },
        //             physicalResourceId: customResources.PhysicalResourceId.of(Date.now().toString()),
        //         },
        //         policy: {
        //             statements: [
        //             new iam.PolicyStatement({
        //                 actions: ["ec2:DescribeNetworkInterfaces"],
        //                 resources: ["*"],
        //             }),
        //             ],
        //         },
        //     }
        // );

        // // note: two ENIs in our endpoint as above (one for each AZ subnet?), so we can get two IPs out of the response
        // //TODO: Figure out a way to get all IPs if there are more than two?
        // const ip1 = eni.getResponseField("NetworkInterfaces.0.PrivateIpAddress");
        // const ip2 = eni.getResponseField("NetworkInterfaces.1.PrivateIpAddress");

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

        //Create custom resource to get IP of Interface Endpoint (CDK doesn't support getting the IP directly)
        //https://repost.aws/questions/QUjISNyk6aTA6jZgZQwKWf4Q/how-to-connect-a-load-balancer-and-an-interface-vpc-endpoint-together-using-cdk 
        for (let index = 0; index < props.vpc.availabilityZones.length; index++) {
            const getEndpointIp = new customResources.AwsCustomResource(this, `WebAppGetEndpointIP${index}`, {
                installLatestAwsSdk: false,
                onCreate: {
                    service: "EC2",
                    action: "describeNetworkInterfaces",
                    outputPaths: [`NetworkInterfaces.${index}.PrivateIpAddress`],
                    parameters: {NetworkInterfaceIds: props.s3Endpoint.vpcEndpointNetworkInterfaceIds,},
                    physicalResourceId: customResources.PhysicalResourceId.of(Date.now().toString()),
                },
                onUpdate: {
                    service: 'EC2',
                    action: 'describeNetworkInterfaces',
                    outputPaths: [`NetworkInterfaces.${index}.PrivateIpAddress`],
                    parameters: { NetworkInterfaceIds: props.s3Endpoint.vpcEndpointNetworkInterfaceIds },
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


        //Setup listener rule to rewrite path to forward to API Gateway for backend API calls
        const applicationListenerRuleBackendAPI= new elbv2.ApplicationListenerRule(this, 'WebAppnListenerRuleBackendAPI', {
            listener: listener,
            priority: 1,
            action: elbv2.ListenerAction.redirect({
                host: `${props.apiUrl}`,
                permanent: true,
            }),
            conditions: [elbv2.ListenerCondition.pathPatterns(['/api/*'])],
        });

        //Setup listener rule to rewrite path to forward to index.html for a no path route
        const applicationListenerRuleIndex = new elbv2.ApplicationListenerRule(this, 'WebAppnListenerRuleIndex', {
            listener: listener,
            priority: 2,
            action: elbv2.ListenerAction.redirect({
                path: "/#{path}index.html",
                permanent: false,
            }),
            conditions: [elbv2.ListenerCondition.pathPatterns(['*/'])],
        });


        // Enable a redirect from port 80 to 443
        alb.addRedirect();

        // Add a Route 53 alias with the Load Balancer as the target
        new route53.ARecord(this, "WebAppALBAliasRecord", {
            zone: zone,
            target: route53.RecordTarget.fromAlias(
            new route53targets.LoadBalancerTarget(alb)
            ),
        });

        // ALBTargetGroup.addTarget(new elbv2_targets.IpTarget(ip1));
        // //ALBTargetGroup.addTarget(new elbv2_targets.IpTarget(ip2));

        
        // listener.addTargetGroups('S3WebAppDistroBucketTargetGroup', {
        //     targetGroups: [ALBTargetGroup],
        // });

        // const accessLogs = new logs.LogGroup(this, "VAMS-Web-AccessLogs");

        // // init api gateway RESTAPI for website distribution with cloudfront logging
        // const apiGatewayWebsite = new ApiGateway.RestApi(this, "WebAppDistribution", {
        //     restApiName: `${props.stackName}WebDistro`,
        //     description: "Serves VAMS website assets from the S3 bucket.",
        //     binaryMediaTypes: ["*/*"],
        //     cloudWatchRole: true,
        //     endpointTypes: [ApiGateway.EndpointType.REGIONAL],
        //     deployOptions: {
        //         cachingEnabled: true,
        //         cacheTtl: cdk.Duration.hours(1),
        //         loggingLevel: ApiGateway.MethodLoggingLevel.INFO,
        //         dataTraceEnabled: true,
        //         metricsEnabled: true,
        //         tracingEnabled: true,     
        //         accessLogDestination: new ApiGateway.LogGroupLogDestination(accessLogs),
        //         accessLogFormat: ApiGateway.AccessLogFormat.jsonWithStandardFields(),
        //     },
        // });

        // const executeRole = new iam.Role(this, "api-gateway-s3-assume-tole", {
        // assumedBy: new iam.ServicePrincipal("apigateway.amazonaws.com"),
        // roleName: "API-Gateway-S3-Integration-Role",
        // });
    
        // executeRole.addToPolicy(
        // new iam.PolicyStatement({
        //     resources: [siteBucket.bucketArn],
        //     actions: ["s3:Get*", "s3:List*"],
        // })
        // );

        // siteBucket.grantRead(executeRole);

        // const apiGatewayWebsiteS3Integration_Proxy = new ApiGateway.AwsIntegration({
        //     service: "s3",
        //     integrationHttpMethod: "GET",
        //     path: `${siteBucket.bucketName}/{proxy}`,
        //     options: {
        //         credentialsRole: executeRole,
        //         passthroughBehavior: ApiGateway.PassthroughBehavior.WHEN_NO_MATCH,
        //         integrationResponses: [
        //         {
        //             statusCode: "200",
        //             responseParameters: {
        //             "method.response.header.Content-Type": "integration.response.header.Content-Type",
        //             "method.response.header.Content-Length": "integration.response.header.Content-Length",
        //             "method.response.header.Timestamp": "integration.response.header.Date",
        //             },
        //         },
        //         ],
        
        //         requestParameters: {
        //             "integration.request.path.proxy": "method.request.path.proxy",
        //         },
        //     },
        //     });


        // //Add ./{proxy+} route
        // apiGatewayWebsite.root
        // .addResource("{proxy+}")
        // .addMethod("GET", apiGatewayWebsiteS3Integration_Proxy, {
        //     //authorizer: this.createNoOpAuthorizer("proxy"),
        //     methodResponses: [
        //         {
        //         statusCode: "200",
        //         responseParameters: {
        //             "method.response.header.Content-Type": true,
        //             "method.response.header.Content-Length": true,
        //             "method.response.header.Timestamp": true,
        //         },
        //         },
        //     ],
        //     requestParameters: {
        //         "method.request.path.proxy": false,
        //         "method.request.header.Content-Type": false,
        //     },
        //     requestValidatorOptions: {
        //         requestValidatorName: "WebAppGETValidator_proxy",
        //         validateRequestParameters: true,
        //         validateRequestBody: false,
        //     },
        // });


        // //Assign WAF
        // const cfnWebACLAssociation = new wafv2.CfnWebACLAssociation(this,'WebAppWAFAssociation', {
        // resourceArn:apiGatewayWebsite.deploymentStage.stageArn,
        // webAclArn: props.webAcl,
        // });

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

        // assign public properties 
        // this.websiteUrl = `${apiGatewayWebsite.restApiId}.execute-api.${cdk.Stack.of(this).region}.amazonaws.com`; 
        this.websiteUrl = `https://${alb.loadBalancerDnsName}`;

        // //Export APIGateway specific outputs
        // new cdk.CfnOutput(this, "APIGatewayDistributionDomainName", {
        //     value: this.websiteUrl,
        // });

        new cdk.CfnOutput(this, "WebDistributionUrl", {
            value: this.websiteUrl, 
        });

        // // NagSuppressions.addResourceSuppressionsByPath(
        // //     Stack.of(this),
        // //     `/${this.toString()}/WebApp/WebAppDistribution/Default/{folder}/{key}/GET/Resource`,
        // //     [
        // //         {
        // //             id: "AwsSolutions-COG4",
        // //             reason: "This is an open API with a no-op authorizer as it is for fetching the main contents of the static webpage for both authorized and unauthorized users",
        // //         },
        // //     ],
        // //     true
        // // );
    

        // export any cf outputs
        new cdk.CfnOutput(this, "webAppBucket", { value: webAppBucket.bucketName });
    }

    // private createNoOpAuthorizer(RouteName:String): ApiGateway.IAuthorizer {
    //     const authorizerFn = new cdk.aws_lambda.Function(this, "WebAppAuthorizerLambda_"+RouteName, {
    //         runtime: lambda.Runtime.NODEJS_18_X,
    //         handler: "index.handler",
    //         code: lambda.Code.fromInline(this.getAuthorizerLambdaCode()),
    //         timeout: cdk.Duration.seconds(15),
    //     });

    //     authorizerFn.grantInvoke(new cdk.aws_iam.ServicePrincipal("apigateway.amazonaws.com"));

    //     return new ApiGateway.TokenAuthorizer(this, "CustomRESTAPIAuthorizer_"+RouteName, {
    //         handler: authorizerFn,
    //         authorizerName: "WebAppDistroAuthorizer_"+RouteName,
    //         resultsCacheTtl: cdk.Duration.seconds(3600),
    //         identitySource: "method.request.header.Accept", //A field that is required to be present in the request although a no-op authorizer is used
    //       });
    // }

    // private getAuthorizerLambdaCode(): string {
    //     return `
    //         exports.handler = async function(event, context) {
    //             return {
    //                 isAuthorized: true
    //             }
    //         }
    //     `;
    // }
}
