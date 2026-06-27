const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
require('dotenv').config();

const db = require('./database');

const app = express();
app.use(cors());
app.use(express.json());

const pool = db.initDatabase();
db.createTables();

// Couple's credentials
const COUPLE_CREDENTIALS = {
    username: process.env.COUPLE_USERNAME || 'love',
    password: process.env.COUPLE_PASSWORD || 'iloveyou2024'
};

// Store rooms and clients
const rooms = new Map();

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'online',
        rooms: rooms.size,
        timestamp: new Date().toISOString()
    });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log('🔗 New client connected');
    let clientRoom = null;
    let clientName = null;
    let isAuthenticated = false;

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            console.log('📨 Received:', data.type);

            // Handle authentication
            if (data.type === 'auth') {
                const { username, password } = data;
                if (username === COUPLE_CREDENTIALS.username && 
                    password === COUPLE_CREDENTIALS.password) {
                    isAuthenticated = true;
                    ws.send(JSON.stringify({
                        type: 'auth_success',
                        message: '✅ Authenticated!'
                    }));
                    console.log('✅ Auth success');
                } else {
                    ws.send(JSON.stringify({
                        type: 'auth_error',
                        message: '❌ Invalid credentials'
                    }));
                    ws.close();
                }
                return;
            }

            if (!isAuthenticated) {
                ws.send(JSON.stringify({
                    type: 'error',
                    message: '❌ Not authenticated'
                }));
                ws.close();
                return;
            }

            // Handle join
            if (data.type === 'join') {
                clientRoom = data.roomCode;
                clientName = data.name || 'Partner';
                
                if (!rooms.has(clientRoom)) {
                    rooms.set(clientRoom, new Set());
                }
                rooms.get(clientRoom).add(ws);
                
                console.log(`👤 ${clientName} joined room ${clientRoom} (${rooms.get(clientRoom).size} users)`);
                
                ws.send(JSON.stringify({
                    type: 'joined',
                    roomCode: clientRoom,
                    users: rooms.get(clientRoom).size,
                    message: `💕 Welcome to room ${clientRoom}`
                }));

                // Notify others
                rooms.get(clientRoom).forEach(client => {
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'system',
                            message: `💕 ${clientName} joined the chat`
                        }));
                    }
                });
                return;
            }

            // Handle message
            if (data.type === 'message') {
                if (!clientRoom || !rooms.has(clientRoom)) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Not in a room'
                    }));
                    return;
                }

                console.log(`💬 Message from ${clientName}: "${data.text}"`);
                
                // Save to database
                try {
                    await db.saveMessage(clientRoom, clientName, data.text, data.time);
                } catch (err) {
                    console.error('DB save error:', err);
                }

                // Broadcast to EVERYONE in the room
                const messageData = {
                    type: 'message',
                    text: data.text,
                    sender: clientName,
                    time: data.time || new Date().toLocaleTimeString()
                };

                rooms.get(clientRoom).forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify(messageData));
                        console.log(`📤 Sent to client`);
                    }
                });
                return;
            }

            // Handle leave
            if (data.type === 'leave') {
                if (clientRoom && rooms.has(clientRoom)) {
                    rooms.get(clientRoom).delete(ws);
                    if (rooms.get(clientRoom).size === 0) {
                        rooms.delete(clientRoom);
                    }
                }
                ws.close();
            }

        } catch (error) {
            console.error('❌ Error:', error);
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Server error'
            }));
        }
    });

    ws.on('close', () => {
        if (clientRoom && rooms.has(clientRoom)) {
            rooms.get(clientRoom).delete(ws);
            if (rooms.get(clientRoom).size === 0) {
                rooms.delete(clientRoom);
                console.log(`🗑️ Room ${clientRoom} deleted`);
            } else {
                rooms.get(clientRoom).forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'system',
                            message: `💕 ${clientName || 'Someone'} left the chat`
                        }));
                    }
                });
            }
        }
        console.log('🔌 Client disconnected');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`💕 Couple's Private Chat`);
    console.log(`🔑 Credentials: ${COUPLE_CREDENTIALS.username} / ${COUPLE_CREDENTIALS.password}`);
});
