/* eslint-disable @typescript-eslint/no-unused-vars */
/*
 * Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
export function getUserData(
    artefactsS3BucketName: string,
    hostDomain: string,
    wepAppS3BucketURL: string
): string {

	const returnUserData = `#!/bin/bash
echo ------------------------ REVERSE PROXY CONFIG ------------------------
echo UPDATING PACKAGES ----------------------------------
sudo yum update -y

echo INSTALLING DEPENDENCIES ----------------------------------
sudo yum install -y aws-cfn-bootstrap gcc openssl-devel bzip2-devel libffi-devel zlib-devel

echo INSTALLING NGINX ----------------------------------
sudo yum install -y amazon-linux-extras
sudo amazon-linux-extras enable nginx1.12
sudo yum install -y nginx

echo INSTALLING REVERSE PROXY CONFIGURATION FILE ----------------------------------
cd /opt
fsudo aws s3 cp s3://${artefactsS3BucketName}/reverseProxyConfig/nginx.conf ./nginx.conf
sed -e "s/\\{WEBAPP_BUCKET_URL}/${wepAppS3BucketURL}/" -e "s/\\{HOST_DOMAIN}/${hostDomain}/" nginx.conf
sudo mv -f nginx.conf /etc/nginx/nginx.conf

echo STARTING NGINX ----------------------------------
sudo service nginx restart`

	return returnUserData;
}