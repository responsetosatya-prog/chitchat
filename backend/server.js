const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Store rooms and their clients
const rooms = new Map();

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'online', 
        rooms: rooms.size,
        timestamp: new Date().toISOString()
    });
});

// Get active rooms
app.get('/rooms', (req, res) => {
    const roomList = Array.from(rooms.keys()).map(code => ({
        code,
        users: rooms.get(code).size
    }));
    res.json({ rooms: roomList });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
    console.log('New client connected');
    let clientRoom = null;
    let clientName = null;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            switch(data.type) {
                case 'join':
                    const roomCode = data.roomCode;
                    clientName = data.name || 'Anonymous';
                    
                    if (!rooms.has(roomCode)) {
                        rooms.set(roomCode, new Set());
                    }
                    
                    rooms.get(roomCode).add(ws);
                    clientRoom = roomCode;
                    
                    ws.send(JSON.stringify({
                        type: 'joined',
                        roomCode: roomCode,
                        message: `You joined room ${roomCode}`,
                        users: rooms.get(roomCode).size
                    }));
                    
                    broadcastToRoom(roomCode, {
                        type: 'system',
                        message: `${clientName} joined the chat! (${rooms.get(roomCode).size} users)`,
                        sender: 'system'
                    }, ws);
                    
                    console.log(`${clientName} joined room: ${roomCode} (${rooms.get(roomCode).size} users)`);
                    break;
                    
                case 'message':
                    if (clientRoom && rooms.has(clientRoom)) {
                        broadcastToRoom(clientRoom, {
                            type: 'message',
                            text: data.text,
                            sender: clientName,
                            time: data.time || new Date().toLocaleTimeString()
                        }, ws);
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
            console.log(`Room ${roomCode} closed (empty)`);
        } else {
            broadcastToRoom(roomCode, {
                type: 'system',
                message: `${name || 'Someone'} left the chat (${remainingUsers} users remaining)`,
                sender: 'system'
            });
            console.log(`${name} left room ${roomCode} (${remainingUsers} users remaining)`);
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📡 WebSocket ready: ws://localhost:${PORT}`);
});
