require('dns').setDefaultResultOrder('ipv4first')
require('dotenv').config()
const express = require('express')
const { generateSlug } = require('random-word-slugs')
const { ECSClient, RunTaskCommand } = require('@aws-sdk/client-ecs')
const { Server } = require('socket.io')
const Redis = require('ioredis')
const { Kafka } = require('kafkajs')
const { Pool } = require('pg')
const { PrismaPg } = require('@prisma/adapter-pg')
const { PrismaClient } = require('@prisma/client')
const { initClickHouse, insertLog, getLogsByProjectId } = require('./clickhouse')

const connectionString = process.env.DIRECT_URL || process.env.DATABASE_URL
const pool = new Pool({ connectionString })
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })
const app = express()
const PORT = process.env.PORT || 9000
const SOCKET_PORT = process.env.SOCKET_PORT || 9002

process.on('uncaughtException', (err) => {
    if (err && err.message && err.message.includes('max requests limit exceeded')) {
        return;
    }
    console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason) => {
    if (reason && reason.message && reason.message.includes('max requests limit exceeded')) {
        return;
    }
    console.error('Unhandled Rejection:', reason);
});

function createSafeRedisClient(url, name = 'REDIS') {
    if (!url) return null;
    const client = new Redis(url, {
        maxRetriesPerRequest: null,
        enableOfflineQueue: true,
        retryStrategy(times) {
            return Math.min(times * 1000, 15000);
        }
    });
    client.on('error', err => {
        if (err && err.message && (err.message.includes('max requests limit exceeded') || err.message.includes('Stream isn\'t writeable'))) {
            return;
        }
        console.error(`[${name} ERROR]`, err ? err.message : err);
    });
    return client;
}

const redisPublisher = createSafeRedisClient(process.env.REDIS_URL || 'redis://localhost:6379', 'REDIS PUBLISHER')

const io = new Server({ cors: '*' })

io.on('connection', socket => {
    socket.on('subscribe', channel => {
        socket.join(channel)
        socket.emit('message', `Joined ${channel}`)
    })
})

io.listen(SOCKET_PORT, () => console.log(`Socket Server running on port ${SOCKET_PORT}`))

const ecsClient = new ECSClient({
    region: process.env.AWS_REGION || 'ap-south-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
    }
})

const cors = require('cors')

const config = {
    CLUSTER: process.env.ECS_CLUSTER || '',
    TASK: process.env.ECS_TASK_DEFINITION || ''
}

app.use(cors())
app.use(express.json())

// Get all projects
app.get('/projects', async (req, res) => {
    try {
        const projects = await prisma.project.findMany({
            include: { deployments: true },
            orderBy: { createdAt: 'desc' }
        })
        return res.json({ status: 'success', data: projects })
    } catch (err) {
        console.error('[GET /projects DB ERROR]:', err.message)
        return res.status(500).json({ status: 'error', message: 'Failed to fetch projects', error: err.message })
    }
})

// Server-Sent Events (SSE) Log Streaming Endpoint
app.get('/logs/stream/:projectId', (req, res) => {
    const { projectId } = req.params;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();

    const channel = `logs:${projectId}`;
    console.log(`[SSE] Client connected for log stream: ${channel}`);

    const sub = createSafeRedisClient(process.env.REDIS_URL || 'redis://localhost:6379', 'REDIS SSE');
    if (sub) {
        sub.subscribe(channel).catch(err => {
            console.error(`[SSE SUBSCRIBE ERROR]`, err ? err.message : err);
        });

        sub.on('message', (chan, message) => {
            if (chan === channel) {
                res.write(`data: ${message}\n\n`);
            }
        });
    }

    req.on('close', () => {
        console.log(`[SSE] Client disconnected from log stream: ${channel}`);
        if (sub) {
            sub.unsubscribe(channel).catch(() => {});
            sub.quit().catch(() => {});
        }
    });
});

// Historical Build Logs Endpoint (from Aiven ClickHouse)
app.get('/logs/history/:projectId', async (req, res) => {
    const { projectId } = req.params;
    const result = await getLogsByProjectId(projectId);
    if (result.status === 'error') {
        return res.status(500).json(result);
    }
    return res.json(result);
});

