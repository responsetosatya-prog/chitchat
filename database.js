const { Pool } = require('pg');

let pool;

function initDatabase() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
        console.error('❌ DATABASE_URL not set!');
        return null;
    }

    pool = new Pool({
        connectionString: connectionString,
        ssl: { rejectUnauthorized: false }
    });

    pool.query('SELECT NOW()', (err) => {
        if (err) {
            console.error('❌ Database error:', err.message);
        } else {
            console.log('✅ Database connected');
        }
    });

    return pool;
}

async function createTables() {
    if (!pool) return;
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS rooms (
                room_code VARCHAR(10) PRIMARY KEY,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                room_code VARCHAR(10) REFERENCES rooms(room_code),
                sender VARCHAR(50),
                text TEXT,
                time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ Tables created');
    } catch (error) {
        console.error('❌ Table creation error:', error.message);
    }
}

async function saveMessage(roomCode, sender, text, time) {
    if (!pool) return null;
    try {
        await pool.query(
            'INSERT INTO rooms (room_code) VALUES ($1) ON CONFLICT DO NOTHING',
            [roomCode]
        );
        const result = await pool.query(
            'INSERT INTO messages (room_code, sender, text, time) VALUES ($1, $2, $3, $4) RETURNING id',
            [roomCode, sender, text, time || new Date().toISOString()]
        );
        return result.rows[0];
    } catch (error) {
        console.error('❌ Save error:', error.message);
        return null;
    }
}

async function getRecentMessages(roomCode, limit = 50) {
    if (!pool) return [];
    try {
        const result = await pool.query(
            'SELECT sender, text, time FROM messages WHERE room_code = $1 ORDER BY time DESC LIMIT $2',
            [roomCode, limit]
        );
        return result.rows.reverse();
    } catch (error) {
        console.error('❌ Fetch error:', error.message);
        return [];
    }
}

async function deleteExpiredMessages() {
    // Simplified - just keep last 100 messages per room
    if (!pool) return;
    try {
        await pool.query(`
            DELETE FROM messages 
            WHERE id NOT IN (
                SELECT id FROM messages 
                ORDER BY time DESC 
                LIMIT 100
            )
        `);
    } catch (error) {
        console.error('❌ Cleanup error:', error.message);
    }
}

async function getStorageStats() {
    if (!pool) return null;
    try {
        const result = await pool.query(
            'SELECT COUNT(*) as total_messages FROM messages'
        );
        return { total_messages: result.rows[0].total_messages };
    } catch (error) {
        return null;
    }
}

module.exports = {
    initDatabase,
    createTables,
    saveMessage,
    getRecentMessages,
    deleteExpiredMessages,
    getStorageStats,
    getPool: () => pool
};
