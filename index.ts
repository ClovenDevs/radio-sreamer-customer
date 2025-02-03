// index.ts
import express from 'express';
import path from 'path';
import multer from 'multer';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { YouTubeStreamer } from './lib/YouTubeStreamer';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });
const port = process.env.PORT || 3000;

// Helper function to normalize paths for both Windows and Linux
const normalizePath = (pathToNormalize: string): string => {
  const normalized = path.normalize(pathToNormalize).replace(/\\/g, '/');
  return process.env.DOCKER_CONTAINER ? normalized.split(':').pop()! : normalized;
};

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'assets');
  },
  filename: (req, file, cb) => {
    cb(null, 'thumbnail' + path.extname(file.originalname));
  }
});
const upload = multer({ storage });
console.log('process.env.DOCKER_CONTAINER', process.env.DOCKER_CONTAINER);
// Setup express middleware
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Initialize streamer with default settings
let streamer: YouTubeStreamer | null = null;
let settings = {
  streamKey: process.env.YT_STREAM_KEY || '',
  audioUrl: 'https://prod-3-84-19-111.amperwave.net/audacy-wqalfmaac-imc',
  videoSize: '1280x720',
  thumbnailPath: normalizePath(path.join(__dirname, 'assets', 'thumbnail.png'))
};

// WebSocket connection handling
wss.on('connection', (ws: WebSocket) => {
  console.log('New WebSocket connection');

  // Send initial status
  ws.send(JSON.stringify({
    type: 'status',
    data: {
      isStreaming: streamer?.isStreaming || false,
      settings
    }
  }));

  // Handle incoming messages
  ws.on('message', async (message: string) => {
    try {
      const data = JSON.parse(message.toString());
      
      switch (data.type) {
        case 'start':
          if (!streamer) {
            streamer = new YouTubeStreamer(settings);
            setupStreamerEvents(streamer);
          }
          break;

        case 'stop':
          if (streamer) {
            streamer.stopStream();
            streamer = null;
          }
          break;

        case 'updateSettings':
          const wasStreaming = streamer?.isStreaming || false;
          settings = { ...settings, ...data.settings };
          
          if (streamer) {
            streamer.stopStream();
            streamer = null;
          }

          // Only restart if it was streaming before
          if (wasStreaming) {
            streamer = new YouTubeStreamer(settings);
            setupStreamerEvents(streamer);
          }

          broadcastToAll({
            type: 'settings',
            data: settings
          });
          break;
      }
    } catch (error) {
      console.error('WebSocket message error:', error);
    }
  });
});

// Broadcast to all connected clients
function broadcastToAll(message: any) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

// Setup streamer event handlers
function setupStreamerEvents(streamer: YouTubeStreamer) {
  streamer.on('status', (status) => {
    broadcastToAll({
      type: 'status',
      data: status
    });
  });

  streamer.on('progress', (progress) => {
    broadcastToAll({
      type: 'progress',
      data: progress
    });
  });

  streamer.on('log', (log) => {
    broadcastToAll({
      type: 'log',
      data: log
    });
  });

  streamer.on('error', (error) => {
    broadcastToAll({
      type: 'error',
      data: error
    });
  });
}

// Routes
app.get('/', (req, res) => {
  res.render('index', {
    isStreaming: streamer?.isStreaming || false,
    settings
  });
});

// File upload endpoint
app.post('/settings/upload', upload.single('thumbnail'), (req, res) => {
  if (req.file) {
    settings.thumbnailPath = normalizePath(path.join(__dirname, 'assets', req.file.filename));
    broadcastToAll({
      type: 'settings',
      data: settings
    });
    res.json({ success: true, path: settings.thumbnailPath });
  } else {
    res.status(400).json({ success: false, error: 'No file uploaded' });
  }
});

// Serve thumbnail image
app.get('/thumbnail', (req, res) => {
  if (settings.thumbnailPath && require('fs').existsSync(settings.thumbnailPath)) {
    res.sendFile(settings.thumbnailPath);
  } else {
    res.status(404).send('Thumbnail not found');
  }
});

// Start server
server.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});

// Handle process termination
process.on('SIGINT', () => {
  console.log('Stopping stream...');
  if (streamer) {
    streamer.stopStream();
  }
  process.exit(0);
});
