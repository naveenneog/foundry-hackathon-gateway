// Key Dashboard usage for product keys (P52, ADR-0015). The pk- and POC product policies emit
// llm-emit-token-metric, which reaches Application Insights only through an API diagnostic with
// metrics: true (see infra/main.bicep). This adds that diagnostic to the POC routes on the
// existing logger. No headers or bodies are logged: a subscription key must never reach the logs.

@description('Existing API Management instance.')
param apimName string

@description('Existing Application Insights logger on that instance (created by infra/main.bicep).')
param loggerName string = 'hackgw-appinsights'

@description('The POC routes whose product keys report usage.')
param apis array = [
  'poc-claude'
  'poc-openai'
]

resource apim 'Microsoft.ApiManagement/service@2024-05-01' existing = {
  name: apimName
}

resource logger 'Microsoft.ApiManagement/service/loggers@2024-05-01' existing = {
  parent: apim
  name: loggerName
}

var noPayload = {
  headers: []
  body: { bytes: 0 }
}

resource diagnostic 'Microsoft.ApiManagement/service/apis/diagnostics@2024-05-01' = [for a in apis: {
  name: '${apimName}/${a}/applicationinsights'
  properties: {
    loggerId: logger.id
    alwaysLog: 'allErrors'
    metrics: true
    verbosity: 'information'
    httpCorrelationProtocol: 'W3C'
    sampling: { samplingType: 'fixed', percentage: 100 }
    frontend: { request: noPayload, response: noPayload }
    backend: { request: noPayload, response: noPayload }
  }
}]
