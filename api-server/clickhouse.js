const { createClient } = require('@clickhouse/client')
const { v4: uuidv4 } = require('crypto')

const host = process.env.CLICKHOUSE_HOST || ''
const username = process.env.CLICKHOUSE_USER || 'default'
const password = process.env.CLICKHOUSE_PASSWORD || ''
const database = process.env.CLICKHOUSE_DATABASE || 'default'

let clickhouseClient = null

if (host) {
    clickhouseClient = createClient({
        url: host.startsWith('http') ? host : `https://${host}`,
        username,
        password,
        database,
        clickhouse_settings: {
            async_insert: 1,
            wait_for_async_insert: 0
        }
    })
}

async function initClickHouse() {
    if (!clickhouseClient) {
        console.log('[CLICKHOUSE] CLICKHOUSE_HOST not set. ClickHouse historical log storage disabled.')
        return false
    }

    try {
        await clickhouseClient.exec({
            query: `
                CREATE TABLE IF NOT EXISTS build_logs (
                    event_id String,
                    project_id String,
                    deployment_id String,
                    log String,
                    timestamp DateTime64(3)
                ) ENGINE = MergeTree()
                ORDER BY (project_id, timestamp)
            `
        })
        console.log('[CLICKHOUSE] Connected to Aiven ClickHouse & table `build_logs` verified successfully.')
        return true
    } catch (err) {
        console.error('[CLICKHOUSE] Failed to initialize ClickHouse:', err.message)
        return false
    }
}

let logBuffer = []
let batchTimer = null

function flushBuffer() {
    if (logBuffer.length === 0 || !clickhouseClient) return
    const recordsToInsert = [...logBuffer]
    logBuffer = []

    clickhouseClient.insert({
        table: 'build_logs',
        values: recordsToInsert,
        format: 'JSONEachRow'
    }).catch(err => {
        console.error('[CLICKHOUSE] Error in batch insert:', err.message)
    })
}

async function insertLog(logData) {
    if (!clickhouseClient) return

    const record = {
        event_id: logData.eventId || (typeof uuidv4 === 'function' ? uuidv4() : `${Date.now()}-${Math.random()}`),
        project_id: logData.projectId || 'unknown',
        deployment_id: logData.deploymentId || '',
        log: typeof logData.log === 'string' ? logData.log : JSON.stringify(logData.log),
        timestamp: new Date(logData.timestamp || Date.now()).toISOString().replace('T', ' ').replace('Z', '')
    }

    logBuffer.push(record)

    if (logBuffer.length >= 100) {
        flushBuffer()
    } else if (!batchTimer) {
        batchTimer = setTimeout(() => {
            batchTimer = null
            flushBuffer()
        }, 1000)
    }
}

async function getLogsByProjectId(projectId) {
    if (!clickhouseClient) {
        return { status: 'error', message: 'ClickHouse is not configured on this server.' }
    }

    try {
        const resultSet = await clickhouseClient.query({
            query: `SELECT event_id, project_id, deployment_id, log, timestamp FROM build_logs WHERE project_id = {projectId: String} ORDER BY timestamp ASC`,
            query_params: { projectId },
            format: 'JSONEachRow'
        })

        const logs = await resultSet.json()
        return { status: 'success', data: logs }
    } catch (err) {
        console.error('[CLICKHOUSE] Error querying logs from ClickHouse:', err.message)
        return { status: 'error', message: err.message }
    }
}

module.exports = {
    initClickHouse,
    insertLog,
    getLogsByProjectId
}
