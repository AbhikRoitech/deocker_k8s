# PERN → Production DevOps Roadmap

One real application — a **PERN todo app** (`client/` React+Vite, `server/` Express+`pg`,
PostgreSQL) — evolved across 10 projects (+1 bonus). Each project introduces a new DevOps
concept while reinforcing the previous ones, ending in a production-style deployment on AWS.

## Progress

| # | Project | Main skills | Status |
|---|---------|-------------|--------|
| 1 | Dockerize the app (local) | Docker, Docker Compose, volumes, networks | ✅ Done |
| 2 | Local Kubernetes (Docker Desktop) | Pods, Deployments, Services, Namespaces | ⬜ Next |
| 3 | Scaling & self-healing | ReplicaSets, rollouts, rollback, scaling | ⬜ |
| 4 | Kubernetes networking | ClusterIP, NodePort, LoadBalancer, Ingress | ⬜ |
| 5 | AWS infrastructure with Terraform | IAM, VPC, subnets, IGW, NAT, security groups | ⬜ |
| 6 | Amazon ECR | Private registry, image tags, push | ⬜ |
| 7 | Amazon EKS | Managed K8s, node groups, worker nodes | ⬜ |
| 8 | ALB + Ingress | ALB, AWS Load Balancer Controller, routing, SSL | ⬜ |
| 9 | CI/CD with GitHub Actions | Secrets, build, push to ECR, deploy to EKS | ⬜ |
| 10 | Production monitoring | Prometheus, Grafana, metrics, alerts | ⬜ |
| 11 | Production-ready cluster (bonus) | HPA, probes, limits, ConfigMaps/Secrets, PV/PVC | ⬜ |

## Final architecture

```text
                    GitHub
                       │
               GitHub Actions
                       │
                Build Docker Image
                       │
                    Amazon ECR
                       │
                Deploy to Amazon EKS
                       │
        ---------------------------------
        │                               │
     Worker Node                    Worker Node
        │                               │
      Backend Pod                    Backend Pod
      Frontend Pod                   Frontend Pod
        │                               │
        -------- Kubernetes Service -----
                       │
                    Ingress
                       │
              AWS Application Load Balancer
                       │
                    Internet

          PostgreSQL (Amazon RDS)

     Prometheus ─────────► Grafana
```

---

## Project 1 — Dockerize the app (local) ✅

**Learn:** Docker, Dockerfile, Docker Compose, environment variables, networks, volumes.

**Build:** Run React + Node + PostgreSQL locally with a single `docker compose up`.

```text
Docker Compose
   ├─ postgres   (postgres:16-alpine, volume: pgdata)
   ├─ migrate    (one-shot: creates the todos table, exits)
   ├─ api        (Express, :8000, /health probe)
   └─ client     (nginx serving React build, :8080, proxies /api → api:8000)
```

**Artifacts in this repo:** `docker-compose.yml`, `client/Dockerfile`, `server/Dockerfile`,
`client/.dockerignore`, `server/.dockerignore`, `.env` / `.env.example`.

**Run:**

```bash
cp .env.example .env          # first time only
docker compose up --build     # open http://localhost:8080
docker compose ps             # postgres/api healthy, migrate exited 0
docker compose down           # stop (keep data)  |  down -v  (wipe volume)
```

**Skills:** `docker build`, `docker run`, `docker compose`, volumes, networks, service DNS,
healthchecks, dependency ordering (`service_healthy`, `service_completed_successfully`).

---

## Project 2 — Local Kubernetes (Docker Desktop)

**Learn:** Kubernetes basics — Pod, Deployment, Service, Namespace.

**Build:** Deploy the Dockerized app into the local Kubernetes cluster bundled with Docker
Desktop.

```text
Docker Desktop → Kubernetes → Pod → Service → Browser
```

**Commands:** `kubectl apply`, `kubectl get`, `kubectl describe`, `kubectl logs`, `kubectl exec`.

---

## Project 3 — Scaling & self-healing

**Learn:** ReplicaSet, Deployment, rolling update, rollback, scaling.

**Tasks:** Scale 2 → 5 pods, delete a pod and watch it be recreated, roll an update out and back.

```text
Scale → 2 Pods → 5 Pods → Delete Pod → Auto-recreated
```

**Commands:** `kubectl scale`, `kubectl rollout status/undo`, `kubectl delete pod`.

---

## Project 4 — Kubernetes networking

**Learn:** ClusterIP, NodePort, LoadBalancer, Ingress, Ingress Controller.

**Build:** Expose frontend → backend API → Postgres correctly, each with the right Service type,
and put an Ingress in front.

```text
Frontend → Backend API → Postgres
```

---

## Project 5 — AWS infrastructure with Terraform

**Learn:** IAM, VPC, public/private subnets, Internet Gateway, NAT Gateway, security groups.

**Build:** Terraform provisions the whole network foundation.

```bash
terraform init
terraform plan
terraform apply
```

> 💡 AWS phases (5–10) incur real cost — EKS control plane, NAT gateways, ALB, RDS.
> Run `terraform destroy` when not actively using them.

---

## Project 6 — Amazon ECR

**Learn:** Private Docker registry, image tags, pushing images.

```text
GitHub → Docker Build → ECR → Image stored
```

**Commands:** `aws ecr get-login-password | docker login`, `docker tag`, `docker push`.

---

## Project 7 — Amazon EKS

**Learn:** Managed Kubernetes, node groups, worker nodes, AWS Load Balancer Controller.

**Build:** Deploy the PERN app to EKS.

```text
EKS → Worker Nodes → Pods → Services
```

---

## Project 8 — ALB + Ingress

**Learn:** Application Load Balancer, Ingress, AWS Load Balancer Controller, path/host routing,
SSL readiness.

```text
Internet → ALB → Ingress → Service → Pods
```

---

## Project 9 — Complete CI/CD

**Learn:** GitHub Actions pipelines.

```text
Push Code → GitHub Actions → Tests → Docker Build → Push to ECR → Deploy to EKS → Pods Updated
```

**Concepts:** secrets, variables, actions, rolling deployment.

---

## Project 10 — Production monitoring

**Learn:** Prometheus, Grafana, metrics, alerts.

```text
Pods → Prometheus → Grafana → Dashboard
```

**Monitor:** CPU, memory, pod restarts, node health, response time.

---

## Project 11 — Production-ready cluster (bonus)

**Add:** HPA (Horizontal Pod Autoscaler), Metrics Server, Cluster Autoscaler, liveness &
readiness probes, resource requests & limits, Secrets, ConfigMaps, Persistent Volumes & Claims.

---

## What you'll be able to explain in interviews

- Docker and containerization
- Kubernetes architecture and day-to-day operations
- Infrastructure as Code with Terraform
- AWS networking (VPC, subnets, security groups, NAT, ALB)
- Amazon ECR and EKS
- CI/CD with GitHub Actions
- Kubernetes networking (Services, Ingress)
- Monitoring with Prometheus and Grafana
- Production deployment strategies (rolling updates, rollbacks, autoscaling)
- End-to-end cloud deployment of a real PERN application
