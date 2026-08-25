{{/*
Base name of the chart.
*/}}
{{- define "a5e.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Fully-qualified release name, used as a prefix for resource names — e.g. "a5e-operator".
*/}}
{{- define "a5e.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Namespace every namespaced resource in this chart is deployed into. Defaults to the release
namespace (i.e. whatever `-n` was passed to `helm install`); namespaceOverride exists only for
the rare case that needs to decouple the two.
*/}}
{{- define "a5e.namespace" -}}
{{- .Values.namespaceOverride | default .Release.Namespace -}}
{{- end -}}

{{- define "a5e.chartLabel" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Chart-wide labels for resources that aren't scoped to one component (e.g. the shared S3 Secret).
*/}}
{{- define "a5e.selectorLabels" -}}
app.kubernetes.io/name: {{ include "a5e.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "a5e.labels" -}}
helm.sh/chart: {{ include "a5e.chartLabel" . }}
{{ include "a5e.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/*
Component-scoped labels/selector labels. Usage: {{ include "a5e.componentLabels" (list . "operator") }}
*/}}
{{- define "a5e.componentSelectorLabels" -}}
{{- $root := index . 0 -}}
{{- $component := index . 1 -}}
app.kubernetes.io/name: {{ include "a5e.name" $root }}
app.kubernetes.io/instance: {{ $root.Release.Name }}
app.kubernetes.io/component: {{ $component }}
{{- end -}}

{{- define "a5e.componentLabels" -}}
{{- $root := index . 0 -}}
{{- $component := index . 1 -}}
helm.sh/chart: {{ include "a5e.chartLabel" $root }}
{{ include "a5e.componentSelectorLabels" . }}
app.kubernetes.io/version: {{ $root.Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ $root.Release.Service }}
{{- end -}}

{{/*
Renders "repository:tag" for a component's image block. Tag resolution, most to least specific:
a per-component tag (operator.image.tag/etc — an escape hatch for pinning one component
separately, e.g. a hotfix), then the shared image.tag (the common case: all 4 images are always
released together from the same commit, so one value covers every component), then
.Chart.AppVersion as a last-resort default. Repository is prefixed with the shared registry
unless it's already fully-qualified (contains a "/" — a "."-free registry-host segment is
ambiguous in general, so we simply treat any repository containing a "/" as already-qualified,
matching how every other chart handles this).
*/}}
{{- define "a5e.image" -}}
{{- $root := index . 0 -}}
{{- $img := index . 1 -}}
{{- $tag := $img.tag | default $root.Values.image.tag | default $root.Chart.AppVersion -}}
{{- if or (not $root.Values.image.registry) (contains "/" $img.repository) -}}
{{- printf "%s:%s" $img.repository $tag -}}
{{- else -}}
{{- printf "%s/%s:%s" $root.Values.image.registry $img.repository $tag -}}
{{- end -}}
{{- end -}}

{{/*
Base resource name for each component (Deployment/Service/ServiceAccount/ClusterRole all share
this one name per component, matching the pre-Helm raw manifests this chart replaces).
*/}}
{{- define "a5e.operatorName" -}}
{{- printf "%s-operator" (include "a5e.fullname" .) -}}
{{- end -}}

{{- define "a5e.apiName" -}}
{{- printf "%s-api" (include "a5e.fullname" .) -}}
{{- end -}}

{{- define "a5e.uiName" -}}
{{- printf "%s-ui" (include "a5e.fullname" .) -}}
{{- end -}}

{{- define "a5e.oidcSecretName" -}}
{{- .Values.api.oidc.existingSecret | default (printf "%s-oidc" (include "a5e.fullname" .)) -}}
{{- end -}}

{{- define "a5e.s3SecretName" -}}
{{- .Values.s3.existingSecret | default (printf "%s-s3" (include "a5e.fullname" .)) -}}
{{- end -}}
