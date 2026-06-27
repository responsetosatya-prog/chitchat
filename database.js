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
        // Users table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                username VARCHAR(50) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                display_name VARCHAR(100),
                avatar VARCHAR(255),
                status VARCHAR(50) DEFAULT 'online',
                last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Friends/contacts table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS friends (
                id SERIAL PRIMARY KEY,
                user_id UUID REFERENCES users(id) ON DELETE CASCADE,
                friend_id UUID REFERENCES users(id) ON DELETE CASCADE,
                status VARCHAR(20) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, friend_id)
            )
        `);

        // Groups table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS groups (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                name VARCHAR(100) NOT NULL,
                description TEXT,
                created_by UUID REFERENCES users(id),
                avatar VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Group members
        await pool.query(`
            CREATE TABLE IF NOT EXISTS group_members (
                group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
                user_id UUID REFERENCES users(id) ON DELETE CASCADE,
                role VARCHAR(20) DEFAULT 'member',
                joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (group_id, user_id)
            )
        `);

        // Messages table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                sender_id UUID REFERENCES users(id),
                receiver_id UUID REFERENCES users(id),
                group_id UUID REFERENCES groups(id),
                content TEXT,
                file_url VARCHAR(255),
                file_type VARCHAR(50),
                message_type VARCHAR(20) DEFAULT 'text',
                is_read BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CHECK (
                    (receiver_id IS NOT NULL AND group_id IS NULL) OR
                    (group_id IS NOT NULL AND receiver_id IS NULL)
                )
            )
        `);

        // Sessions table (for persistence)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS sessions (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID REFERENCES users(id) ON DELETE CASCADE,
                token VARCHAR(255) UNIQUE NOT NULL,
                expires_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP + INTERVAL '30 days',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        console.log('✅ Database tables created');
    } catch (error) {
        console.error('❌ Table creation error:', error.message);
    }
}

// User functions
async function createUser(username, password, displayName) {
    if (!pool) return null;
    try {
        const result = await pool.query(
            `INSERT INTO users (username, password, display_name) 
             VALUES ($1, $2, $3) 
             RETURNING id, username, display_name`,
            [username, password, displayName || username]
        );
        return result.rows[0];
    } catch (error) {
        console.error('❌ Create user error:', error.message);
        return null;
    }
}

async function getUserByUsername(username) {
    if (!pool) return null;
    try {
        const result = await pool.query(
            'SELECT * FROM users WHERE username = $1',
            [username]
        );
        return result.rows[0] || null;
    } catch (error) {
        console.error('❌ Get user error:', error.message);
        return null;
    }
}

async function getUserById(id) {
    if (!pool) return null;
    try {
        const result = await pool.query(
            'SELECT id, username, display_name, avatar, status, last_seen FROM users WHERE id = $1',
            [id]
        );
        return result.rows[0] || null;
    } catch (error) {
        console.error('❌ Get user error:', error.message);
        return null;
    }
}

async function searchUsers(query) {
    if (!pool) return [];
    try {
        const result = await pool.query(
            `SELECT id, username, display_name, avatar, status 
             FROM users 
             WHERE username ILIKE $1 OR display_name ILIKE $1
             LIMIT 20`,
            [`%${query}%`]
        );
        return result.rows;
    } catch (error) {
        console.error('❌ Search error:', error.message);
        return [];
    }
}

