{{- define "aud.selector" -}}
app.kubernetes.io/name: aud-dashboard
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "aud.labels" -}}
{{ include "aud.selector" . }}
app.kubernetes.io/part-of: azure-unified-dashboard
app.kubernetes.io/version: {{ .Values.image.tag | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end }}

{{- define "aud.image" -}}
{{ .Values.image.repository }}:{{ .Values.image.tag }}{{ with .Values.image.digest }}@{{ . }}{{ end }}
{{- end }}

{{/* The one federated-credential subject both identities must trust */}}
{{- define "aud.subject" -}}
system:serviceaccount:{{ .Release.Namespace }}:{{ .Values.serviceAccount.name }}
{{- end }}

{{- define "aud.wave" -}}
{{- if .root.Values.syncWaves -}}
annotations:
  argocd.argoproj.io/sync-wave: {{ .wave | quote }}
{{- end }}
{{- end }}

{{/* The API's loopback health check (the kubelet probes the pod IP; the API listens on 127.0.0.1 only) */}}
{{- define "aud.apiProbe" -}}
exec:
  command: ["node", "-e", "fetch('http://127.0.0.1:4000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
{{- end }}

{{- define "aud.hardened" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities: { drop: [ALL] }
{{- end }}
