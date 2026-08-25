const { Pool } = require('pg')
const { PrismaPg } = require('@prisma/adapter-pg')
const { PrismaClient } = require('@prisma/client')

const connectionString = process.env.DATABASE_URL || process.env.DIRECT_URL
console.log('[DB CONNECTING]: Using connection string:', connectionString ? connectionString.replace(/:[^:@]+@/, ':****@') : 'NONE')

const pool = new Pool({ connectionString })
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })

module.exports = { prisma }
