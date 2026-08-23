require('dotenv').config()
const { exec } = require('child_process')
const path = require('path')
const fs = require('fs')
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3')
const mime = require('mime-types')
const Redis = require('ioredis')
const { Kafka, Partitioners } = require('kafkajs')

const PROJECT_ID = process.env.PROJECT_ID
const DEPLOYMENT_ID = process.env.DEPLOYMENT_ID || ''
const BUCKET_NAME = process.env.S3_BUCKET_NAME || 'vercel-clone-outputs'
const KAFKA_TOPIC = process.env.KAFKA_TOPIC || 'container-logs'

let kafkaProducer = null;
let fallbackPublisher = null;

if (process.env.REDIS_URL) {
    fallbackPublisher = new Redis(process.env.REDIS_URL)
    fallbackPublisher.on('error', err => {
        console.error('[REDIS FALLBACK ERROR]', err ? err.message : err)
    })
}

const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'ap-south-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
    }
})

let pendingLogPromises = [];

async function initKafka() {
    if (!process.env.KAFKA_BROKERS) {
        console.log('[LOG PRODUCER] KAFKA_BROKERS not set. Using direct Redis Pub/Sub fallback.')
        return false
    }

    try {
        const brokers = process.env.KAFKA_BROKERS.split(',').map(b => b.trim())
        const kafkaConfig = {
            clientId: process.env.KAFKA_CLIENT_ID || `builder-${PROJECT_ID || 'client'}`,
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
        kafkaProducer = kafka.producer({ createPartitioner: Partitioners.DefaultPartitioner })
        await kafkaProducer.connect()
        console.log('[LOG PRODUCER] Kafka Producer connected successfully.')
        return true
    } catch (err) {
        console.error('[LOG PRODUCER] Failed to connect Kafka Producer:', err.message)
        console.log('[LOG PRODUCER] Using direct Redis Pub/Sub fallback.')
        kafkaProducer = null
        return false
    }
}

async function publishLog(log) {
    const payload = {
        projectId: PROJECT_ID,
        deploymentId: DEPLOYMENT_ID,
        log,
        timestamp: Date.now()
    }

    if (kafkaProducer) {
        try {
            await kafkaProducer.send({
                topic: KAFKA_TOPIC,
                messages: [
                    {
                        key: PROJECT_ID || 'default',
                        value: JSON.stringify(payload)
                    }
                ]
            })
            return
        } catch (err) {
            console.error('[LOG PRODUCER] Kafka send error:', err.message)
        }
    }

    if (fallbackPublisher && PROJECT_ID) {
        try {
            await fallbackPublisher.publish(`logs:${PROJECT_ID}`, JSON.stringify(payload))
        } catch (e) {
            console.error('[REDIS PUBLISH ERROR]', e ? e.message : e)
        }
    } else {
        console.log(`[LOG] [${PROJECT_ID}]:`, log)
    }
}

async function cleanup() {
    if (pendingLogPromises.length > 0) {
        await Promise.allSettled(pendingLogPromises)
        pendingLogPromises = []
    }
    if (kafkaProducer) {
        try {
            await kafkaProducer.disconnect()
        } catch (e) {}
    }
    if (fallbackPublisher) {
        try {
            await fallbackPublisher.quit()
        } catch (e) {}
    }
}

async function init() {
    await initKafka()
    console.log('Executing script.js')
    await publishLog('Build Started...')
    const outDirPath = path.join(__dirname, 'output')

    if (!fs.existsSync(outDirPath)) {
        const errMsg = `Error: Output directory does not exist at ${outDirPath}. Please ensure repository is cloned into 'output' (e.g. via main.sh).`
        console.error(errMsg)
        await publishLog(errMsg)
        await cleanup()
        process.exit(1)
    }

    const p = exec(`cd ${outDirPath} && npm install && npm run build`)

    function handleStreamData(data, isError = false) {
        const lines = data.toString().split('\n')
        for (const line of lines) {
            const trimmed = line.trim()
            if (trimmed.length > 0) {
                if (isError) console.error(trimmed)
                else console.log(trimmed)
                const promise = publishLog(trimmed).catch(() => {})
                pendingLogPromises.push(promise)
            }
        }
    }

    p.stdout.on('data', data => handleStreamData(data, false))
    p.stderr.on('data', data => handleStreamData(data, true))

    p.on('close', async function (code) {
        if (code !== 0) {
            const errMsg = `Build process exited with non-zero code ${code}`
            console.error(errMsg)
            await publishLog(errMsg)
            await cleanup()
            process.exit(1)
        }

        console.log('Build Complete')
        await publishLog(`Build Complete`)
        let distFolderPath = path.join(__dirname, 'output', 'dist')
        if (!fs.existsSync(distFolderPath)) {
            if (fs.existsSync(path.join(__dirname, 'output', 'build'))) {
                distFolderPath = path.join(__dirname, 'output', 'build')
            } else if (fs.existsSync(path.join(__dirname, 'output', 'out'))) {
                distFolderPath = path.join(__dirname, 'output', 'out')
            }
        }

        if (!fs.existsSync(distFolderPath)) {
            await publishLog(`Error: Could not find build output directory (tried dist, build, out)`)
            await cleanup()
            process.exit(1)
        }

        const distFolderContents = fs.readdirSync(distFolderPath, { recursive: true })

        await publishLog(`Starting to upload`)
        for (const file of distFolderContents) {
            const filePath = path.join(distFolderPath, file)
            if (fs.lstatSync(filePath).isDirectory()) continue;

            console.log('uploading', filePath)
            await publishLog(`uploading ${file}`)

            const command = new PutObjectCommand({
                Bucket: BUCKET_NAME,
                Key: `__outputs/${PROJECT_ID}/${file}`,
                Body: fs.createReadStream(filePath),
                ContentType: mime.lookup(filePath)
            })

            await s3Client.send(command)
            await publishLog(`uploaded ${file}`)
            console.log('uploaded', filePath)
        }
        await publishLog(`Done`)
        console.log('Done...')
        await cleanup()
        process.exit(0)
    })
}

init()