# 💕 Private Chat for Two

A completely private chat application just for you and your girlfriend. No one else can access it!

## Features
- 🔐 Password protected - only you two can access
- 💕 Romantic themed design
- 📱 Works on any device (phone, tablet, computer)
- ⏰ Messages auto-delete after 24 hours
- 💾 Messages are saved in database
- 🔒 Secure WebSocket connection

## Tech Stack
- Frontend: HTML, CSS, JavaScript
- Backend: Node.js, Express, WebSocket
- Database: PostgreSQL
- Hosting: Render (backend) + GitHub Pages (frontend)

## Setup Instructions

### For You (Creator)
1. Fork this repository
2. Deploy backend on Render (see backend/README.md)
3. Deploy frontend on GitHub Pages (see frontend/README.md)
4. Share the link with your girlfriend

### For Your Girlfriend
1. Open the GitHub Pages link
2. Enter the username and password (you'll share these)
3. Start chatting! 💕

## Security
- Password protected
- Only authenticated users can send/receive messages
- Each session requires valid credentials
- Messages are encrypted during transmission (WSS)

## License
Private - For personal use only