// Create or deploy a project
app.post('/project', async (req, res) => {
    const { gitURL, slug, name } = req.body
    const projectSlug = slug ? slug : generateSlug()

    // 1. Find or create Project in Supabase Postgres
    let project = await prisma.project.findUnique({
        where: { subDomain: projectSlug }
    })

    if (!project) {
        project = await prisma.project.create({
            data: {
                name: name || projectSlug,
                gitURL: gitURL,
                subDomain: projectSlug
            }
        })
    }

    // 2. Create Deployment record
    const deployment = await prisma.deployment.create({
        data: {
            projectId: project.id,
            status: 'IN_PROGRESS'
        }
    })

    // 3. Spin the ECS container
    const command = new RunTaskCommand({
        cluster: config.CLUSTER,
        taskDefinition: config.TASK,
        launchType: 'FARGATE',
        count: 1,
        networkConfiguration: {
            awsvpcConfiguration: {
                assignPublicIp: 'ENABLED',
                subnets: process.env.ECS_SUBNETS ? process.env.ECS_SUBNETS.split(',').map(s => s.trim()) : [],
                securityGroups: process.env.ECS_SECURITY_GROUPS ? process.env.ECS_SECURITY_GROUPS.split(',').map(s => s.trim()) : []
            }
        },
        overrides: {
            containerOverrides: [
                {
                    name: process.env.CONTAINER_NAME || 'builder-image',
                    environment: [
                        { name: 'GIT_REPOSITORY__URL', value: gitURL },
                        { name: 'PROJECT_ID', value: projectSlug },
                        { name: 'DEPLOYMENT_ID', value: deployment.id },
                        { name: 'AWS_ACCESS_KEY_ID', value: process.env.AWS_ACCESS_KEY_ID || '' },
                        { name: 'AWS_SECRET_ACCESS_KEY', value: process.env.AWS_SECRET_ACCESS_KEY || '' },
                        { name: 'AWS_REGION', value: process.env.AWS_REGION || 'ap-south-1' },
                        { name: 'S3_BUCKET_NAME', value: process.env.S3_BUCKET_NAME || '' },
                        { name: 'REDIS_URL', value: process.env.REDIS_URL || '' },
                        { name: 'KAFKA_BROKERS', value: process.env.KAFKA_BROKERS || '' },
                        { name: 'KAFKA_TOPIC', value: process.env.KAFKA_TOPIC || 'container-logs' },
                        { name: 'KAFKA_USERNAME', value: process.env.KAFKA_USERNAME || '' },
                        { name: 'KAFKA_PASSWORD', value: process.env.KAFKA_PASSWORD || '' },
                        { name: 'KAFKA_SASL_MECHANISM', value: process.env.KAFKA_SASL_MECHANISM || 'scram-sha-256' }
                    ]
                }
            ]
        }
    })

    try {
        await ecsClient.send(command);
        console.log(`[ECS] Successfully queued ECS task for project: ${projectSlug}`);
    } catch (ecsError) {
        console.error(`[ECS ERROR] Failed to launch ECS task for ${projectSlug}:`, ecsError.message);
    }

    return res.json({
        status: 'queued',
        data: {
            project,
            deployment,
            url: `http://${projectSlug}.localhost:8000`,
            logsStreamUrl: `http://localhost:${PORT}/logs/stream/${projectSlug}`,
            logsHistoryUrl: `http://localhost:${PORT}/logs/history/${projectSlug}`
        }
    })
})

async function handleLogMessage(projectSlug, messageObj, options = {}) {
    const rawMessage = typeof messageObj === 'string' ? messageObj : JSON.stringify(messageObj);
    const logText = typeof messageObj === 'object' && messageObj.log ? messageObj.log : messageObj;
    const deploymentId = typeof messageObj === 'object' && messageObj.deploymentId ? messageObj.deploymentId : '';
    const timestamp = typeof messageObj === 'object' && messageObj.timestamp ? messageObj.timestamp : Date.now();

    console.log(`[BUILD LOG] [logs:${projectSlug}]:`, logText)

    // Publish to Redis Pub/Sub (drives SSE subscribers) if not already coming from Redis subscriber
    if (!options.skipRedisPublish && redisPublisher) {
        try {
            await redisPublisher.publish(`logs:${projectSlug}`, rawMessage);
        } catch (redisErr) {
            // Silently catch Redis errors e.g. quota limits so API server keeps running
        }
    }

    // Emit to Socket.io for legacy/socket clients
    io.to(`logs:${projectSlug}`).emit('message', rawMessage);

    // Store log into Aiven ClickHouse for historical retention
    await insertLog({
        projectId: projectSlug,
        deploymentId,
        log: logText,
        timestamp
    });

    // Check for build & upload completion to update DB
    if (typeof logText === 'string' && logText.trim() === 'Done') {
        console.log(`\n===============================================================`)
        console.log(` [DEPLOYMENT SUCCESSFUL] Project '${projectSlug}' is now LIVE!`)
        console.log(` Access URL: http://${projectSlug}.localhost:8000`)
        console.log(`===============================================================\n`)

        try {
            const project = await prisma.project.findUnique({ where: { subDomain: projectSlug } })
            if (project) {
                await prisma.deployment.updateMany({
                    where: { projectId: project.id, status: 'IN_PROGRESS' },
                    data: { status: 'READY' }
                })
            }
        } catch (e) {
            console.error('Failed to update deployment status in DB:', e.message)
        }
    }
}

async function initLogConsumer() {
    let kafkaStarted = false;
    if (process.env.KAFKA_BROKERS) {
        try {
            const brokers = process.env.KAFKA_BROKERS.split(',').map(b => b.trim())
            const kafkaConfig = {
                clientId: process.env.KAFKA_CLIENT_ID || 'api-server-consumer',
                brokers,
                retry: {
                    initialRetryTime: 300,
                    retries: 5
                }
            }

            if (process.env.KAFKA_USERNAME && process.env.KAFKA_PASSWORD) {
                kafkaConfig.sasl = {
                    mechanism: process.env.KAFKA_SASL_MECHANISM || 'scram-sha-256',
                    username: process.env.KAFKA_USERNAME,
                    password: process.env.KAFKA_PASSWORD
                }
                kafkaConfig.ssl = { rejectUnauthorized: false }
            }

            const kafka = new Kafka(kafkaConfig)
            const topic = process.env.KAFKA_TOPIC || 'container-logs'

            try {
                const admin = kafka.admin()
                await admin.connect()
                const existingTopics = await admin.listTopics()
                if (!existingTopics.includes(topic)) {
                    await admin.createTopics({
                        topics: [{ topic, numPartitions: 1 }]
                    })
                    console.log(`[KAFKA ADMIN] Created topic: ${topic}`)
                }
                await admin.disconnect()
            } catch (adminErr) {
                console.log(`[KAFKA ADMIN] Topic check note:`, adminErr.message)
            }

            const consumer = kafka.consumer({ groupId: process.env.KAFKA_GROUP_ID || 'log-consumers' })
            await consumer.connect()
            await consumer.subscribe({ topic, fromBeginning: false })
            console.log(`[KAFKA CONSUMER] Subscribed to topic: ${topic}`)

            await consumer.run({
                eachMessage: async ({ topic, partition, message }) => {
                    try {
                        const payload = JSON.parse(message.value.toString())
                        const projectSlug = payload.projectId || (message.key ? message.key.toString() : 'unknown')
                        await handleLogMessage(projectSlug, payload)
                    } catch (err) {
                        console.error('[KAFKA CONSUMER] Error processing log message:', err.message)
                    }
                }
            })
            kafkaStarted = true;
        } catch (err) {
            console.error('[KAFKA CONSUMER] Failed to start Kafka consumer:', err.message)
        }
    }

    // Direct Redis Pub/Sub subscriber (Fallback mode ONLY if Kafka is inactive)
    if (!kafkaStarted) {
        console.log('[REDIS SUBSCRIBER] Subscribed to logs:* (Fallback mode)')
        const subscriber = createSafeRedisClient(process.env.REDIS_URL || 'redis://localhost:6379', 'REDIS SUB')
        if (subscriber) {
            subscriber.psubscribe('logs:*')
            subscriber.on('pmessage', async (pattern, channel, message) => {
                const projectSlug = channel.split(':')[1] || channel;
                let parsed = message;
                try {
                    parsed = JSON.parse(message);
                } catch (e) {}
                await handleLogMessage(projectSlug, parsed, { skipRedisPublish: true });
            })
        }
    }
}

async function startServer() {
    await initClickHouse()
    await initLogConsumer()
    app.listen(PORT, () => console.log(`API Server Running on port ${PORT}`))
}

startServer()