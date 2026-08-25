const { ECSClient, RunTaskCommand } = require('@aws-sdk/client-ecs')

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

async function launchBuildContainer({ gitURL, projectSlug, deploymentId }) {
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
                        { name: 'DEPLOYMENT_ID', value: deploymentId },
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
        await ecsClient.send(command)
        console.log(`[ECS] Successfully queued ECS task for project: ${projectSlug}`)
    } catch (ecsError) {
        console.error(`[ECS ERROR] Failed to launch ECS task for ${projectSlug}:`, ecsError.message)
    }
}

module.exports = {
    ecsClient,
    launchBuildContainer
}
