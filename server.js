const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const db = require('./database');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('uploads'));

// Ensure uploads directory exists
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

// File upload configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        const uniqueName = uuidv4() + path.extname(file.originalname);
        cb(null, uniqueName);
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/wav'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type'), false);
        }
    }
});

// Initialize database
db.initDatabase();
db.createTables();

// WebSocket connections
const clients = new Map(); // userId -> ws

wss.on('connection', (ws) => {
    let userId = null;

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'auth') {
                const token = data.token;
                try {
                    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
                    userId = decoded.userId;
                    const user = await db.getUserById(userId);
                    if (user) {
                        clients.set(userId, ws);
                        ws.send(JSON.stringify({
                            type: 'auth_success',
                            user: user
                        }));
                        console.log(`✅ User ${user.username} connected`);
                        
                        // Notify friends
                        broadcastToFriends(userId, {
                            type: 'user_status',
                            userId: userId,
                            status: 'online'
                        });
                    }
                } catch (error) {
                    ws.send(JSON.stringify({
                        type: 'auth_error',
                        message: 'Invalid token'
                    }));
                }
                return;
            }

            // Handle messages
            switch(data.type) {
                case 'private_message':
                    const savedMsg = await db.saveMessage(
                        userId,
                        data.receiverId,
                        null,
                        data.content,
                        data.fileUrl,
                        data.fileType,
                        data.messageType || 'text'
                    );
                    if (savedMsg) {
                        const messageData = {
                            type: 'private_message',
                            id: savedMsg.id,
                            senderId: userId,
                            receiverId: data.receiverId,
                            content: data.content,
                            fileUrl: data.fileUrl,
                            fileType: data.fileType,
                            messageType: data.messageType || 'text',
                            created_at: savedMsg.created_at
                        };
                        // Send to receiver if online
                        const receiverWs = clients.get(data.receiverId);
                        if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
                            receiverWs.send(JSON.stringify(messageData));
                        }
                        // Send back to sender
                        ws.send(JSON.stringify({
                            ...messageData,
                            delivered: true
                        }));
                    }
                    break;

                case 'group_message':
                    const savedGroupMsg = await db.saveMessage(
                        userId,
                        null,
                        data.groupId,
                        data.content,
                        data.fileUrl,
                        data.fileType,
                        data.messageType || 'text'
                    );
                    if (savedGroupMsg) {
                        const groupMessageData = {
                            type: 'group_message',
                            id: savedGroupMsg.id,
                            senderId: userId,
                            groupId: data.groupId,
                            content: data.content,
                            fileUrl: data.fileUrl,
                            fileType: data.fileType,
                            messageType: data.messageType || 'text',
                            created_at: savedGroupMsg.created_at
                        };
                        // Broadcast to all group members
                        broadcastToGroup(data.groupId, groupMessageData);
                    }
                    break;

                case 'typing':
                    const typingData = {
                        type: 'typing',
                        userId: userId,
                        receiverId: data.receiverId,
                        isTyping: data.isTyping
                    };
                    const targetWs = clients.get(data.receiverId);
                    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
                        targetWs.send(JSON.stringify(typingData));
                    }
                    break;

                case 'logout':
                    if (userId) {
                        clients.delete(userId);
                        broadcastToFriends(userId, {
                            type: 'user_status',
                            userId: userId,
                            status: 'offline'
                        });
                    }
                    break;
            }
        } catch (error) {
            console.error('❌ WebSocket error:', error);
        }
    });

    ws.on('close', () => {
        if (userId) {
            clients.delete(userId);
            broadcastToFriends(userId, {
                type: 'user_status',
                userId: userId,
                status: 'offline'
            });
            console.log(`User ${userId} disconnected`);
        }
    });
});

