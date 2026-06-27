# Private Chat Frontend

The client-side interface for the private chat application.

## Deployment on GitHub Pages

1. Create a new repository on GitHub
2. Upload these files to the repository
3. Go to Settings > Pages
4. Select "Deploy from branch" (main branch)
5. Click "Save"

Your frontend will be available at: `https://[username].github.io/[repo-name]`

## Connecting to Backend

1. Update the `DEFAULT_SERVER` variable in `index.html` to your Render backend URL:
   ```javascript
   const DEFAULT_SERVER = 'wss://your-backend.onrender.com';
