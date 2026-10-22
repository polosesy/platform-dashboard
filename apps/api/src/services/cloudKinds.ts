// The canonical taxonomy's data (Phase 0 of docs/architecture/multi-cloud.md): which native types of Azure, AWS and
// GCP are the same kind of thing. Pure data — nothing reads it at run time yet; tested in apps/api/test/cloudKinds.test.ts
// (every Azure graph kind maps, every Azure type exists in the REST-spec relationship catalog, formats per provider).
// Native type names: Azure = lower-case ARM type · AWS = CloudFormation resource type (AWS Config uses the same) ·
// GCP = Cloud Asset Inventory asset type. Reference map: docs/image/aws-azure-gcp-system.gif (rows there are not
// aligned — kinds are by function).
import type { CanonicalKind, CloudProvider, GraphNodeKind, NativeTypeMapping } from "@aud/types";

export const KIND_MAP: readonly NativeTypeMapping[] = [
  { kind: "scope.account", azure: ["microsoft.resources/subscriptions"], aws: ["AWS::Organizations::Account"], gcp: ["cloudresourcemanager.googleapis.com/Project"] },
  { kind: "scope.group", azure: ["microsoft.resources/resourcegroups"], gcp: ["cloudresourcemanager.googleapis.com/Folder"], gap: { aws: "no resource group — tags / Resource Groups (tag queries)" } },
  // Compute
  { kind: "compute.vm", azure: ["microsoft.compute/virtualmachines"], aws: ["AWS::EC2::Instance"], gcp: ["compute.googleapis.com/Instance"] },
  { kind: "compute.scaleSet", azure: ["microsoft.compute/virtualmachinescalesets"], aws: ["AWS::AutoScaling::AutoScalingGroup"], gcp: ["compute.googleapis.com/InstanceGroupManager"] },
  { kind: "compute.appPlatform", azure: ["microsoft.web/sites"], aws: ["AWS::ElasticBeanstalk::Environment", "AWS::AppRunner::Service"], gcp: ["appengine.googleapis.com/Service"], discriminator: "azure: web/sites kind without functionapp" },
  // Containers
  { kind: "container.cluster", azure: ["microsoft.containerservice/managedclusters"], aws: ["AWS::EKS::Cluster"], gcp: ["container.googleapis.com/Cluster"] },
  { kind: "container.service", azure: ["microsoft.app/containerapps"], aws: ["AWS::ECS::Service"], gcp: ["run.googleapis.com/Service"] },
  { kind: "container.registry", azure: ["microsoft.containerregistry/registries"], aws: ["AWS::ECR::Repository"], gcp: ["artifactregistry.googleapis.com/Repository"] },
  // Serverless
  { kind: "serverless.function", azure: ["microsoft.web/sites"], aws: ["AWS::Lambda::Function"], gcp: ["cloudfunctions.googleapis.com/Function"], discriminator: "azure: web/sites kind contains functionapp" },
  { kind: "serverless.workflow", azure: ["microsoft.logic/workflows"], aws: ["AWS::StepFunctions::StateMachine"], gcp: ["workflows.googleapis.com/Workflow"] },
  { kind: "serverless.apiGateway", azure: ["microsoft.apimanagement/service"], aws: ["AWS::ApiGateway::RestApi", "AWS::ApiGatewayV2::Api"], gcp: ["apigateway.googleapis.com/Gateway"] },
  // Databases
  { kind: "db.relational", azure: ["microsoft.sql/servers", "microsoft.dbforpostgresql/flexibleservers", "microsoft.dbformysql/flexibleservers"], aws: ["AWS::RDS::DBInstance", "AWS::RDS::DBCluster"], gcp: ["sqladmin.googleapis.com/Instance", "alloydb.googleapis.com/Cluster", "spanner.googleapis.com/Instance"] },
  { kind: "db.nosql", azure: ["microsoft.documentdb/databaseaccounts"], aws: ["AWS::DynamoDB::Table"], gcp: ["firestore.googleapis.com/Database"], discriminator: "gcp: Firestore native mode" },
  { kind: "db.document", azure: ["microsoft.documentdb/mongoclusters"], aws: ["AWS::DocDB::DBCluster"], gcp: ["firestore.googleapis.com/Database"], discriminator: "gcp: Firestore with MongoDB compatibility" },
  { kind: "db.cache", azure: ["microsoft.cache/redis"], aws: ["AWS::ElastiCache::ReplicationGroup"], gcp: ["redis.googleapis.com/Instance"] },
  // Storage
  { kind: "storage.object", azure: ["microsoft.storage/storageaccounts"], aws: ["AWS::S3::Bucket"], gcp: ["storage.googleapis.com/Bucket"], discriminator: "azure: blob service of the account (archive = tier facet)" },
  { kind: "storage.block", azure: ["microsoft.compute/disks"], aws: ["AWS::EC2::Volume"], gcp: ["compute.googleapis.com/Disk"] },
  { kind: "storage.file", azure: ["microsoft.storage/storageaccounts"], aws: ["AWS::EFS::FileSystem"], gcp: ["file.googleapis.com/Instance"], discriminator: "azure: file service of the account (fileServices/shares)" },
  // Messaging & events
  { kind: "messaging.queue", azure: ["microsoft.servicebus/namespaces"], aws: ["AWS::SQS::Queue"], gcp: ["cloudtasks.googleapis.com/Queue"], discriminator: "azure: Service Bus queues" },
  { kind: "messaging.topic", azure: ["microsoft.servicebus/namespaces"], aws: ["AWS::SNS::Topic"], gcp: ["pubsub.googleapis.com/Topic"], discriminator: "azure: Service Bus topics" },
  { kind: "messaging.stream", azure: ["microsoft.eventhub/namespaces"], aws: ["AWS::MSK::Cluster", "AWS::Kinesis::Stream"], gcp: ["managedkafka.googleapis.com/Cluster"] },
  { kind: "messaging.eventRouter", azure: ["microsoft.eventgrid/topics"], aws: ["AWS::Events::EventBus"], gcp: ["eventarc.googleapis.com/Trigger"] },
  // Network
  { kind: "network.vnet", azure: ["microsoft.network/virtualnetworks"], aws: ["AWS::EC2::VPC"], gcp: ["compute.googleapis.com/Network"] },
  { kind: "network.subnet", azure: ["microsoft.network/virtualnetworks/subnets"], aws: ["AWS::EC2::Subnet"], gcp: ["compute.googleapis.com/Subnetwork"] },
  { kind: "network.securityGroup", azure: ["microsoft.network/networksecuritygroups"], aws: ["AWS::EC2::SecurityGroup"], gcp: ["compute.googleapis.com/Firewall"], discriminator: "gcp: VPC firewall rules (rule-level, not a group)" },
  { kind: "network.nic", azure: ["microsoft.network/networkinterfaces"], aws: ["AWS::EC2::NetworkInterface"], gap: { gcp: "a NIC is part of the instance, not a resource" } },
  { kind: "network.lb", azure: ["microsoft.network/loadbalancers"], aws: ["AWS::ElasticLoadBalancingV2::LoadBalancer"], gcp: ["compute.googleapis.com/ForwardingRule"], discriminator: "aws: type network · gcp: passthrough forwarding rule" },
  { kind: "network.l7lb", azure: ["microsoft.network/applicationgateways", "microsoft.servicenetworking/trafficcontrollers"], aws: ["AWS::ElasticLoadBalancingV2::LoadBalancer"], gcp: ["compute.googleapis.com/UrlMap"], discriminator: "aws: type application" },
  { kind: "network.edge", azure: ["microsoft.cdn/profiles", "microsoft.network/frontdoors"], aws: ["AWS::CloudFront::Distribution"], gcp: ["compute.googleapis.com/BackendService"], discriminator: "gcp: global external Application LB with Cloud CDN" },
  { kind: "network.dnsTraffic", azure: ["microsoft.network/trafficmanagerprofiles"], aws: ["AWS::Route53::HealthCheck"], gap: { gcp: "Cloud DNS routing policies are record sets, not a resource of their own" } },
  { kind: "network.firewall", azure: ["microsoft.network/azurefirewalls"], aws: ["AWS::NetworkFirewall::Firewall"], gcp: ["networksecurity.googleapis.com/FirewallEndpoint"] },
  { kind: "network.nat", azure: ["microsoft.network/natgateways"], aws: ["AWS::EC2::NatGateway"], gcp: ["compute.googleapis.com/Router"], discriminator: "gcp: Cloud NAT is router configuration" },
  { kind: "network.publicIp", azure: ["microsoft.network/publicipaddresses"], aws: ["AWS::EC2::EIP"], gcp: ["compute.googleapis.com/Address"] },
  { kind: "network.privateEndpoint", azure: ["microsoft.network/privateendpoints"], aws: ["AWS::EC2::VPCEndpoint"], gcp: ["compute.googleapis.com/ForwardingRule"], discriminator: "gcp: Private Service Connect forwarding rule" },
  { kind: "network.dns", azure: ["microsoft.network/dnszones", "microsoft.network/privatednszones"], aws: ["AWS::Route53::HostedZone"], gcp: ["dns.googleapis.com/ManagedZone"] },
  { kind: "network.vpnGateway", azure: ["microsoft.network/virtualnetworkgateways"], aws: ["AWS::EC2::VPNGateway", "AWS::EC2::TransitGateway"], gcp: ["compute.googleapis.com/VpnGateway"] },
  { kind: "network.bastion", azure: ["microsoft.network/bastionhosts"], gap: { aws: "no managed bastion — SSM Session Manager (no resource)", gcp: "no managed bastion — IAP TCP forwarding (no resource)" } },
  // Security
  { kind: "security.secrets", azure: ["microsoft.keyvault/vaults"], aws: ["AWS::SecretsManager::Secret"], gcp: ["secretmanager.googleapis.com/Secret"] },
  // Monitoring & observability
  { kind: "observability.apm", azure: ["microsoft.insights/components"], aws: ["AWS::XRay::Group"], gap: { gcp: "Cloud Trace has no per-application resource" } },
  { kind: "observability.logs", azure: ["microsoft.operationalinsights/workspaces"], aws: ["AWS::Logs::LogGroup"], gcp: ["logging.googleapis.com/LogBucket"] },
  { kind: "observability.metricsWorkspace", azure: ["microsoft.monitor/accounts"], aws: ["AWS::APS::Workspace"], gap: { gcp: "Managed Service for Prometheus stores in the project's Cloud Monitoring" } },
  { kind: "observability.dashboards", azure: ["microsoft.dashboard/grafana"], aws: ["AWS::Grafana::Workspace"], gap: { gcp: "no managed Grafana — Cloud Monitoring dashboards" } },
  // AI & agents
  { kind: "ai.platform", azure: ["microsoft.cognitiveservices/accounts"], aws: ["AWS::Bedrock::Agent"], gcp: ["aiplatform.googleapis.com/Endpoint"], discriminator: "azure: Microsoft Foundry / AI services account" },
  { kind: "ai.ml", azure: ["microsoft.machinelearningservices/workspaces"], aws: ["AWS::SageMaker::Endpoint"], gcp: ["aiplatform.googleapis.com/Model"] },
  { kind: "ai.search", azure: ["microsoft.search/searchservices"], aws: ["AWS::Bedrock::KnowledgeBase"], gcp: ["discoveryengine.googleapis.com/DataStore"] },
];

