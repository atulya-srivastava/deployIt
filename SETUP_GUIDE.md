# Step-by-Step AWS, Redis, Kafka and ClickHouse Setup Guide for `deployit`

This guide explains how to set up Redis and AWS services (S3, ECR, ECS Fargate, IAM) to turn this project into a live working prototype.

---

## 1. Setting Up Redis (Log Streaming & SSE Pub/Sub)

You can use **Upstash Cloud Redis** (Recommended & Free) or run Redis locally using Docker.

### Option A: Upstash Cloud Redis (Recommended & Free)
1. Go to [Upstash.com](https://upstash.com) and create a free account.
2. Click **Create Database**, choose Redis, select a region, and click **Create**.
3. Under database details, copy the **TLS Connect URL** (starts with `rediss://...`).
4. Set `REDIS_URL` in `api-server/.env` and `build-server/.env`:
   ```env
   REDIS_URL="rediss://default:your_password@your-database.upstash.io:6379"
   ```
   > **How AWS ECS Receives `REDIS_URL`:**
   > When a user requests a deployment, `api-server` dynamically passes `process.env.REDIS_URL` into the AWS ECS Task as a container environment variable. Whenever you update `REDIS_URL` in `api-server/.env`, simply restart `api-server` (`node server.js`). New AWS ECS tasks will automatically receive the updated Redis URL!

### Option B: Local Redis (via Docker)
```bash
docker run -d --name redis-local -p 6379:6379 redis:latest
```
Set `REDIS_URL=redis://localhost:6379` in your `.env` files.

---

## 1.1 Setting Up Aiven Apache Kafka (Log Ingestion Pipeline)

The build log streaming pipeline uses Apache Kafka for high-throughput container log ingestion. If `KAFKA_BROKERS` is unconfigured in `.env`, the application gracefully falls back to direct Redis Pub/Sub.

### Step 1: Create Aiven Kafka Service
1. Log in to [Aiven Console](https://console.aiven.io/).
2. Click **Create Service** → Select **Apache Kafka** → Choose plan/cloud provider → Click **Create Service**.
3. Under **Topics**, click **Add Topic** → Topic Name: `container-logs` → Click **Add Topic**.
4. Copy the connection details from Aiven Overview tab:
   - `KAFKA_BROKERS`: `kafka-service-name.aivencloud.com:24134` (Service URI without scheme)
   - `KAFKA_USERNAME`: `avnadmin` (or user created under User Access)
   - `KAFKA_PASSWORD`: Your Aiven user password
   - `KAFKA_SASL_MECHANISM`: `scram-sha-256`

---

## 1.2 Setting Up Aiven ClickHouse (Historical Log Retention)

ClickHouse stores build logs for long-term query access and historical log retention. If `CLICKHOUSE_HOST` is unconfigured, real-time log streaming continues to work normally while ClickHouse log storage is skipped.

### Step 1: Create Aiven ClickHouse Service
1. In [Aiven Console](https://console.aiven.io/), click **Create Service** → Select **ClickHouse** → Click **Create Service**.
2. From the Service Overview, copy:
   - **HTTPS Service URI**: `https://clickhouse-service-name.aivencloud.com:24136`
   - **Username**: `avnadmin` (or your user)
   - **Password**: Your ClickHouse user password
3. Set the variables in `api-server/.env`:
   ```env
   CLICKHOUSE_HOST=https://clickhouse-service-name.aivencloud.com:24136
   CLICKHOUSE_USER=avnadmin
   CLICKHOUSE_PASSWORD=your_password
   CLICKHOUSE_DATABASE=default
   ```
4. The `api-server` automatically initializes the `build_logs` MergeTree table on startup.

---

### Option B: Local Development (Kafka & ClickHouse via Docker)
For quick local testing without cloud services:
```bash
# Local Kafka
docker run -d --name kafka-local -p 9092:9092 apache/kafka:latest

# Local ClickHouse
docker run -d --name clickhouse-local -p 8123:8123 -p 9000:9000 clickhouse/clickhouse-server:latest
```
Set `KAFKA_BROKERS=localhost:9092` and `CLICKHOUSE_HOST=http://localhost:8123` in `.env`.

---

## 2. Setting Up AWS IAM Credentials

1. Log in to the [AWS Management Console](https://console.aws.amazon.com/).
2. Open the **IAM** service → **Users** → **Add User**.
3. User name: `deployit-admin`.
4. Select **Attach policies directly**:
   - `AmazonECS_FullAccess`
   - `AmazonS3FullAccess`
   - `AmazonEC2ContainerRegistryFullAccess`
5. Create the user, then go to the user's **Security credentials** tab.
6. Click **Create access key** -> Select **Command Line Interface (CLI)**.
7. Save your **Access Key ID** and **Secret Access Key**. You will put these in your `.env` files.

---

## 3. Setting Up AWS S3 Bucket

1. Open **Amazon S3** in AWS Console → **Create bucket**.
2. Bucket Name: `my-vercel-clone-outputs` (or any unique name).
3. Region: `ap-south-1` (or your preferred AWS region).
4. **Block Public Access**:
   * For the reverse proxy to serve static assets publicly, uncheck *"Block all public access"* (acknowledge the warning).
5. Click **Create bucket**.
6. Open your new bucket → **Permissions** tab → **Bucket Policy** → Edit:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Sid": "PublicReadGetObject",
         "Effect": "Allow",
         "Principal": "*",
         "Action": "s3:GetObject",
         "Resource": "arn:aws:s3:::my-vercel-clone-outputs/__outputs/*"
       }
     ]
   }
   ```
   *(Replace `my-vercel-clone-outputs` with your actual bucket name).*

---

## 4. Building & Pushing the Build Server Docker Image to AWS ECR

Whenever you make code changes to `build-server/script.js` or `build-server/main.sh`, you must rebuild and push the Docker image to AWS ECR so AWS ECS runs your updated code:

1. Open **Amazon ECR** (Elastic Container Registry) in AWS Console.
2. Click **Create repository** → Name: `builder-image` → Click **Create**.
3. Authenticate Docker to your AWS ECR (replace `<ACCOUNT_ID>` and `<REGION>`):
   ```bash
   aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin <ACCOUNT_ID>.dkr.ecr.ap-south-1.amazonaws.com
   ```
4. Build, tag, and push the image from `build-server` folder:
   ```bash
   cd build-server
   docker build -t builder-image -f dockerfile .
   docker tag builder-image:latest <ACCOUNT_ID>.dkr.ecr.ap-south-1.amazonaws.com/builder-image:latest
   docker push <ACCOUNT_ID>.dkr.ecr.ap-south-1.amazonaws.com/builder-image:latest
   ```

---

## 5. Setting Up AWS ECS (Elastic Container Service) & Fargate

### Container Lifecycle & Exit Behavior:
> The `build-server` container runs as an **ephemeral on-demand worker task** in AWS ECS Fargate. When a build completes (`npm run build` and S3 uploads finish), `script.js` logs `Done...` and exits with code `0` (`process.exit(0)`). This allows AWS ECS to terminate the container task immediately to avoid idle server costs.

### Step 5A: Create ECS Cluster
1. Open **Amazon ECS** → **Clusters** → **Create Cluster**.
2. Cluster name: `builder-cluster`.
3. Infrastructure: Select **AWS Fargate (serverless)**.
4. Click **Create**.

### Step 5B: Create ECS Task Definition
1. Open **Task Definitions** → **Create new Task Definition**.
2. Task definition family: `builder-task`.
3. Launch type: **AWS Fargate**.
4. Operating system / Architecture: `Linux/X86_64`.
5. CPU: `0.5 vCPU`, Memory: `1 GB`.
6. **Container details**:
   - Name: `builder-image`
   - Image URI: `<ACCOUNT_ID>.dkr.ecr.ap-south-1.amazonaws.com/builder-image:latest`
7. Under **Environment variables**, define placeholders or defaults:
   - `GIT_REPOSITORY__URL`
   - `PROJECT_ID`
   - `AWS_ACCESS_KEY_ID`
   - `AWS_SECRET_ACCESS_KEY`
   - `AWS_REGION`
   - `S3_BUCKET_NAME`
   - `REDIS_URL`
8. Click **Create**. Copy the Task Definition ARN (e.g., `arn:aws:ecs:ap-south-1:<ACCOUNT_ID>:task-definition/builder-task:1`).

---

## 6. Retrieving Subnet & Security Group IDs

1. Open **Amazon VPC** in AWS Console.
2. Go to **Subnets** → Copy 1 or 2 Subnet IDs from your default VPC (e.g., `subnet-xxxxxx`, `subnet-yyyyyy`).
3. Go to **Security Groups** → Copy your default Security Group ID (e.g., `sg-zzzzzz`).
4. Ensure the Security Group has **Outbound rules** allowing all traffic (`0.0.0.0/0`) so the container can clone GitHub repos, install NPM packages, connect to Redis, and upload to S3.

---

## 7. Configuring Environment Files (`.env`)

Now create `.env` files in each service directory by copying `.env.example`:

### In `api-server/.env`:
```env
PORT=9000
SOCKET_PORT=9002
REDIS_URL=your_redis_connection_url

AWS_REGION=ap-south-1
AWS_ACCESS_KEY_ID=your_access_key_id
AWS_SECRET_ACCESS_KEY=your_secret_access_key

ECS_CLUSTER=builder-cluster
ECS_TASK_DEFINITION=builder-task
CONTAINER_NAME=builder-image

ECS_SUBNETS=subnet-xxxxxx,subnet-yyyyyy
ECS_SECURITY_GROUPS=sg-zzzzzz
S3_BUCKET_NAME=my-vercel-clone-outputs
```

### In `reverse-proxy-s3/.env`:
```env
PORT=8000
S3_BASE_PATH=https://my-vercel-clone-outputs.s3.ap-south-1.amazonaws.com/__outputs
```

---

## 8. Running the Prototype

1. **Start API Server**:
   ```bash
   cd api-server
   node server.js
   ```

2. **Start Reverse Proxy**:
   ```bash
   cd reverse-proxy-s3
   node proxy.js
   ```

3. **Deploy a Project**:
   Send a POST request to `http://localhost:9000/project`:
   ```json
   {
     "gitURL": "https://github.com/user/sample-react-app",
     "slug": "my-cool-app"
   }
   ```

4. **Stream Build Logs**:
   Connect via Socket.io to `http://localhost:9002` and subscribe to channel `logs:my-cool-app`.

5. **Access Deployed Site**:
   Once the build completes, visit `http://my-cool-app.localhost:8000`.
