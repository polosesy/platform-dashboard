# Customer tenant (Terraform ledger): the dashboard connection app trusts the platform's Kubernetes service account —
# workload identity federation, no client secret. Provider: hashicorp/azuread >= 2.x.
variable "dashboard_app_object_id" {
  description = "Object id of the dashboard connection's app registration (azuread_application.<x>.id)"
  type        = string
}
variable "platform_oidc_issuer_url" {
  description = "The platform's Kubernetes OIDC issuer URL (given by the platform admin)"
  type        = string
}
variable "platform_federation_subject" {
  description = "system:serviceaccount:<namespace>:<service account> of the platform API"
  type        = string
}

resource "azuread_application_federated_identity_credential" "aud_dashboard" {
  application_id = var.dashboard_app_object_id
  display_name   = "fed-common-aud-dashboard"
  description    = "Azure Unified Dashboard (read-only) - workload identity federation, no secret"
  audiences      = ["api://AzureADTokenExchange"]
  issuer         = var.platform_oidc_issuer_url
  subject        = var.platform_federation_subject
}