// Session functions
async function createSession(userId, token) {
    if (!pool) return null;
    try {
        await pool.query(
            `INSERT INTO sessions (user_id, token, expires_at) 
             VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
            [userId, token]
        );
        return true;
    } catch (error) {
        console.error('❌ Create session error:', error.message);
        return false;
    }
}

async function getSessionByToken(token) {
    if (!pool) return null;
    try {
        const result = await pool.query(
            `SELECT user_id FROM sessions 
             WHERE token = $1 AND expires_at > NOW()`,
            [token]
        );
        return result.rows[0] || null;
    } catch (error) {
        console.error('❌ Get session error:', error.message);
        return null;
    }
}

async function deleteSession(token) {
    if (!pool) return;
    try {
        await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
    } catch (error) {
        console.error('❌ Delete session error:', error.message);
    }
}

// Message functions
async function saveMessage(senderId, receiverId, groupId, content, fileUrl, fileType, messageType) {
    if (!pool) return null;
    try {
        const result = await pool.query(
            `INSERT INTO messages (sender_id, receiver_id, group_id, content, file_url, file_type, message_type)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id, created_at`,
            [senderId, receiverId, groupId, content, fileUrl, fileType, messageType || 'text']
        );
        return result.rows[0];
    } catch (error) {
        console.error('❌ Save message error:', error.message);
        return null;
    }
}

async function getMessages(userId, otherId, limit = 50, offset = 0) {
    if (!pool) return [];
    try {
        const result = await pool.query(
            `SELECT m.*, u.username, u.display_name 
             FROM messages m
             JOIN users u ON m.sender_id = u.id
             WHERE (m.sender_id = $1 AND m.receiver_id = $2)
                OR (m.sender_id = $2 AND m.receiver_id = $1)
             ORDER BY m.created_at DESC
             LIMIT $3 OFFSET $4`,
            [userId, otherId, limit, offset]
        );
        return result.rows.reverse();
    } catch (error) {
        console.error('❌ Get messages error:', error.message);
        return [];
    }
}

async function getGroupMessages(groupId, limit = 50, offset = 0) {
    if (!pool) return [];
    try {
        const result = await pool.query(
            `SELECT m.*, u.username, u.display_name 
             FROM messages m
             JOIN users u ON m.sender_id = u.id
             WHERE m.group_id = $1
             ORDER BY m.created_at DESC
             LIMIT $2 OFFSET $3`,
            [groupId, limit, offset]
        );
        return result.rows.reverse();
    } catch (error) {
        console.error('❌ Get group messages error:', error.message);
        return [];
    }
}

// Group functions
async function createGroup(name, description, createdBy) {
    if (!pool) return null;
    try {
        const result = await pool.query(
            `INSERT INTO groups (name, description, created_by)
             VALUES ($1, $2, $3)
             RETURNING id, name`,
            [name, description, createdBy]
        );
        const group = result.rows[0];
        // Add creator as admin
        await pool.query(
            `INSERT INTO group_members (group_id, user_id, role)
             VALUES ($1, $2, 'admin')`,
            [group.id, createdBy]
        );
        return group;
    } catch (error) {
        console.error('❌ Create group error:', error.message);
        return null;
    }
}

async function addGroupMember(groupId, userId) {
    if (!pool) return false;
    try {
        await pool.query(
            `INSERT INTO group_members (group_id, user_id)
             VALUES ($1, $2)
             ON CONFLICT (group_id, user_id) DO NOTHING`,
            [groupId, userId]
        );
        return true;
    } catch (error) {
        console.error('❌ Add group member error:', error.message);
        return false;
    }
}

async function getUserGroups(userId) {
    if (!pool) return [];
    try {
        const result = await pool.query(
            `SELECT g.*, gm.role 
             FROM groups g
             JOIN group_members gm ON g.id = gm.group_id
             WHERE gm.user_id = $1`,
            [userId]
        );
        return result.rows;
    } catch (error) {
        console.error('❌ Get user groups error:', error.message);
        return [];
    }
}

// Friend functions
async function addFriend(userId, friendId) {
    if (!pool) return false;
    try {
        await pool.query(
            `INSERT INTO friends (user_id, friend_id, status)
             VALUES ($1, $2, 'accepted')
             ON CONFLICT (user_id, friend_id) DO UPDATE SET status = 'accepted'`,
            [userId, friendId]
        );
        return true;
    } catch (error) {
        console.error('❌ Add friend error:', error.message);
        return false;
    }
}

async function getFriends(userId) {
    if (!pool) return [];
    try {
        const result = await pool.query(
            `SELECT u.id, u.username, u.display_name, u.avatar, u.status
             FROM friends f
             JOIN users u ON f.friend_id = u.id
             WHERE f.user_id = $1 AND f.status = 'accepted'
             UNION
             SELECT u.id, u.username, u.display_name, u.avatar, u.status
             FROM friends f
             JOIN users u ON f.user_id = u.id
             WHERE f.friend_id = $1 AND f.status = 'accepted'`,
            [userId]
        );
        return result.rows;
    } catch (error) {
        console.error('❌ Get friends error:', error.message);
        return [];
    }
}

module.exports = {
    initDatabase,
    createTables,
    createUser,
    getUserByUsername,
    getUserById,
    searchUsers,
    createSession,
    getSessionByToken,
    deleteSession,
    saveMessage,
    getMessages,
    getGroupMessages,
    createGroup,
    addGroupMember,
    getUserGroups,
    addFriend,
    getFriends,
    getPool: () => pool
};
