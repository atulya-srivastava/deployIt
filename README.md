# deploy1t

**deploy1t** is an event-driven, containerized deployment platform. It takes any frontend GitHub repository, builds it automatically inside isolated containers, uploads static outputs to AWS S3, and streams real-time build logs to the frontend via an event-driven pipeline using **Aiven Apache Kafka**, **Redis Pub/Sub**, **Server-Sent Events (SSE)**, and **Aiven ClickHouse**. 

deploy It in 1 go.

---

## Architecture & How It Works

```text
                  ┌──> [Aiven Kafka Consumer] ──> [Redis Pub/Sub] ──> [SSE /logs/stream/:slug] (Real-Time Live Logs)
[Build Container] ─┤
                  └──> [Aiven Kafka Consumer] ──> [Aiven ClickHouse] ──> [GET /logs/history/:slug] (Historical Logs)
```

1. **Submit GitHub URL**: Send your project's GitHub URL and a custom slug to the API Server (`POST /project`).
2. **Ephemeral Containerized Build Task**: The API Server launches an AWS ECS Fargate task that clones the repository, installs dependencies, builds static outputs, and uploads them to AWS S3.
   * *Note:* The build container is an on-demand worker task. Once the build and upload reach `Done...`, the task automatically exits (`process.exit(0)`) to free up ECS cloud resources.
3. **Dynamic Environment Injection**: `api-server` dynamically passes environment variables (such as `REDIS_URL`, `S3_BUCKET_NAME`, `KAFKA_BROKERS`, etc.) directly into the AWS ECS build container upon task launch.
4. **High-Throughput Log Ingestion**: Build containers produce real-time log events into **Aiven Apache Kafka** (`container-logs` topic) with fallback to Redis Pub/Sub.
5. **Hot Path (Real-Time SSE Stream)**: A Kafka consumer in the `api-server` bridges log events to **Redis Pub/Sub** channels (`logs:<slug>`) for live SSE browser streaming (`GET /logs/stream/:slug`).
6. **Cold Path (ClickHouse Storage)**: The Kafka consumer persists log records into **Aiven ClickHouse** (`build_logs` MergeTree table) for long-term retention and historical querying (`GET /logs/history/:slug`).
7. **Access Live Site**: Visit `http://<your-slug>.localhost:8000` to access the deployed site.

---

## Project Structure

The project consists of 3 primary components:

* **`api-server`**: 
  * Manages project and deployment records (Prisma & Supabase Postgres).
  * Launches AWS ECS Fargate build tasks on demand with dynamic container overrides.
  * Consumes Aiven Kafka topics, bridges events to Redis Pub/Sub, and inserts log rows into Aiven ClickHouse.
  * Serves real-time build logs via SSE (`/logs/stream/:projectId`) and historical logs via ClickHouse (`/logs/history/:projectId`).

* **`build-server`**: 
  * Ephemeral Docker container execution environment.
  * Clones GitHub repositories, runs builds (`npm install && npm run build`).
  * Ingests build logs to Aiven Kafka (with direct Redis Pub/Sub fallback).
  * Uploads static distribution files to AWS S3 and terminates upon completion.

* **`reverse-proxy-s3`**: 
  * Dynamic reverse proxy server.
  * Routes domain/subdomain requests (e.g., `http://my-app.localhost:8000`) to fetch static assets from AWS S3.

---

## Prerequisites

- **Node.js** (v18 or higher)
- **Docker** (installed and running)
- **AWS Account** (S3, ECR, ECS Fargate, IAM user)
- **Redis Connection** (Upstash Cloud Redis with TLS `rediss://...` or Local Docker Redis)
- **Aiven Apache Kafka** (Hosted Kafka cluster on Aiven — *optional; falls back to Redis Pub/Sub if omitted*)
- **Aiven ClickHouse** (Hosted ClickHouse database on Aiven — *optional; historical storage disabled if omitted*)

---

## Quick Start

### 1. Set Up Environment Variables

Create `.env` files in each component directory (`api-server`, `build-server`, and `reverse-proxy-s3`) based on their `.env.example` files.

> Note: For detailed instructions on AWS, Redis, and Apache Kafka setup, refer to the [Setup Guide](./SETUP_GUIDE.md).

### 2. Install Dependencies

In each service directory, install dependencies:

```bash
# API Server
cd api-server
npm install

# Reverse Proxy
cd ../reverse-proxy-s3
npm install
```

### 3. Build & Push Docker Image to AWS ECR

Whenever you update `build-server` code, build and push the Docker image to AWS ECR:

```bash
# Authenticate with AWS ECR
aws ecr get-login-password --region <YOUR_AWS_REGION> | docker login --username AWS --password-stdin <AWS_ACCOUNT_ID>.dkr.ecr.<YOUR_AWS_REGION>.amazonaws.com

# Build, tag, and push image
cd build-server
docker build -t builder-image -f dockerfile .
docker tag builder-image:latest <AWS_ACCOUNT_ID>.dkr.ecr.<YOUR_AWS_REGION>.amazonaws.com/builder-image:latest
docker push <AWS_ACCOUNT_ID>.dkr.ecr.<YOUR_AWS_REGION>.amazonaws.com/builder-image:latest
```

### 4. Start the Servers

Start the API Server:
```bash
cd api-server
node server.js
```

Start the Reverse Proxy:
```bash
cd reverse-proxy-s3
node proxy.js
```

---

## Deploying Your First Site

### Step 1: Send a Deploy Request

Make a `POST` request to `http://localhost:9000/project`:

```json
{
  "gitURL": "https://github.com/username/my-react-app",
  "slug": "my-cool-site"
}
```

### Step 2: Stream Build Logs via Server-Sent Events (SSE)

Open your browser or an `EventSource` client and navigate to:
```text
http://localhost:9000/logs/stream/my-cool-site
```
You will receive real-time build logs streamed directly from the event pipeline.

### Step 3: Visit Your Site!

Once the build completes, open your browser and navigate to:
```text
http://my-cool-site.localhost:8000
```

---

## Documentation

For full step-by-step setup guides (Kafka, AWS ECR, ECS Fargate, S3 Bucket Policies, IAM permissions), see:
- [Setup Guide](./SETUP_GUIDE.md)