/** Every kind the Azure architecture graph draws, in the canonical taxonomy (exhaustive at compile time) */
export const AZURE_GRAPH_KIND_CANONICAL = {
  subscription: "scope.account", resourceGroup: "scope.group",
  vnet: "network.vnet", subnet: "network.subnet", nsg: "network.securityGroup", nic: "network.nic",
  vm: "compute.vm", vmss: "compute.scaleSet", lb: "network.lb", appGateway: "network.l7lb", agc: "network.l7lb",
  frontDoor: "network.edge", trafficManager: "network.dnsTraffic", aks: "container.cluster",
  containerApp: "container.service", privateEndpoint: "network.privateEndpoint", storage: "storage.object",
  sql: "db.relational", postgres: "db.relational", cosmosDb: "db.nosql", redis: "db.cache", keyVault: "security.secrets",
  appInsights: "observability.apm", logAnalytics: "observability.logs", firewall: "network.firewall",
  functionApp: "serverless.function", appService: "compute.appPlatform", serviceBus: "messaging.queue",
  eventHub: "messaging.stream", dns: "network.dns", publicIP: "network.publicIp", vnetGateway: "network.vpnGateway",
  bastion: "network.bastion", natGateway: "network.nat", paas: "other", unknown: "other",
} as const satisfies Record<GraphNodeKind, CanonicalKind>;

/** The canonical kind of a native type (first mapping that lists it; a discriminator-free answer for shared types) */
export function canonicalKindOf(provider: CloudProvider, nativeType: string): CanonicalKind {
  const t = provider === "azure" ? nativeType.toLowerCase() : nativeType;
  return KIND_MAP.find((m) => (m[provider] ?? []).includes(t))?.kind ?? "other";
}
