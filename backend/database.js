const { Pool } = require('pg');

let pool;

function initDatabase() {
    const connectionString = process.env.DATABASE_URL;
    
    if (!connectionString) {
        console.error('❌ DATABASE_URL not set!');
        console.error('💡 Please set DATABASE_URL in your environment variables');
        process.exit(1);
    }

    pool = new Pool({
        connectionString: connectionString,
        ssl: {
            rejectUnauthorized: false
        }
    });

    pool.query('SELECT NOW()', (err, res) => {
        if (err) {
            console.error('❌ Database connection failed:', err.message);
        } else {
            console.log('✅ Database connected successfully');
        }
    });

    return pool;
}

async function createTables() {
    if (!pool) return;

    const queries = [
        `CREATE TABLE IF NOT EXISTS rooms (
            id SERIAL PRIMARY KEY,
            room_code VARCHAR(10) UNIQUE NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            expires_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP + INTERVAL '24 hours'
        )`,
        
        `CREATE TABLE IF NOT EXISTS messages (
            id SERIAL PRIMARY KEY,
            room_code VARCHAR(10) NOT NULL,
            sender VARCHAR(50) NOT NULL,
            text TEXT NOT NULL,
            time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            expires_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP + INTERVAL '24 hours',
            FOREIGN KEY (room_code) REFERENCES rooms(room_code) ON DELETE CASCADE
        )`,
        
        `CREATE INDEX IF NOT EXISTS idx_messages_room_code ON messages(room_code)`,
        `CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(time DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_messages_expires_at ON messages(expires_at)`,
        `CREATE INDEX IF NOT EXISTS idx_rooms_room_code ON rooms(room_code)`,
        `CREATE INDEX IF NOT EXISTS idx_rooms_expires_at ON rooms(expires_at)`,
        
        `CREATE OR REPLACE FUNCTION delete_expired_messages() 
         RETURNS void AS $$
         BEGIN
             DELETE FROM messages WHERE expires_at < NOW();
             DELETE FROM rooms WHERE expires_at < NOW();
         END;
         $$ LANGUAGE plpgsql;`
    ];

    try {
        for (const query of queries) {
            await pool.query(query);
        }
        console.log('✅ Database tables created/verified');
    } catch (error) {
        console.error('❌ Error creating tables:', error.message);
    }
}

async function saveMessage(roomCode, sender, text, time) {
    if (!pool) return null;

    try {
        await pool.query(
            `INSERT INTO rooms (room_code, expires_at) 
             VALUES ($1, NOW() + INTERVAL '24 hours')
             ON CONFLICT (room_code) 
             DO UPDATE SET 
                last_activity = CURRENT_TIMESTAMP,
                expires_at = NOW() + INTERVAL '24 hours'`,
            [roomCode]
        );

        const result = await pool.query(
            `INSERT INTO messages (room_code, sender, text, time, expires_at) 
             VALUES ($1, $2, $3, $4, NOW() + INTERVAL '24 hours') 
             RETURNING id, time`,
            [roomCode, sender, text, time || new Date().toISOString()]
        );

        return result.rows[0];
    } catch (error) {
        console.error('❌ Error saving message:', error.message);
        return null;
    }
}

async function getRecentMessages(roomCode, limit = 50) {
    if (!pool) return [];

    try {
        const result = await pool.query(
            `SELECT sender, text, time 
             FROM messages 
             WHERE room_code = $1 
               AND expires_at > NOW()
             ORDER BY time DESC 
             LIMIT $2`,
            [roomCode, limit]
        );

        return result.rows.reverse();
    } catch (error) {
        console.error('❌ Error fetching messages:', error.message);
        return [];
    }
}

async function deleteExpiredMessages() {
    if (!pool) return;

    try {
        const messageResult = await pool.query(
            `DELETE FROM messages WHERE expires_at < NOW()`
        );
        const roomResult = await pool.query(
            `DELETE FROM rooms WHERE expires_at < NOW()`
        );
        
        const totalDeleted = messageResult.rowCount + roomResult.rowCount;
        if (totalDeleted > 0) {
            console.log(`🧹 Deleted ${messageResult.rowCount} expired messages and ${roomResult.rowCount} expired rooms`);
        }
        return totalDeleted;
    } catch (error) {
        console.error('❌ Error deleting expired messages:', error.message);
        return 0;
    }
}

async function getStorageStats() {
    if (!pool) return null;

    try {
        const result = await pool.query(`
            SELECT 
                (SELECT COUNT(*) FROM messages) as total_messages,
                (SELECT COUNT(*) FROM messages WHERE expires_at > NOW()) as active_messages,
                (SELECT COUNT(*) FROM messages WHERE expires_at < NOW()) as expired_messages,
                (SELECT COUNT(*) FROM rooms) as total_rooms,
                (SELECT COUNT(*) FROM rooms WHERE expires_at > NOW()) as active_rooms
        `);
        return result.rows[0];
    } catch (error) {
        console.error('❌ Error getting storage stats:', error.message);
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
