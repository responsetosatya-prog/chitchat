const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config();

const db = require('./database');

const app = express();
app.use(cors());
app.use(express.json());

const pool = db.initDatabase();
db.createTables();

// COUPLE'S CREDENTIALS
const COUPLE_CREDENTIALS = {
    username: process.env.COUPLE_USERNAME || 'love',
    password: process.env.COUPLE_PASSWORD || 'iloveyou2024'
};

// Generate a unique room code
function generateCoupleRoom() {
    return 'LOVE' + crypto.randomBytes(2).toString('hex').toUpperCase();
}

// Store active connections
const rooms = new Map();

// Auth middleware
function authenticate(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    const base64Credentials = authHeader.split(' ')[1];
    const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
    const [username, password] = credentials.split(':');

    if (username === COUPLE_CREDENTIALS.username && password === COUPLE_CREDENTIALS.password) {
        next();
    } else {
        res.status(401).json({ error: 'Invalid credentials' });
    }
}

// Protected health check
app.get('/health', authenticate, async (req, res) => {
    try {
        const stats = await db.getStorageStats();
        res.json({ 
            status: 'online',
            couple: '💕 Connected',
            storage: stats,
            activeConnections: Array.from(rooms.keys()).reduce((sum, key) => sum + rooms.get(key).size, 0),
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get room history
app.get('/api/rooms/:roomCode/messages', authenticate, async (req, res) => {
    const { roomCode } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    
    try {
        const messages = await db.getRecentMessages(roomCode, limit);
        res.json({ 
            messages,
            count: messages.length,
            couple: '💕 Your private messages'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Create a new room
app.post('/api/create-room', authenticate, async (req, res) => {
    try {
        const roomCode = generateCoupleRoom();
        
        await db.getPool().query(
            `INSERT INTO rooms (room_code, expires_at) 
             VALUES ($1, NOW() + INTERVAL '24 hours')`,
            [roomCode]
        );
        
        res.json({ 
            roomCode,
            message: '💕 Your private room is ready!',
            expiresIn: '24 hours'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Cleanup expired messages
app.post('/api/cleanup', authenticate, async (req, res) => {
    try {
        const deleted = await db.deleteExpiredMessages();
        const stats = await db.getStorageStats();
        res.json({ 
            deleted,
            stats,
            couple: '💕 Cleaned up!'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// WebSocket connection
wss.on('connection', (ws, req) => {
    console.log('New connection attempt');
    let clientRoom = null;
    let clientName = null;
    let isAuthenticated = false;

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            
            // Handle authentication
            if (data.type === 'auth') {
                const { username, password } = data;
                
                if (username === COUPLE_CREDENTIALS.username && 
                    password === COUPLE_CREDENTIALS.password) {
                    isAuthenticated = true;
                    ws.send(JSON.stringify({
                        type: 'auth_success',
                        message: '💕 Welcome! You are now connected.'
                    }));
                    console.log('✅ Client authenticated successfully');
                } else {
                    ws.send(JSON.stringify({
                        type: 'auth_error',
                        message: '❌ Invalid credentials. Access denied!'
                    }));
                    ws.close();
                }
                return;
            }

            // All other messages require authentication
            if (!isAuthenticated) {
                ws.send(JSON.stringify({
                    type: 'error',
                    message: '❌ Please authenticate first'
                }));
                ws.close();
                return;
            }

            switch(data.type) {
                case 'join':
                    const roomCode = data.roomCode;
                    clientName = data.name || '💕 Partner';
                    
                    // Check if room exists
                    const roomExists = await db.getPool().query(
                        'SELECT room_code FROM rooms WHERE room_code = $1 AND expires_at > NOW()',
                        [roomCode]
                    );

                    // If room doesn't exist, CREATE IT
                    if (roomExists.rows.length === 0) {
                        console.log(`🆕 Creating new room: ${roomCode}`);
                        await db.getPool().query(
                            `INSERT INTO rooms (room_code, expires_at) 
                             VALUES ($1, NOW() + INTERVAL '24 hours')`,
                            [roomCode]
                        );
                    }

                    // Add to WebSocket room
                    if (!rooms.has(roomCode)) {
                        rooms.set(roomCode, new Set());
                    }
                    rooms.get(roomCode).add(ws);
                    clientRoom = roomCode;
                    
                    // Load recent messages
                    const recentMessages = await db.getRecentMessages(roomCode, 50);
                    
                    // Send confirmation with history
                    ws.send(JSON.stringify({
                        type: 'joined',
                        roomCode: roomCode,
                        message: `💕 Welcome to your private room!`,
                        users: rooms.get(roomCode).size,
                        history: recentMessages,
                        couple: true
                    }));

                    // Send history
                    for (const msg of recentMessages) {
                        ws.send(JSON.stringify({
                            type: 'message',
                            text: msg.text,
                            sender: msg.sender,
                            time: new Date(msg.time).toLocaleTimeString(),
                            isHistory: true
                        }));
                    }
                    
                    // Notify partner
                    broadcastToRoom(roomCode, {
                        type: 'system',
                        message: `💕 Your partner joined the chat!`,
                        sender: 'system'
                    }, ws);
                    
                    console.log(`💕 Partner joined room: ${roomCode}`);
                    break;
                    
                case 'message':
                    if (clientRoom && rooms.has(clientRoom) && isAuthenticated) {
                        const saved = await db.saveMessage(
                            clientRoom,
                            clientName,
                            data.text,
                            data.time
                        );
                        
                        if (saved) {
                            broadcastToRoom(clientRoom, {
                                type: 'message',
                                text: data.text,
                                sender: clientName,
                                time: data.time || new Date().toLocaleTimeString()
                            }, ws);
                        }
                    }
                    break;
                    
                case 'leave':
                    leaveRoom(ws, clientRoom, clientName);
                    break;
            }
        } catch (error) {
            console.error('Error processing message:', error);
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Failed to process message'
            }));
        }
    });

    ws.on('close', () => {
        leaveRoom(ws, clientRoom, clientName);
        console.log('Client disconnected');
    });
});

function leaveRoom(ws, roomCode, name) {
    if (roomCode && rooms.has(roomCode)) {
        rooms.get(roomCode).delete(ws);
        const remainingUsers = rooms.get(roomCode).size;
        
        if (remainingUsers === 0) {
            rooms.delete(roomCode);
            console.log(`Room ${roomCode} closed`);
        } else {
            broadcastToRoom(roomCode, {
                type: 'system',
                message: `💕 Your partner left the chat`,
                sender: 'system'
            });
        }
    }
}

function broadcastToRoom(roomCode, data, exclude = null) {
    if (rooms.has(roomCode)) {
        const clients = rooms.get(roomCode);
        const message = JSON.stringify(data);
        clients.forEach(client => {
            if (client !== exclude && client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        });
    }
}

// Auto-delete every 30 minutes
setInterval(async () => {
    await db.deleteExpiredMessages();
}, 1800000);

// Initial cleanup
setTimeout(async () => {
    await db.deleteExpiredMessages();
    console.log('🧹 Initial cleanup complete');
}, 5000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`💕 Couple's Private Chat`);
    console.log(`📡 WebSocket ready`);
    console.log(`⏰ Messages auto-delete after 24 hours`);
});
