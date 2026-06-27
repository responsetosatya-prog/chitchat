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

// Store WebSocket connections
const clients = new Map(); // userId -> { ws, userId, username }

// Online users tracking
const onlineUsers = new Set();

wss.on('connection', (ws) => {
    console.log('🔗 New WebSocket connection');
    let userId = null;
    let username = null;

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            console.log('📨 Received:', data.type);

            if (data.type === 'auth') {
                const token = data.token;
                try {
                    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
                    userId = decoded.userId;
                    username = decoded.username;
                    
                    // Store connection
                    clients.set(userId, { ws, userId, username });
                    onlineUsers.add(userId);
                    
                    console.log(`✅ User ${username} (${userId}) connected`);
                    
                    // Send auth success
                    ws.send(JSON.stringify({
                        type: 'auth_success',
                        user: { id: userId, username }
                    }));
                    
                    // Broadcast online status to ALL connected clients
                    broadcastUserStatus(userId, username, 'online');
                    
                } catch (error) {
                    console.error('❌ Auth error:', error);
                    ws.send(JSON.stringify({
                        type: 'auth_error',
                        message: 'Invalid token'
                    }));
                    ws.close();
                }
                return;
            }

            // Handle other messages (only if authenticated)
            if (!userId || !clients.has(userId)) {
                ws.send(JSON.stringify({
                    type: 'error',
                    message: 'Not authenticated'
                }));
                return;
            }

            switch(data.type) {
                case 'private_message':
                    console.log(`💬 Private message from ${username} to ${data.receiverId}`);
                    
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
                            senderName: username,
                            receiverId: data.receiverId,
                            content: data.content,
                            fileUrl: data.fileUrl,
                            fileType: data.fileType,
                            messageType: data.messageType || 'text',
                            created_at: savedMsg.created_at
                        };
                        
                        // Send to receiver if online
                        const receiver = clients.get(data.receiverId);
                        if (receiver && receiver.ws.readyState === WebSocket.OPEN) {
                            receiver.ws.send(JSON.stringify(messageData));
                            console.log(`✅ Message sent to ${data.receiverId}`);
                        } else {
                            console.log(`⚠️ Receiver ${data.receiverId} is offline`);
                        }
                        
                        // Send back to sender (delivery confirmation)
                        ws.send(JSON.stringify({
                            ...messageData,
                            delivered: true
                        }));
                    }
                    break;

                case 'group_message':
                    console.log(`💬 Group message from ${username} to group ${data.groupId}`);
                    
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
                            senderName: username,
                            groupId: data.groupId,
                            content: data.content,
                            fileUrl: data.fileUrl,
                            fileType: data.fileType,
                            messageType: data.messageType || 'text',
                            created_at: savedGroupMsg.created_at
                        };
                        
                        // Broadcast to all group members (simplified - broadcast to all clients)
                        clients.forEach((client) => {
                            if (client.ws.readyState === WebSocket.OPEN) {
                                client.ws.send(JSON.stringify(groupMessageData));
                            }
                        });
                        console.log(`✅ Group message broadcast to all clients`);
                    }
                    break;

                case 'typing':
                    const receiverClient = clients.get(data.receiverId);
                    if (receiverClient && receiverClient.ws.readyState === WebSocket.OPEN) {
                        receiverClient.ws.send(JSON.stringify({
                            type: 'typing',
                            userId: userId,
                            username: username,
                            receiverId: data.receiverId,
                            isTyping: data.isTyping
                        }));
                    }
                    break;

                case 'logout':
                    if (userId) {
                        onlineUsers.delete(userId);
                        clients.delete(userId);
                        broadcastUserStatus(userId, username, 'offline');
                        console.log(`👋 User ${username} logged out`);
                    }
                    break;
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
            broadcastUserStatus(userId, username, 'offline');
            console.log(`🔌 User ${username || userId} disconnected`);
        }
    });
});

// Broadcast user status to all connected clients
function broadcastUserStatus(userId, username, status) {
    const statusData = {
        type: 'user_status',
        userId: userId,
        username: username || userId,
        status: status,
        onlineUsers: Array.from(onlineUsers)
    };
    
    console.log(`📡 Broadcasting ${status} status for ${username || userId}`);
    
    clients.forEach((client) => {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify(statusData));
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
        // Add online status
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
        // Add online status
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`💕 ChitChat Server Ready`);
    console.log(`📡 WebSocket server running`);
    console.log(`👥 Online users: ${onlineUsers.size}`);
});
