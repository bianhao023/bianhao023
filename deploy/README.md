# Deployment: vpn-payment-backend

Kubernetes and Helm artifacts for deploying the VPN payment backend.

- Container image: `vpn-payment-backend:latest` (built from the repo-root `Dockerfile`; runs as the non-root `node` user, zero runtime deps).
- Listens on `PORT` (default `3000`); manifests target container port **3000**.
- Health: `GET /healthz` (liveness + readiness).
- Metrics: `GET /metrics` (Prometheus plain-text exposition).

Two independent options are provided:

1. **Raw manifests** under `k8s/` — plain `kubectl apply`.
2. **Helm chart** under `helm/vpn-payment/` — templated, toggleable.

Both deploy into the `vpn-payment` namespace and use a consistent label set
(`app.kubernetes.io/name`, `app.kubernetes.io/instance`, `app.kubernetes.io/component`,
`app.kubernetes.io/part-of`).

---

## Option 1 — Raw manifests (`kubectl`)

### 1. Create the real Secret

`k8s/secret.example.yaml` is an **example** with placeholder values. Do **not**
apply it as-is and do **not** commit real secrets.

```sh
cp deploy/k8s/secret.example.yaml deploy/k8s/secret.yaml
# edit deploy/k8s/secret.yaml and replace every REPLACE_WITH_* placeholder
# (keep deploy/k8s/secret.yaml out of version control)
kubectl apply -f deploy/k8s/namespace.yaml
kubectl apply -f deploy/k8s/secret.yaml
```

Alternatively create it imperatively (nothing hits disk):

```sh
kubectl -n vpn-payment create secret generic vpn-payment-secret \
  --from-literal=ADMIN_TOKEN=... \
  --from-literal=WECHAT_APP_ID=... \
  # ...all remaining secret keys...
```

### 2. Apply everything else

```sh
kubectl apply -f deploy/k8s/
```

`kubectl apply -f deploy/k8s/` applies the whole directory. If you created the
Secret imperatively, either skip `secret.example.yaml` or apply the directory
excluding it. The manifests:

| File | Resource |
|------|----------|
| `namespace.yaml` | Namespace `vpn-payment` |
| `configmap.yaml` | Non-secret env (`vpn-payment-config`) |
| `secret.example.yaml` | **Example** Secret template (copy, do not apply as-is) |
| `deployment.yaml` | Deployment, 2 replicas, probes, resources, hardened securityContext |
| `service.yaml` | ClusterIP Service, port 80 → targetPort `http` (3000) |
| `ingress.yaml` | nginx Ingress, host `vpn-pay.example.com`, TLS via `vpn-payment-tls` |
| `hpa.yaml` | HPA v2, 2–10 replicas, CPU target 70% |
| `servicemonitor.yaml` | Prometheus Operator ServiceMonitor |

### 3. Verify

```sh
kubectl -n vpn-payment rollout status deployment/vpn-payment
kubectl -n vpn-payment get pods,svc,ingress,hpa
```

### Notes on the raw manifests

- **Ingress**: update the host and TLS `secretName` (`vpn-payment-tls`) for your
  domain. A commented `cert-manager.io/cluster-issuer` annotation is included if
  you use cert-manager.
- **ServiceMonitor**: it carries a `release: prometheus` label so the Prometheus
  Operator's `serviceMonitorSelector` picks it up. Change that label to match
  your Prometheus install (see *Prometheus integration* below).

---

## Option 2 — Helm chart

Chart lives at `helm/vpn-payment/` (`apiVersion: v2`, `version 0.1.0`,
`appVersion "1.0.0"`).

Secrets are **not** managed by the chart. Create the Secret first (see Option 1
step 1) and reference it via `existingSecret` (defaults to `vpn-payment-secret`).

```sh
kubectl create namespace vpn-payment
kubectl -n vpn-payment apply -f deploy/k8s/secret.yaml   # your real secret

helm install vpn-payment deploy/helm/vpn-payment \
  --namespace vpn-payment
```

### Common overrides

```sh
helm install vpn-payment deploy/helm/vpn-payment \
  --namespace vpn-payment \
  --set image.tag=1.0.0 \
  --set ingress.enabled=true \
  --set ingress.host=vpn-pay.example.com \
  --set autoscaling.enabled=true \
  --set serviceMonitor.enabled=true
```

Key `values.yaml` toggles:

| Value | Default | Purpose |
|-------|---------|---------|
| `replicaCount` | `2` | Replicas (ignored when autoscaling is on) |
| `image.repository` / `image.tag` | `vpn-payment-backend` / `latest` | Image |
| `env` | map | Non-secret config → ConfigMap → `envFrom` |
| `existingSecret` | `vpn-payment-secret` | Pre-created Secret → `envFrom` (empty to skip) |
| `service.type` / `service.port` | `ClusterIP` / `80` | Service |
| `ingress.enabled` | `false` | Render the Ingress |
| `autoscaling.enabled` | `false` | Render the HPA (2–10, 70% CPU) |
| `serviceMonitor.enabled` | `false` | Render the ServiceMonitor |
| `resources` | 50m/64Mi → 500m/256Mi | Requests / limits |
| `probes` | `/healthz` | Liveness / readiness tuning |

Render locally without applying:

```sh
helm template vpn-payment deploy/helm/vpn-payment \
  --set ingress.enabled=true --set autoscaling.enabled=true \
  --set serviceMonitor.enabled=true
```

Upgrade / uninstall:

```sh
helm upgrade vpn-payment deploy/helm/vpn-payment -n vpn-payment
helm uninstall vpn-payment -n vpn-payment
```

---

## Prometheus integration (ServiceMonitor)

The app exposes Prometheus metrics at `GET /metrics` on port 3000 (Service port
name `http`).

Two scraping paths are supported:

1. **Prometheus Operator (recommended)** — the `ServiceMonitor` (raw
   `servicemonitor.yaml` or Helm `serviceMonitor.enabled=true`) tells Prometheus
   to scrape the Service's `http` port at `/metrics` every `30s`. For Prometheus
   to adopt it, the ServiceMonitor's labels must match the Prometheus resource's
   `spec.serviceMonitorSelector`. With the common kube-prometheus-stack Helm
   release, that selector is typically `release: <your-release>` — hence the
   `release: prometheus` label here. Adjust it to your environment, e.g.:

   ```sh
   # find the selector your Prometheus expects
   kubectl get prometheus -A -o jsonpath='{.items[*].spec.serviceMonitorSelector}'
   ```

   With the Helm chart:

   ```sh
   --set serviceMonitor.enabled=true \
   --set serviceMonitor.labels.release=<your-prometheus-release>
   ```

2. **Annotation-based scraping** — the pod template also carries
   `prometheus.io/scrape: "true"`, `prometheus.io/port: "3000"`, and
   `prometheus.io/path: "/metrics"` for Prometheus setups that use pod-annotation
   relabeling instead of the Operator.
