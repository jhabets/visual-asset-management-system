/*
 * Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
// Return a class provides common patterns to build a URL, ARN, principal
import { region_info, Arn, Stack, aws_iam} from "aws-cdk-lib";
import { Config } from '../../config/config';
import { SERVICE, SERVICE_LOOKUP, TYPE_SERVICE_LOOKUP } from "./const";

let config: Config;

class ServiceFormatter {

    constructor( private name: SERVICE, private regionInfo: region_info.RegionInfo) {}

    private get service(){
        return SERVICE_LOOKUP[TYPE_SERVICE_LOOKUP[this.name]][this.regionInfo.partition || ""];
    }

    private replaceValues(value: string, resource?: string){
        return value.replace("{region}", config.env.region || "")
                .replace("{account-id}", config.env.account || "")
                .replace("{resource-id}", resource || "");
    }


    public ARN(resource: string, resourceName?: string) {

        let arn = this.replaceValues(this.service.arn, resource)
        
        if(resourceName) {
            arn += `/${resourceName}`
        }
        return arn;
    }

    public URL() { }
    public get Endpoint() { return config.app.useFips ? this.replaceValues(this.service.fipsHostname) :  this.replaceValues(this.service.hostname)};
    public get Principal() { return  new aws_iam.ServicePrincipal(this.replaceValues(this.service.principal))};

}

export function Service(name: SERVICE): ServiceFormatter {

    const ret = new ServiceFormatter(name, region_info.RegionInfo.get(config.env.region));
    //console.log(ret.Endpoint);

    return ret;
}

export function SetConfig(Config: Config) {
    config = Config;
}