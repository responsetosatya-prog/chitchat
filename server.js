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
    limits: { fileSize: 10 * 1024 * 1024 },
});

// Initialize database
db.initDatabase();
db.createTables();

// Store WebSocket connections
const clients = new Map(); // userId -> WebSocket
const onlineUsers = new Set();
const userNames = new Map(); // userId -> username

wss.on('connection', (ws) => {
    console.log('🔗 New WebSocket connection');
    let userId = null;

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            console.log('📨 Received:', data.type);

            // Handle authentication
            if (data.type === 'auth') {
                console.log('🔐 Auth attempt');
                
                if (!data.token) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'No token provided'
                    }));
                    return;
                }

                try {
                    const decoded = jwt.verify(data.token, process.env.JWT_SECRET || 'secret');
                    userId = decoded.userId;
                    
                    // Store connection
                    clients.set(userId, ws);
                    onlineUsers.add(userId);
                    userNames.set(userId, decoded.username || 'User');
                    
                    console.log(`✅ User ${decoded.username} (${userId}) authenticated`);
                    
                    // Send auth success with online users list
                    ws.send(JSON.stringify({
                        type: 'auth_success',
                        user: { id: userId, username: decoded.username },
                        onlineUsers: Array.from(onlineUsers)
                    }));
                    
                    // Broadcast online status to ALL clients
                    broadcastToAll({
                        type: 'user_status',
                        userId: userId,
                        username: decoded.username,
                        status: 'online',
                        onlineUsers: Array.from(onlineUsers)
                    });
                    
                } catch (error) {
                    console.error('❌ Auth error:', error.message);
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Invalid token'
                    }));
                    ws.close();
                }
                return;
            }

            // All other messages require authentication
            if (!userId || !clients.has(userId)) {
                ws.send(JSON.stringify({
                    type: 'error',
                    message: 'Not authenticated'
                }));
                return;
            }

            // Handle different message types
            switch(data.type) {
                case 'private_message':
                    console.log(`💬 Private message from ${userId} to ${data.receiverId}: "${data.content}"`);
                    
                    // Save to database
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
                        const senderName = userNames.get(userId) || 'User';
                        const messageData = {
                            type: 'private_message',
                            id: savedMsg.id,
                            senderId: userId,
                            senderName: senderName,
                            receiverId: data.receiverId,
                            content: data.content,
                            fileUrl: data.fileUrl || null,
                            fileType: data.fileType || null,
                            messageType: data.messageType || 'text',
                            created_at: savedMsg.created_at
                        };
                        
                        // Send to sender (delivery confirmation)
                        ws.send(JSON.stringify({
                            ...messageData,
                            delivered: true
                        }));
                        
                        // Send to receiver if online
                        const receiverWs = clients.get(data.receiverId);
                        if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
                            receiverWs.send(JSON.stringify(messageData));
                            console.log(`✅ Message sent to ${data.receiverId}`);
                        } else {
                            console.log(`⚠️ Receiver ${data.receiverId} is offline`);
                        }
                    }
                    break;

                case 'group_message':
                    console.log(`💬 Group message from ${userId} to group ${data.groupId}: "${data.content}"`);
                    
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
                        const senderName = userNames.get(userId) || 'User';
                        const groupMessageData = {
                            type: 'group_message',
                            id: savedGroupMsg.id,
                            senderId: userId,
                            senderName: senderName,
                            groupId: data.groupId,
                            content: data.content,
                            fileUrl: data.fileUrl || null,
                            fileType: data.fileType || null,
                            messageType: data.messageType || 'text',
                            created_at: savedGroupMsg.created_at
                        };
                        
                        // Broadcast to ALL connected clients
                        broadcastToAll(groupMessageData);
                        console.log(`✅ Group message broadcast to all clients`);
                    }
                    break;

                case 'typing':
                    const receiverWs = clients.get(data.receiverId);
                    if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
                        receiverWs.send(JSON.stringify({
                            type: 'typing',
                            userId: userId,
                            username: userNames.get(userId) || 'User',
                            isTyping: data.isTyping
                        }));
                    }
                    break;

                case 'logout':
                    console.log(`👋 User ${userId} logged out`);
                    onlineUsers.delete(userId);
                    clients.delete(userId);
                    broadcastToAll({
                        type: 'user_status',
                        userId: userId,
                        username: userNames.get(userId) || 'User',
                        status: 'offline',
                        onlineUsers: Array.from(onlineUsers)
                    });
                    break;

                default:
                    console.log('⚠️ Unknown message type:', data.type);
            }
        } catch (error) {
            console.error('❌ WebSocket error:', error);
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Server error'
            }));
        }
    });

    ws.on('close', () => {
        if (userId) {
            onlineUsers.delete(userId);
            clients.delete(userId);
            broadcastToAll({
                type: 'user_status',
                userId: userId,
                username: userNames.get(userId) || 'User',
                status: 'offline',
                onlineUsers: Array.from(onlineUsers)
            });
            console.log(`🔌 User ${userId} disconnected`);
        }
    });
});

// Broadcast to all connected clients
function broadcastToAll(data) {
    const message = JSON.stringify(data);
    clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
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
        const usersWithStatus = users.map(u => ({
            ...u,
            online: onlineUsers.has(u.id)
        }));
        res.json({ users: usersWithStatus });
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
        res.json({ 
            user: {
                ...user,
                online: onlineUsers.has(user.id)
            }
        });
    } catch (error) {
        console.error('❌ Get user error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/users/:id/friends', async (req, res) => {
    try {
        const friends = await db.getFriends(req.params.id);
        const friendsWithStatus = friends.map(f => ({
            ...f,
            online: onlineUsers.has(f.id)
        }));
        res.json({ friends: friendsWithStatus });
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

// Get online users
app.get('/api/online-users', (req, res) => {
    res.json({ 
        onlineUsers: Array.from(onlineUsers),
        count: onlineUsers.size
    });
});

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'online',
        onlineUsers: onlineUsers.size,
        connections: clients.size,
        timestamp: new Date().toISOString()
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`💕 ChitChat Server Ready`);
    console.log(`📡 WebSocket server running`);
});