// Broadcast helper functions
function broadcastToFriends(userId, data) {
    // This would need to get friends list from DB
    // Simplified version - broadcast to all connected clients
    clients.forEach((client, id) => {
        if (id !== userId && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

function broadcastToGroup(groupId, data) {
    // This would need to get group members from DB
    // Simplified - broadcast to all clients
    clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

// REST API Routes

// Auth routes
app.post('/api/register', async (req, res) => {
    try {
        const { username, password, displayName } = req.body;
        
        const existingUser = await db.getUserByUsername(username);
        if (existingUser) {
            return res.status(400).json({ error: 'Username already exists' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const user = await db.createUser(username, hashedPassword, displayName);
        
        if (!user) {
            return res.status(500).json({ error: 'Failed to create user' });
        }

        // Create JWT token
        const token = jwt.sign(
            { userId: user.id, username: user.username },
            process.env.JWT_SECRET || 'secret',
            { expiresIn: '30d' }
        );

        // Save session
        await db.createSession(user.id, token);

        res.json({
            token,
            user: {
                id: user.id,
                username: user.username,
                displayName: user.display_name
            }
        });
    } catch (error) {
        console.error('❌ Register error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        const user = await db.getUserByUsername(username);
        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = jwt.sign(
            { userId: user.id, username: user.username },
            process.env.JWT_SECRET || 'secret',
            { expiresIn: '30d' }
        );

        await db.createSession(user.id, token);

        res.json({
            token,
            user: {
                id: user.id,
                username: user.username,
                displayName: user.display_name,
                avatar: user.avatar,
                status: user.status
            }
        });
    } catch (error) {
        console.error('❌ Login error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/validate-token', async (req, res) => {
    try {
        const { token } = req.body;
        if (!token) {
            return res.status(401).json({ error: 'No token provided' });
        }

        const session = await db.getSessionByToken(token);
        if (!session) {
            return res.status(401).json({ error: 'Invalid session' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
        const user = await db.getUserById(decoded.userId);
        
        if (!user) {
            return res.status(401).json({ error: 'User not found' });
        }

        res.json({
            valid: true,
            user: user
        });
    } catch (error) {
        console.error('❌ Validate token error:', error);
        res.status(401).json({ error: 'Invalid token' });
    }
});

app.post('/api/logout', async (req, res) => {
    try {
        const { token } = req.body;
        if (token) {
            await db.deleteSession(token);
        }
        res.json({ success: true });
    } catch (error) {
        console.error('❌ Logout error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// User routes
app.get('/api/users/search', async (req, res) => {
    try {
        const { q } = req.query;
        if (!q || q.length < 2) {
            return res.json({ users: [] });
        }
        const users = await db.searchUsers(q);
        res.json({ users });
    } catch (error) {
        console.error('❌ Search error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/users/:id', async (req, res) => {
    try {
        const user = await db.getUserById(req.params.id);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json({ user });
    } catch (error) {
        console.error('❌ Get user error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/users/:id/friends', async (req, res) => {
    try {
        const friends = await db.getFriends(req.params.id);
        res.json({ friends });
    } catch (error) {
        console.error('❌ Get friends error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/users/:id/friends', async (req, res) => {
    try {
        const { friendId } = req.body;
        await db.addFriend(req.params.id, friendId);
        res.json({ success: true });
    } catch (error) {
        console.error('❌ Add friend error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Group routes
app.post('/api/groups', async (req, res) => {
    try {
        const { name, description, userId } = req.body;
        const group = await db.createGroup(name, description, userId);
        if (!group) {
            return res.status(500).json({ error: 'Failed to create group' });
        }
        res.json({ group });
    } catch (error) {
        console.error('❌ Create group error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/groups/:groupId/members', async (req, res) => {
    try {
        const { userId } = req.body;
        await db.addGroupMember(req.params.groupId, userId);
        res.json({ success: true });
    } catch (error) {
        console.error('❌ Add group member error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/users/:userId/groups', async (req, res) => {
    try {
        const groups = await db.getUserGroups(req.params.userId);
        res.json({ groups });
    } catch (error) {
        console.error('❌ Get user groups error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Message routes
app.get('/api/messages/:userId/:otherId', async (req, res) => {
    try {
        const { userId, otherId } = req.params;
        const limit = parseInt(req.query.limit) || 50;
        const offset = parseInt(req.query.offset) || 0;
        const messages = await db.getMessages(userId, otherId, limit, offset);
        res.json({ messages });
    } catch (error) {
        console.error('❌ Get messages error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/groups/:groupId/messages', async (req, res) => {
    try {
        const { groupId } = req.params;
        const limit = parseInt(req.query.limit) || 50;
        const offset = parseInt(req.query.offset) || 0;
        const messages = await db.getGroupMessages(groupId, limit, offset);
        res.json({ messages });
    } catch (error) {
        console.error('❌ Get group messages error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// File upload route
app.post('/api/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        const fileUrl = `/uploads/${req.file.filename}`;
        const fileType = req.file.mimetype;
        res.json({
            fileUrl,
            fileType,
            filename: req.file.filename
        });
    } catch (error) {
        console.error('❌ Upload error:', error);
        res.status(500).json({ error: 'Upload failed' });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`💕 ChitChat Server Ready`);
    console.log(`📡 WebSocket server running`);
});
