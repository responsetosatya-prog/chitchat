# 💕 Backend - Private Chat

## Deployment on Render

### Step 1: Create PostgreSQL Database on Render
1. Go to [Render.com](https://render.com)
2. Click "New +" → "PostgreSQL"
3. Name: `private-chat-db`
4. Create and copy the **Internal Database URL**

### Step 2: Deploy Backend
1. Push this code to GitHub
2. On Render, click "New +" → "Web Service"
3. Connect your GitHub repository
4. Configure:
   - Name: `private-chat-backend`
   - Environment: `Node`
   - Build Command: `npm install`
   - Start Command: `node server.js`
5. Add Environment Variables:
   - `DATABASE_URL`: (paste from Step 1)
   - `COUPLE_USERNAME`: your_username
   - `COUPLE_PASSWORD`: your_password
   - `PORT`: 3000
6. Click "Create Web Service"

### Step 3: Get Your Backend URL
After deployment, your URL will be:
