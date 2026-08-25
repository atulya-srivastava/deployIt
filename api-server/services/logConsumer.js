const { Kafka } = require('kafkajs')
const { prisma } = require('../db')
const { redisPublisher, createSafeRedisClient } = require('../redis')
const { insertLog } = require('../clickhouse')

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

module.exports = {
    handleLogMessage,
    initLogConsumer
}
