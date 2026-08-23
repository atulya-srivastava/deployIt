# DeployIt

**DeployIt** is a simple, lightweight deployment platform. It allows you to take any frontend GitHub repository, build it automatically inside a container, store the output on AWS S3, and serve it via a custom link!

---

## How It Works

1. **Submit GitHub URL**: You send your project's GitHub URL and a custom name (slug) to the API Server.
2. **Build Project**: The API Server starts a container in AWS ECS that downloads your code, installs dependencies, builds the project, and uploads the final website files to AWS S3.
3. **Live Logs**: You can view real-time build logs using WebSockets.
4. **Access Site**: Visit `http://<your-slug>.localhost:8000` to see your deployed website live!

---

## Project Structure

The project is divided into 3 main components:

* **`api-server`**: 
  * Accepts deploy requests.
  * Launches AWS ECS build tasks.
  * Streams real-time build logs over Socket.io using Redis.

* **`build-server`**: 
  * A Docker container image.
  * Clones the GitHub repository.
  * Runs `npm install` and `npm run build`.
  * Uploads built static assets to AWS S3.

* **`reverse-proxy-s3`**: 
  * A reverse proxy server.
  * Redirects incoming requests (e.g., `http://my-app.localhost:8000`) to fetch files directly from your S3 bucket.

---

## Prerequisites

Before running the project, make sure you have:

- **Node.js** (v18 or higher)
- **Docker** (installed and running)
- **AWS Account** (S3, ECR, ECS Fargate, IAM user)
- **Redis Connection** (Cloud Redis via Upstash or Local Redis via Docker)

---

## Quick Start

### 1. Set Up Environment Variables

Create `.env` files in each component directory (`api-server`, `build-server`, and `reverse-proxy-s3`) based on their `.env.example` files.

> Note: For detailed instructions on AWS and Redis setup, check out the [AWS & Redis Setup Guide](./AWS_AND_REDIS_SETUP_GUIDE.md).

### 2. Install Dependencies

In each folder, install the required packages:

```bash
# API Server
cd api-server
npm install

# Reverse Proxy
cd ../reverse-proxy-s3
npm install
```

### 3. Build & Push Docker Image

Build the `build-server` image and push it to AWS ECR:

```bash
cd build-server
docker build -t builder-image .
# Tag and push to AWS ECR as explained in the setup guide
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

Make a `POST` request to `http://localhost:9000/project` with your GitHub repo details:

```json
{
  "gitURL": "https://github.com/username/my-react-app",
  "slug": "my-cool-site"
}
```

### Step 2: Stream Build Logs (Optional)

Connect to Socket.io at `http://localhost:9002` and subscribe to channel `logs:my-cool-site` to watch the build process in real time.

### Step 3: Visit Your Site!

Once the build completes, open your browser and navigate to:
`http://my-cool-site.localhost:8000`

---

## Documentation

For full step-by-step setup guides (AWS ECR, ECS Fargate, S3 Bucket Policies, IAM permissions), see:
- [AWS & Redis Setup Guide](./AWS_AND_REDIS_SETUP_GUIDE.md)
