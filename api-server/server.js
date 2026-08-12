require('dotenv').config()
const express = require('express')
const { generateSlug } = require('random-word-slugs')
const { ECSClient, RunTaskCommand } = require('@aws-sdk/client-ecs')
const { Server } = require('socket.io')
const Redis = require('ioredis')

const app = express()
const PORT = process.env.PORT || 9000
const SOCKET_PORT = process.env.SOCKET_PORT || 9002

const subscriber = new Redis(process.env.REDIS_URL || '')

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

const config = {
    CLUSTER: process.env.ECS_CLUSTER || '',
    TASK: process.env.ECS_TASK_DEFINITION || ''
}

app.use(express.json())

app.post('/project', async (req, res) => {
    const { gitURL, slug } = req.body
    const projectSlug = slug ? slug : generateSlug()

    // Spin the container
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
                        { name: 'AWS_ACCESS_KEY_ID', value: process.env.AWS_ACCESS_KEY_ID || '' },
                        { name: 'AWS_SECRET_ACCESS_KEY', value: process.env.AWS_SECRET_ACCESS_KEY || '' },
                        { name: 'AWS_REGION', value: process.env.AWS_REGION || 'ap-south-1' },
                        { name: 'S3_BUCKET_NAME', value: process.env.S3_BUCKET_NAME || '' },
                        { name: 'REDIS_URL', value: process.env.REDIS_URL || '' }
                    ]
                }
            ]
        }
    })

    await ecsClient.send(command);

    return res.json({ status: 'queued', data: { projectSlug, url: `http://${projectSlug}.localhost:8000` } })

})

async function initRedisSubscribe() {
    console.log('Subscribed to logs....')
    subscriber.psubscribe('logs:*')
    subscriber.on('pmessage', (pattern, channel, message) => {
        const projectSlug = channel.split(':')[1] || channel;
        console.log(`[BUILD LOG] [${channel}]:`, message)

        try {
            const parsed = typeof message === 'string' ? JSON.parse(message) : message;
            if (parsed && (parsed.log === 'Done' || parsed.log === 'Build Complete')) {
                console.log(`\n===============================================================`)
                console.log(` [DEPLOYMENT SUCCESSFUL] Project '${projectSlug}' is now LIVE!`)
                console.log(` Access URL: http://${projectSlug}.localhost:8000`)
                console.log(`===============================================================\n`)
            }
        } catch (e) {
            if (typeof message === 'string' && message.includes('Done')) {
                console.log(`\n===============================================================`)
                console.log(`[DEPLOYMENT SUCCESSFUL] Project '${projectSlug}' is now LIVE!`)
                console.log(`Access URL: http://${projectSlug}.localhost:8000`)
                console.log(`===============================================================\n`)
            }
        }

        io.to(channel).emit('message', message)
    })
}



initRedisSubscribe()

app.listen(PORT, () => console.log(`API Server Running on port ${PORT}`))