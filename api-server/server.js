require('dns').setDefaultResultOrder('ipv4first')
require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { generateSlug } = require('random-word-slugs')

const { prisma } = require('./db')
const { createSafeRedisClient } = require('./redis')
const { launchBuildContainer } = require('./ecs')
const { initClickHouse, getLogsByProjectId } = require('./clickhouse')
const { initLogConsumer } = require('./services/logConsumer')

const app = express()
const PORT = process.env.PORT || 9000

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
    await launchBuildContainer({
        gitURL,
        projectSlug,
        deploymentId: deployment.id
    })

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

async function startServer() {
    await initClickHouse()
    await initLogConsumer()
    app.listen(PORT, () => console.log(`API Server Running on port ${PORT}`))
}

startServer()